// pages/api/gamedata.js
// Per-game NFL data for TD prediction. For one matchup, pulls each team's
// skill-position players (RB/WR/TE) from the roster, excludes anyone
// currently Out/IR/PUP/Suspended (real injuries endpoint, not the roster
// group heuristic), their recent usage + TD production from the gamelog,
// and the opponent's scoring defense. All from ESPN's free endpoints.
// Called once per game by the frontend (POST).

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

// Statuses that mean "will not play." Questionable/Probable stay eligible —
// they play more often than not. Everything here is a near-certain scratch.
const OUT_LIKE = /\bout\b|injured reserve|\bir\b|\bpup\b|suspend|non-football|did not report|doubtful/i;

// Real injury designations live on a SEPARATE endpoint from the roster —
// site.api.espn.com's roster response does NOT reliably carry status, so the
// old approach (checking roster group names for "injured"/"suspended") was
// checking the wrong place and effectively never fired. This hits the actual
// injuries endpoint and resolves however many $ref entries it returns (core
// API list endpoints are usually ref-only), bounded and parallel so a slow
// resolve can't eat the whole time budget.
async function teamInjuredIds(teamId, msLeft) {
  const out = new Set();
  if (!teamId || msLeft() < 5000) return out;
  try {
    const r = await fetchT(`${CORE}/teams/${teamId}/injuries`, 6000);
    if (!r.ok) return out;
    const d = await r.json();
    const items = d.items || [];
    if (!items.length) return out;

    const resolveOne = async (item) => {
      try {
        let obj = item;
        if (item?.$ref && !item.status && !item.athlete) {
          const rr = await fetchT(item.$ref, 4000);
          if (!rr.ok) return;
          obj = await rr.json();
        }
        const statusText = (
          (typeof obj.status === "string" ? obj.status : null) ||
          obj.status?.type?.name || obj.status?.name ||
          obj.type?.name || obj.details?.type || ""
        );
        if (!statusText || !OUT_LIKE.test(statusText)) return;

        let athleteId = obj.athlete?.id || obj.athleteId || null;
        if (!athleteId && obj.athlete?.$ref) {
          const m = String(obj.athlete.$ref).match(/athletes\/(\d+)/);
          if (m) athleteId = m[1];
        }
        if (!athleteId && obj.$ref) {
          const m = String(obj.$ref).match(/athletes\/(\d+)/);
          if (m) athleteId = m[1];
        }
        if (athleteId) out.add(String(athleteId));
      } catch {}
    };

    // Bounded: a team's injury list is normally short (a handful of players),
    // but cap it defensively so a bloated response can't stall the request.
    await Promise.all(items.slice(0, 20).map(resolveOne));
  } catch {}
  return out;
}

// Pull a team's skill-position players from the roster endpoint.
async function teamSkillPlayers(teamId, msLeft) {
  if (!teamId || msLeft() < 6000) return [];
  try {
    const r = await fetchT(`${SITE}/teams/${teamId}/roster`, 7000);
    const d = await r.json();
    const out = [];
    for (const group of d.athletes || []) {
      for (const a of group.items || []) {
        const pos = a.position?.abbreviation || "";
        if (!SKILL.has(pos)) continue;
        const grp = (group.position || "").toLowerCase();
        if (grp.includes("injured") || grp.includes("suspended") || grp.includes("practice")) continue;
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

// Pull a player's TD/usage from the ESPN "overview" endpoint. CONFIRMED shape:
//   statistics.names[]  = flat index map: ["rushingAttempts",...,
//                          "rushingTouchdowns",...,"receivingTouchdowns",...]
//   statistics.splits[] = array of {displayName, stats:[...]} where each stats
//                          array aligns with names[]. Splits include "Regular
//                          Season", "Projected", and "Career".
// We read the Regular Season split (current form); if it's all zeros/empty
// (early in the year), fall back to Career as a role/usage baseline.
//
// Rate math: the Regular Season split is a season-to-date TOTAL, not a full
// season. Dividing by a fixed 17 early in the year drastically understates
// anyone who's had one big game so far (e.g. 2 TDs / 17 = 0.12, when the real
// current rate is 2.0/game). We look for a "gamesPlayed" stat in names[] and
// use that as the real denominator; if ESPN doesn't expose it in this split,
// we fall back to the fixed-17 estimate and flag it in stat_basis so this is
// visible/checkable rather than silently wrong.
async function playerRecent(athleteId, msLeft) {
  if (!athleteId || msLeft() < 5000) return null;
  const WEBB = "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl";
  try {
    const r = await fetchT(`${WEBB}/athletes/${athleteId}/overview`, 6000);
    if (!r.ok) return null;
    const d = await r.json();
    const stats = d.statistics || {};
    const names = stats.names || [];
    const splits = Array.isArray(stats.splits) ? stats.splits : [];
    if (!names.length || !splits.length) return null;

    const idx = (key) => names.findIndex(n => String(n).toLowerCase() === key.toLowerCase());
    const iRushTD = idx("rushingTouchdowns");
    const iRecTD  = idx("receivingTouchdowns");
    const iCar    = idx("rushingAttempts");
    const iRec    = idx("receptions");
    const iGP     = idx("gamesPlayed");

    const readSplit = (sp) => {
      const arr = sp?.stats || [];
      const num = (i) => (i>=0 && arr[i]!=null) ? (parseFloat(String(arr[i]).replace(/[^0-9.\-]/g,""))||0) : 0;
      return { rushTD:num(iRushTD), recTD:num(iRecTD), carries:num(iCar), rec:num(iRec), gp:num(iGP) };
    };

    const findSplit = (nameWants) => splits.find(s => nameWants.some(w => (s.displayName||"").toLowerCase().includes(w)));
    const regular = findSplit(["regular season"]) || splits[0];
    const career  = findSplit(["career"]);

    let src = "2026 regular season";
    let v = readSplit(regular);
    // If nothing has happened yet this season, use career as the baseline.
    if (!v.rushTD && !v.recTD && !v.carries && !v.rec && career) {
      v = readSplit(career);
      src = "career baseline";
    }
    if (!v.carries && !v.rec && !v.rushTD && !v.recTD) return null;

    const totalTD = v.rushTD + v.recTD;

    let gamesForRate, statBasis;
    if (src === "career baseline") {
      // Normalize career totals to a per-17-game-season rate, same as before.
      gamesForRate = Math.max(1, Math.round((v.carries + v.rec) / 20)) * 17;
      statBasis = "career, normalized to 17-game season";
    } else if (iGP >= 0 && v.gp > 0) {
      // Real games-played from ESPN — the accurate denominator.
      gamesForRate = v.gp;
      statBasis = "regular season / actual games played";
    } else {
      // ESPN didn't expose gamesPlayed in this split — fall back to the old
      // fixed-17 estimate. This will understate early-season hot starts;
      // flagged here so it's visible if this path is still firing later.
      gamesForRate = 17;
      statBasis = "regular season / 17-game estimate (gamesPlayed not found)";
    }

    return {
      stat_source: src,
      stat_basis: statBasis,
      total_tds: totalTD,
      carries: v.carries,
      receptions: v.rec,
      td_rate: +(totalTD / gamesForRate).toFixed(2),
      touches_pg: +((v.carries + v.rec) / gamesForRate).toFixed(1)
    };
  } catch { return null; }
}

// Opponent scoring defense: TDs and points allowed. Uses the season-scoped
// team statistics endpoint (correct category structure), with prior-season
// fallback in early weeks.
async function teamDefense(teamId, msLeft) {
  const o = {};
  if (!teamId || msLeft() < 5000) return o;
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

  let away_team_id = src("away_team_id"), home_team_id = src("home_team_id");
  let away_team = src("away_team"), home_team = src("home_team");
  // Browser-testable default (DEN@KC from the diagnostic): visit /api/gamedata
  // with no params to sanity-check the pipeline.
  if (!away_team_id && !home_team_id) {
    away_team_id = "7"; home_team_id = "12"; away_team = "DEN"; home_team = "KC";
  }

  try {
    const results = { players: { away: [], home: [] }, defense: {}, ok: true,
      debug: { away_team_id: away_team_id||null, home_team_id: home_team_id||null } };

    // Roster + injuries + defense all fire in parallel — independent calls.
    const [awayPlayersRaw, homePlayersRaw, awayInjured, homeInjured, awayDef, homeDef] = await Promise.all([
      teamSkillPlayers(away_team_id, msLeft),
      teamSkillPlayers(home_team_id, msLeft),
      teamInjuredIds(away_team_id, msLeft),
      teamInjuredIds(home_team_id, msLeft),
      teamDefense(away_team_id, msLeft),
      teamDefense(home_team_id, msLeft)
    ]);

    // Filter out anyone confirmed Out/IR/PUP/Suspended BEFORE picking the
    // top-8 depth-chart slice, so a healthy backup takes the roster spot
    // instead of the slot being wasted on someone who can't play.
    const awayPlayers = awayPlayersRaw.filter(p => !awayInjured.has(String(p.id)));
    const homePlayers = homePlayersRaw.filter(p => !homeInjured.has(String(p.id)));

    results.debug.rosterAway = awayPlayers.length;
    results.debug.rosterHome = homePlayers.length;
    results.debug.injuredExcludedAway = awayPlayersRaw.length - awayPlayers.length;
    results.debug.injuredExcludedHome = homePlayersRaw.length - homePlayers.length;
    results.debug.sampleNames = [...awayPlayers.slice(0,2), ...homePlayers.slice(0,2)].map(p => p.name);

    results.defense = { away: awayDef, home: homeDef };

    // Enrich each player with recent usage — but cap how many we hit per team
    // (top of depth chart matters; deep bench players rarely score) and respect
    // the time budget so a slow gamelog never kills the whole game.
    const enrich = async (players) => {
      const top = players.slice(0, 8); // ~RB1-2, WR1-3, TE1-2
      await Promise.all(top.map(async (p) => {
        try { const rec = await playerRecent(p.id, msLeft); if (rec) Object.assign(p, rec); } catch {}
      }));
      return top;
    };

    results.players.away = await enrich(awayPlayers);
    results.players.home = await enrich(homePlayers);
    results.debug.enrichedWithStats = [...results.players.away, ...results.players.home].filter(p => p.td_rate != null).length;

    return res.status(200).json(results);
  } catch (e) {
    return res.status(200).json({ error: e.message, players: { away: [], home: [] } });
  }
}
