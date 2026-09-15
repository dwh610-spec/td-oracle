// pages/api/schedule.js
// Current-week NFL slate from ESPN's free scoreboard endpoint (no key).
// Returns each game with teams, kickoff, venue, and the betting line/total
// (the game-script signal that has no baseball equivalent).

export const config = { maxDuration: 30 };

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

async function fetchT(url, ms = 9000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    // No params → ESPN returns the current week's games automatically.
    const r = await fetchT(SCOREBOARD);
    const data = await r.json();

    const week = data.week?.number ?? null;
    const seasonType = data.season?.type ?? null;
    const games = [];

    for (const ev of data.events || []) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;

      const competitors = comp.competitors || [];
      const home = competitors.find(c => c.homeAway === "home");
      const away = competitors.find(c => c.homeAway === "away");
      if (!home || !away) continue;

      // Odds: spread + over/under total when present (drives game-script logic).
      let spread = null, overUnder = null, favorite = null;
      const odds = comp.odds?.[0];
      if (odds) {
        overUnder = odds.overUnder ?? null;
        spread = odds.spread ?? null;
        // details like "KC -6.5" — favorite abbrev is the negative side.
        favorite = odds.details ? odds.details.split(" ")[0] : null;
      }

      const status = ev.status?.type?.state || comp.status?.type?.state || "pre"; // pre|in|post
      const stateName = ev.status?.type?.description || "";

      games.push({
        game_id: ev.id,
        event_id: ev.id,
        away_team: away.team?.abbreviation || "???",
        home_team: home.team?.abbreviation || "???",
        away_team_id: away.team?.id || null,
        home_team_id: home.team?.id || null,
        away_name: away.team?.displayName || "",
        home_name: home.team?.displayName || "",
        venue: comp.venue?.fullName || "",
        kickoff: ev.date || "",
        state: status,                 // pre / in / post
        status: stateName,
        spread,                        // e.g. -6.5 (home perspective when available)
        over_under: overUnder,         // game total
        favorite,                      // abbrev of favored team
        // Implied team totals from spread + total (best TD-opportunity proxy):
        // favorite total = total/2 + |spread|/2 ; underdog = total/2 - |spread|/2
        ...impliedTotals(overUnder, spread, favorite, home.team?.abbreviation, away.team?.abbreviation)
      });
    }

    // Only games not yet final are actionable.
    const upcoming = games.filter(g => g.state !== "post");

    return res.status(200).json({ week, seasonType, games: upcoming, allGames: games });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Compute each team's Vegas implied point total from the game total and spread.
// A team implied for 27+ points is a strong TD environment; under ~17 is weak.
function impliedTotals(total, spread, favAbbr, homeAbbr, awayAbbr) {
  const t = parseFloat(total), s = Math.abs(parseFloat(spread));
  if (isNaN(t) || isNaN(s) || !favAbbr) return { home_implied: null, away_implied: null };
  const favTotal = (t / 2) + (s / 2);
  const dogTotal = (t / 2) - (s / 2);
  const favIsHome = favAbbr === homeAbbr;
  return {
    home_implied: +(favIsHome ? favTotal : dogTotal).toFixed(1),
    away_implied: +(favIsHome ? dogTotal : favTotal).toFixed(1)
  };
}
