// pages/api/gamedata.js
// Per-game NFL data for TD prediction. For one matchup, pulls each team's
// skill-position players (RB/WR/TE) from the roster, excludes anyone
// currently Out/IR/PUP/Suspended, their recent usage + TD production, the
// opponent's scoring defense (with key defensive injuries), each team's
// run/pass offensive lean, and — when a kickoff date is supplied — outdoor
// game weather. All from free sources (ESPN + Open-Meteo).

export const config = { maxDuration: 60 };

const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";

async function fetchT(url, ms = 7000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

const SKILL = new Set(["RB", "WR", "TE", "FB"]);
const DEF_POS = new Set(["CB", "S", "SS", "FS", "LB", "MLB", "OLB", "ILB", "DE", "DT", "DL", "NT"]);
const OUT_LIKE = /\bout\b|injured reserve|\bir\b|\bpup\b|suspend|non-football|did not report|doubtful/i;

// ── Static stadium reference (lat/lon + roof type). ESPN's scoreboard venue
// field shape wasn't verified live, so weather uses this instead — stadiums
// essentially never move, so this doesn't go stale the way live data would.
// Retractable-roof stadiums are treated as domes (closed more often than not,
// and we have no free way to know game-day roof status) — weather is skipped
// for all of these, which just means no wind/rain signal, never a wrong one.
const STADIUMS = {
  ARI:{lat:33.5276,lon:-112.2626,dome:true}, ATL:{lat:33.7554,lon:-84.4008,dome:true},
  BAL:{lat:39.2780,lon:-76.6227,dome:false}, BUF:{lat:42.7738,lon:-78.7870,dome:false},
  CAR:{lat:35.2258,lon:-80.8528,dome:false}, CHI:{lat:41.8623,lon:-87.6167,dome:false},
  CIN:{lat:39.0954,lon:-84.5160,dome:false}, CLE:{lat:41.5061,lon:-81.6995,dome:false},
  DAL:{lat:32.7473,lon:-97.0945,dome:true},  DEN:{lat:39.7439,lon:-105.0201,dome:false},
  DET:{lat:42.3400,lon:-83.0456,dome:true},  GB:{lat:44.5013,lon:-88.0622,dome:false},
  HOU:{lat:29.6847,lon:-95.4107,dome:true},  IND:{lat:39.7601,lon:-86.1639,dome:true},
  JAX:{lat:30.3239,lon:-81.6373,dome:false}, KC:{lat:39.0489,lon:-94.4839,dome:false},
  LV:{lat:36.0909,lon:-115.1833,dome:true},  LAC:{lat:33.9535,lon:-118.3392,dome:true},
  LAR:{lat:33.9535,lon:-118.3392,dome:true}, MIA:{lat:25.9580,lon:-80.2389,dome:false},
  MIN:{lat:44.9738,lon:-93.2577,dome:true},  NE:{lat:42.0909,lon:-71.2643,dome:false},
  NO:{lat:29.9511,lon:-90.0812,dome:true},   NYG:{lat:40.8135,lon:-74.0745,dome:false},
  NYJ:{lat:40.8135,lon:-74.0745,dome:false}, PHI:{lat:39.9008,lon:-75.1675,dome:false},
  PIT:{lat:40.4468,lon:-80.0158,dome:false}, SF:{lat:37.4032,lon:-121.9698,dome:false},
  SEA:{lat:47.5952,lon:-122.3316,dome:false},TB:{lat:27.9759,lon:-82.5033,dome:false},
  TEN:{lat:36.1665,lon:-86.7713,dome:false}, WSH:{lat:38.9077,lon:-76.8645,dome:false}
};

// Real injury designations live on a SEPARATE endpoint from the roster.
// Returns richer objects (not just ids) so callers can both (a) exclude an
// injured player from their own team's skill list and (b) surface injured
// DEFENSIVE players as context for the opposing offense.
async function teamInjuries(teamId, msLeft) {
  const out = [];
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
        let athleteName = obj.athlete?.displayName || obj.athlete?.fullName || null;
        let athletePos = obj.athlete?.position?.abbreviation || null;
        if ((!athleteId || !athleteName) && obj.athlete?.$ref) {
          try {
            const ar = await fetchT(obj.athlete.$ref, 4000);
            if (ar.ok) {
              const ad = await ar.json();
              athleteId = athleteId || ad.id;
              athleteName = athleteName || ad.displayName || ad.fullName;
              athletePos = athletePos || ad.position?.abbreviation;
            }
          } catch {}
        }
        if (!athleteId && obj.$ref) {
          const m = String(obj.$ref).match(/athletes\/(\d+)/);
          if (m) athleteId = m[1];
        }
        if (athleteId) out.push({ id: String(athleteId), name: athleteName || "?", pos: athletePos || "?", status: statusText });
      } catch {}
    };

    await Promise.all(items.slice(0, 20).map(resolveOne));
  } catch {}
  return out;
}

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
        out.push({ id: a.id, name: a.displayName || a.fullName || "?", pos, jersey: a.jersey || "" });
      }
    }
    return out;
  } catch { return []; }
}

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
    if (!v.rushTD && !v.recTD && !v.carries && !v.rec && career) {
      v = readSplit(career);
      src = "career baseline";
    }
    if (!v.carries && !v.rec && !v.rushTD && !v.recTD) return null;

    const totalTD = v.rushTD + v.recTD;
    let gamesForRate, statBasis;
    if (src === "career baseline") {
      gamesForRate = Math.max(1, Math.round((v.carries + v.rec) / 20)) * 17;
      statBasis = "career, normalized to 17-game season";
    } else if (iGP >= 0 && v.gp > 0) {
      gamesForRate = v.gp;
      statBasis = "regular season / actual games played";
    } else {
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

// Team profile: scoring defense (for the opposing offense's matchup read)
// PLUS this team's own run/pass offensive lean (for the funnel read).
async function teamProfile(teamId, msLeft) {
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
        const catName = (c.name || "").toLowerCase();
        for (const s of c.stats || []) {
          const nm = (s.name || "").toLowerCase();
          const val = parseFloat(s.value) || 0;
          if (nm === "totalpointsagainst" || nm === "pointsagainst") found.pts_allowed = Math.round(val);
          if (nm === "passingtouchdowns" && catName.includes("passing")) found.pass_td_allowed = Math.round(val);
          if (nm === "rushingtouchdowns" && catName.includes("rushing")) found.rush_td_allowed = Math.round(val);
          // Offensive identity — same categories, this team's own attempts.
          if (nm === "rushingattempts" && catName.includes("rushing")) found.rush_attempts = Math.round(val);
          if ((nm === "passingattempts" || nm === "attempts") && catName.includes("passing")) found.pass_attempts = Math.round(val);
        }
      }
      return Object.keys(found).length ? found : null;
    } catch { return null; }
  };
  let d = await tryYear(year);
  if (!d && msLeft() > 5000) d = await tryYear(year - 1);
  if (!d) return o;
  if (d.rush_attempts != null && d.pass_attempts != null && (d.rush_attempts + d.pass_attempts) > 0) {
    d.rush_pct = Math.round((d.rush_attempts / (d.rush_attempts + d.pass_attempts)) * 100);
  }
  return d;
}

// Weather — only when a kickoff date is supplied AND the stadium is outdoor.
// Free, no key, via Open-Meteo.
async function fetchWeather(homeTeamAbbr, kickoffDate, msLeft) {
  const stadium = STADIUMS[homeTeamAbbr];
  if (!stadium || stadium.dome || !kickoffDate || msLeft() < 5000) return null;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${stadium.lat}&longitude=${stadium.lon}&hourly=temperature_2m,precipitation_probability,windspeed_10m&start_date=${kickoffDate}&end_date=${kickoffDate}&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=auto`;
    const r = await fetchT(url, 6000);
    if (!r.ok) return null;
    const d = await r.json();
    const h = d.hourly;
    if (!h?.windspeed_10m?.length) return null;
    return {
      temp_f: Math.round(h.temperature_2m.reduce((a,b)=>a+b,0) / h.temperature_2m.length),
      wind_mph: Math.round(Math.max(...h.windspeed_10m)),
      precip_pct: Math.round(Math.max(...(h.precipitation_probability || [0])))
    };
  } catch { return null; }
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
  // Optional — pass a "YYYY-MM-DD" kickoff date to enable weather. Without
  // it, weather is simply skipped (not guessed).
  const kickoff_date = src("kickoff_date") || null;

  if (!away_team_id && !home_team_id) {
    away_team_id = "7"; home_team_id = "12"; away_team = "DEN"; home_team = "KC";
  }

  try {
    const results = { players: { away: [], home: [] }, defense: {}, weather: null, ok: true,
      debug: { away_team_id: away_team_id||null, home_team_id: home_team_id||null } };

    const [awayPlayersRaw, homePlayersRaw, awayInj, homeInj, awayProf, homeProf, weather] = await Promise.all([
      teamSkillPlayers(away_team_id, msLeft),
      teamSkillPlayers(home_team_id, msLeft),
      teamInjuries(away_team_id, msLeft),
      teamInjuries(home_team_id, msLeft),
      teamProfile(away_team_id, msLeft),
      teamProfile(home_team_id, msLeft),
      fetchWeather(home_team, kickoff_date, msLeft)
    ]);

    const awayInjOwnIds = new Set(awayInj.filter(p => SKILL.has(p.pos)).map(p => p.id));
    const homeInjOwnIds = new Set(homeInj.filter(p => SKILL.has(p.pos)).map(p => p.id));
    const awayPlayers = awayPlayersRaw.filter(p => !awayInjOwnIds.has(String(p.id)));
    const homePlayers = homePlayersRaw.filter(p => !homeInjOwnIds.has(String(p.id)));

    // Defensive-position injuries, for the OPPOSING offense's context.
    const awayDefInjuries = awayInj.filter(p => DEF_POS.has(p.pos)).map(p => `${p.name}(${p.pos})`);
    const homeDefInjuries = homeInj.filter(p => DEF_POS.has(p.pos)).map(p => `${p.name}(${p.pos})`);

    results.debug.rosterAway = awayPlayers.length;
    results.debug.rosterHome = homePlayers.length;
    results.debug.injuredExcludedAway = awayPlayersRaw.length - awayPlayers.length;
    results.debug.injuredExcludedHome = homePlayersRaw.length - homePlayers.length;
    results.debug.sampleNames = [...awayPlayers.slice(0,2), ...homePlayers.slice(0,2)].map(p => p.name);
    results.debug.weatherRequested = !!kickoff_date;
    results.debug.weatherReturned = !!weather;

    results.defense = {
      away: { ...awayProf, def_injuries: awayDefInjuries },
      home: { ...homeProf, def_injuries: homeDefInjuries }
    };
    results.weather = weather;

    const enrich = async (players) => {
      const top = players.slice(0, 8);
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
