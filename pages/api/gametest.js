// pages/api/gamedata.js
// Per-game NFL data for TD prediction. For one matchup, pulls each team's
// skill-position players (RB/WR/TE) from the roster, their recent usage + TD
// production from the gamelog, and the opponent's scoring defense. All from
// ESPN's free endpoints. Called once per game by the frontend (POST).

export const config = { maxDuration: 60 };

const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const WEB = "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl";
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";

// Time budget: degrade gracefully instead of dying (lesson from HR Oracle).
async function fetchT(url, ms = 7000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

// Skill positions that score the vast majority of non-QB TDs.
const SKILL = new Set(["RB", "WR", "TE", "FB"]);

// Pull a team's skill-position players from the roster endpoint.
async function teamSkillPlayers(teamId, msLeft) {
  if (!teamId || msLeft() < 6000) return [];
  try {
    const r = await fetchT(`${SITE}/teams/${teamId}/roster`, 7000);
    const d = await r.json();
    const out = [];
    for (const group of d.athletes || []) {
      // roster groups are keyed by position category (offense/defense/...).
      for (const a of group.items || []) {
        const pos = a.position?.abbreviation || "";
        if (!SKILL.has(pos)) continue;
        if (a.status && a.status.type && a.status.type !== "active") continue;
        out.push({
          id: a.id,
          name: a.displayName || a.fullName || "?",
          pos,
          jersey: a.jersey || ""
        });
      }
    }
    return out;
  } catch { return []; }
}

// Pull a player's season TD/usage totals. Uses the season-scoped statistics
// endpoint; in early weeks the current season is empty, so we fall back to the
// PRIOR season as the usage baseline. Returns per-game rates.
async function playerRecent(athleteId, msLeft) {
  if (!athleteId || msLeft() < 5000) return null;
  const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
  const year = new Date().getFullYear();
  const tryYear = async (yr) => {
    try {
      const r = await fetchT(`${CORE}/seasons/${yr}/types/2/athletes/${athleteId}/statistics`, 6000);
      if (!r.ok) return null;
      const d = await r.json();
      const cats = d.splits?.categories || [];
      const grab = (catName, statName) => {
        const cat = cats.find(c => (c.name||"").toLowerCase() === catName);
        const st = (cat?.stats || []).find(s => (s.name||"").toLowerCase() === statName.toLowerCase());
        return st ? parseFloat(st.value) || 0 : 0;
      };
      const gp = grab("general", "gamesPlayed") || grab("scoring", "gamesPlayed") || 0;
      const rushTD = grab("rushing", "rushingTouchdowns");
      const recTD  = grab("receiving", "receivingTouchdowns");
      const carries = grab("rushing", "rushingAttempts");
      const rec = grab("receiving", "receptions");
      const targets = grab("receiving", "receivingTargets");
      const totalTD = rushTD + recTD;
      if (!gp && !totalTD) return null;
      const g = gp || 1;
      return {
        stat_year: yr,
        recent_games: gp,
        recent_tds: totalTD,
        td_rate: +(totalTD / g).toFixed(2),
        touches_pg: +((carries + rec) / g).toFixed(1),
        targets_pg: +(targets / g).toFixed(1)
      };
    } catch { return null; }
  };
  // Current season first; if empty (early weeks), fall back to prior season.
  let out = await tryYear(year);
  if ((!out || !out.recent_games) && msLeft() > 5000) out = await tryYear(year - 1);
  return out;
}

// Opponent scoring defense: TDs and points allowed. Uses the season-scoped
// team statistics endpoint (correct category structure), with prior-season
// fallback in early weeks.
async function teamDefense(teamId, msLeft) {
  const o = {};
  if (!teamId || msLeft() < 5000) return o;
  const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
  const year = new Date().getFullYear();
  const tryYear = async (yr) => {
    try {
      const r = await fetchT(`${CORE}/seasons/${yr}/types/2/teams/${teamId}/statistics`, 6000);
      if (!r.ok) return null;
      const d = await r.json();
      const cats = d.splits?.categories || [];
      const found = {};
      for (const c of cats) {
        for (const s of c.stats || []) {
          const nm = (s.name || "").toLowerCase();
          if (nm === "totalpointsagainst" || nm === "pointsagainst") found.pts_allowed = Math.round(parseFloat(s.value)||0);
          if (nm === "passingtouchdowns" && (c.name||"").toLowerCase().includes("passing")) found.pass_td_allowed = Math.round(parseFloat(s.value)||0);
          if (nm === "rushingtouchdowns" && (c.name||"").toLowerCase().includes("rushing")) found.rush_td_allowed = Math.round(parseFloat(s.value)||0);
        }
      }
      return Object.keys(found).length ? found : null;
    } catch { return null; }
  };
  let d = await tryYear(year);
  if (!d && msLeft() > 5000) d = await tryYear(year - 1);
  return d || o;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const t0 = Date.now();
  const msLeft = () => 55000 - (Date.now() - t0);

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const src = (k) => body[k] ?? req.query[k];

  const away_team_id = src("away_team_id"), home_team_id = src("home_team_id");
  const away_team = src("away_team"), home_team = src("home_team");

  try {
    const results = { players: { away: [], home: [] }, defense: {}, ok: true };

    // Rosters first (fast, and everything else hangs off them).
    const [awayPlayers, homePlayers] = await Promise.all([
      teamSkillPlayers(away_team_id, msLeft),
      teamSkillPlayers(home_team_id, msLeft)
    ]);

    // Opponent defense (away players face home defense and vice-versa).
    const [awayDef, homeDef] = await Promise.all([
      teamDefense(away_team_id, msLeft),
      teamDefense(home_team_id, msLeft)
    ]);
    results.defense = { away: awayDef, home: homeDef };

    // Enrich each player with recent usage — but cap how many we hit per team
    // (top of depth chart matters; deep bench players rarely score) and respect
    // the time budget so a slow gamelog never kills the whole game.
    const enrich = async (players) => {
      const top = players.slice(0, 8); // ~RB1-2, WR1-3, TE1-2
      await Promise.all(top.map(async (p) => {
        const rec = await playerRecent(p.id, msLeft);
        if (rec) Object.assign(p, rec);
      }));
      // Keep only players with some recent usage OR a clear role (top of list).
      return top;
    };

    results.players.away = await enrich(awayPlayers);
    results.players.home = await enrich(homePlayers);

    return res.status(200).json(results);
  } catch (e) {
    return res.status(200).json({ error: e.message, players: { away: [], home: [] } });
  }
}
