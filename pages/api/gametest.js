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

      // ── Step 3: gamelog shape (THE prime suspect — usage/TD parsing) ──────
      // Use the sample athlete found above.
      const sampleId = out.steps.roster?.sampleAthlete?.id;
      if (sampleId) {
        try {
          const r = await fetchT(`${WEB}/athletes/${sampleId}/gamelog`);
          const d = await r.json();
          out.steps.gamelog = {
            httpStatus: r.status,
            player: out.steps.roster.sampleAthlete.name,
            topKeys: keysOf(d),
            hasSeasonTypes: !!d.seasonTypes,
            hasEvents: !!d.events,
            labels: d.labels || d.names || null,
            // Show one stat row so we can map indices → stats correctly.
            sampleRow: extractSampleRow(d),
            categoriesShape: d.seasonTypes?.[0] ? keysOf(d.seasonTypes[0]) : null
          };
        } catch (e) { out.steps.gamelog = { error: e.name==="AbortError"?"timeout":e.message }; }
      }

      // ── Step 4: team defense/statistics shape ─────────────────────────────
      try {
        const r = await fetchT(`${SITE}/teams/${homeId}/statistics`);
        const d = await r.json();
        out.steps.defense = {
          httpStatus: r.status,
          topKeys: keysOf(d),
          hasSplits: !!d.splits,
          categoryNames: (d.splits?.categories || d.categories || []).map(c => c.name || c.displayName).slice(0,20)
        };
      } catch (e) { out.steps.defense = { error: e.name==="AbortError"?"timeout":e.message }; }
    }

    out.VERDICT = "Check: (1) picked.oddsSample — do spread/overUnder/details exist? (2) roster.groupKeys + sampleAthlete — are skill players found? (3) gamelog.labels + sampleRow — THIS is what our usage parser needs; if labels is null the parser can't map stats. (4) defense.categoryNames — do TD-allowed stats exist?";
    return res.status(200).json(out);
  } catch (e) {
    out.fatal = e.message;
    return res.status(200).json(out);
  }
}

// Try to pull one representative stat row out of whatever gamelog shape ESPN
// returned, so we can see the actual numbers and their order.
function extractSampleRow(d) {
  try {
    if (d.seasonTypes) {
      for (const st of d.seasonTypes) {
        for (const cat of st.categories || []) {
          for (const ev of cat.events || []) {
            if (ev.stats && ev.stats.length) return { via:"seasonTypes", stats: ev.stats };
          }
        }
      }
    }
    if (d.events && typeof d.events === "object") {
      for (const k of Object.keys(d.events)) {
        const ev = d.events[k];
        if (ev && ev.stats && ev.stats.length) return { via:"events", key:k, stats: ev.stats };
      }
    }
  } catch {}
  return null;
}
