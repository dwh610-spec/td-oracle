// pages/api/injurytest.js
// Diagnostic: (1) prints RAW injury status text for one team, and (2) finds
// a named player in that team's roster response and dumps their FULL raw
// object — so we can see whether ESPN's roster payload carries a roster-
// status field (Active/Exempt/Suspended/Reserve/Cut) at all, which the
// injuries endpoint does NOT cover (Commissioner Exempt, suspensions, etc.
// are a different designation entirely, not an injury).
// Visit /api/injurytest?team=9&player=Jacobs in Safari.

const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

async function fetchT(url, ms = 7000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

export default async function handler(req, res) {
  const teamId = req.query.team || "9"; // 9 = Green Bay
  const playerQuery = (req.query.player || "").toLowerCase();
  const out = { teamId, raw_items_count: 0, resolved: [], roster_search: null };

  try {
    // Part 1: injuries feed (as before).
    const r = await fetchT(`${CORE}/teams/${teamId}/injuries`, 8000);
    out.injuriesEndpointStatus = r.status;
    if (r.ok) {
      const d = await r.json();
      const items = d.items || [];
      out.raw_items_count = items.length;
      out.first_raw_item_shape = items[0] || null;
      for (const item of items.slice(0, 25)) {
        let obj = item;
        if (item?.$ref) {
          try { const rr = await fetchT(item.$ref, 5000); if (rr.ok) obj = await rr.json(); } catch {}
        }
        out.resolved.push({
          raw_status_field: obj.status,
          athlete_ref: obj.athlete?.$ref || obj.athlete || null,
          full_object_keys: Object.keys(obj)
        });
      }
    }

    // Part 2: find the named player in the roster response and dump the
    // ENTIRE raw athlete object — this is the one that matters right now.
    if (playerQuery) {
      const rr = await fetchT(`${SITE}/teams/${teamId}/roster`, 8000);
      if (rr.ok) {
        const rd = await rr.json();
        for (const group of rd.athletes || []) {
          for (const a of group.items || []) {
            const name = (a.displayName || a.fullName || "").toLowerCase();
            if (name.includes(playerQuery)) {
              out.roster_search = {
                found_in_group: group.position || null,
                full_raw_athlete_object: a
              };
            }
          }
        }
      }
      if (!out.roster_search) out.roster_search = { note: `"${playerQuery}" not found in team ${teamId}'s roster response at all` };
    }

    return res.status(200).json(out);
  } catch (e) {
    out.error = e.message;
    return res.status(200).json(out);
  }
}
