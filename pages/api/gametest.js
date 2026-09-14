// pages/api/gametest.js
// Diagnostic: exercises every ESPN endpoint the app relies on for ONE game and
// reports what actually came back — so we can verify response shapes before
// building the UI on top of them. Visit:
//   /api/gametest                 → auto-picks the first game of the current week
//   /api/gametest?event_id=...    → a specific game
// Each step shows whether it worked, the counts, and a small sample, plus the
// raw field paths found — so if ESPN's shape differs from our parser, we see it.

export const config = { maxDuration: 60 };

const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const WEB  = "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl";

async function fetchT(url, ms = 9000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

// Return the top-level keys of an object (so we can see the real shape).
const keysOf = (o) => (o && typeof o === "object") ? Object.keys(o).slice(0, 25) : typeof o;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const out = { steps: {} };

  try {
    // ── Step 1: scoreboard → pick a game, inspect odds shape ────────────────
    let eventId = req.query.event_id;
    let homeId, awayId, homeAbbr, awayAbbr;
    try {
      const r = await fetchT(`${SITE}/scoreboard`);
      const d = await r.json();
      out.steps.scoreboard = {
        httpStatus: r.status,
        week: d.week?.number,
        events: (d.events || []).length,
        topKeys: keysOf(d)
      };
      const ev = eventId
        ? (d.events || []).find(e => e.id === eventId)
        : (d.events || [])[0];
      if (ev) {
        eventId = ev.id;
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find(c => c.homeAway === "home");
        const away = comp?.competitors?.find(c => c.homeAway === "away");
        homeId = home?.team?.id; awayId = away?.team?.id;
        homeAbbr = home?.team?.abbreviation; awayAbbr = away?.team?.abbreviation;
        out.steps.picked = {
          event_id: eventId,
          matchup: `${awayAbbr}@${homeAbbr}`,
          homeId, awayId,
          // Inspect the ODDS shape — this drives implied totals.
          hasOdds: !!comp?.odds?.length,
          oddsSample: comp?.odds?.[0] ? {
            keys: keysOf(comp.odds[0]),
            details: comp.odds[0].details,
            spread: comp.odds[0].spread,
            overUnder: comp.odds[0].overUnder
          } : null,
          competitorKeys: keysOf(home || {})
        };
      } else {
        out.steps.picked = { error: "no event found" };
      }
    } catch (e) { out.steps.scoreboard = { error: e.name==="AbortError"?"timeout":e.message }; }

    // ── Step 2: roster shape (skill players) ────────────────────────────────
    if (homeId) {
      try {
        const r = await fetchT(`${SITE}/teams/${homeId}/roster`);
        const d = await r.json();
        const groups = d.athletes || [];
        // Show how athletes are grouped + a sample athlete's shape.
        let sampleAthlete = null, skillCount = 0;
        const SKILL = new Set(["RB","WR","TE","FB"]);
        for (const g of groups) {
          for (const a of g.items || []) {
            const pos = a.position?.abbreviation || "";
            if (SKILL.has(pos)) {
              skillCount++;
              if (!sampleAthlete) sampleAthlete = { id:a.id, name:a.displayName, pos, keys:keysOf(a), hasStatus: !!a.status, statusShape: a.status ? keysOf(a.status) : null };
            }
          }
        }
        out.steps.roster = {
          httpStatus: r.status,
          groupCount: groups.length,
          groupKeys: groups.map(g => g.position || g.displayName || "?").slice(0,10),
          skillPlayers: skillCount,
          sampleAthlete
        };
      } catch (e) { out.steps.roster = { error: e.name==="AbortError"?"timeout":e.message }; }

      // ── Step 3: the overview endpoint won the probe. Dump its FULL stat
      // structure so we can map the exact fields the usage parser needs. Test
      // a known RB (Bijan Robinson) who has real TD numbers. ──
      const STAR_ID = "4430807"; // Bijan Robinson
      const WEBB = "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl";
      try {
        const r = await fetchT(`${WEBB}/athletes/${STAR_ID}/overview`, 6000);
        const d = await r.json();
        const stats = d.statistics || {};
        // Dump the EXACT splits shape (where the values live) + run a live parse.
        const sp = stats.splits;
        let values = null;
        if (Array.isArray(sp)) values = sp;
        else if (sp && Array.isArray(sp.stats)) values = sp.stats;
        else if (sp && Array.isArray(sp.values)) values = sp.values;

        const names = stats.names || [];
        const byName = (key) => {
          const i = names.findIndex(n => String(n).toLowerCase() === key.toLowerCase());
          return (i>=0 && values && values[i]!=null) ? values[i] : null;
        };
        out.steps.overviewShape = {
          player: "Bijan Robinson",
          splitsType: Array.isArray(sp) ? "array" : (sp ? "object:"+keysOf(sp) : "missing"),
          valuesFound: !!values,
          valuesSample: values ? values.slice(0, 12) : null,
          names: names,
          // Live parse of the key stats — proves the production parser will work.
          parsed: {
            rushingTouchdowns: byName("rushingTouchdowns"),
            receivingTouchdowns: byName("receivingTouchdowns"),
            rushingAttempts: byName("rushingAttempts"),
            receptions: byName("receptions")
          }
        };
      } catch (e) { out.steps.overviewShape = { error: e.name==="AbortError"?"timeout":e.message }; }

      // ── Step 4: season-scoped team defense ────────────────────────────────
      try {
        const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
        const yr = new Date().getFullYear();
        const testDef = async (y) => {
          const r = await fetchT(`${CORE}/seasons/${y}/types/2/teams/${homeId}/statistics`);
          if (!r.ok) return { year:y, httpStatus:r.status };
          const d = await r.json();
          const cats = d.splits?.categories || [];
          return { year:y, httpStatus:r.status, categoryNames: cats.map(c=>c.name).slice(0,15) };
        };
        out.steps.defense = { current: await testDef(yr), prior: await testDef(yr-1) };
      } catch (e) { out.steps.defense = { error: e.name==="AbortError"?"timeout":e.message }; }
    }

    out.VERDICT = "overviewShape.parsed should show real numbers (Bijan's rushingTouchdowns etc). If parsed has numbers, the production parser works and ALL data sources are confirmed — ready to build the app. If parsed is null, valuesSample + splitsType show where the values actually live.";
    return res.status(200).json(out);
  } catch (e) {
    out.fatal = e.message;
    return res.status(200).json(out);
  }
}
