// pages/api/injurytest.js
// Diagnostic: prints the RAW status text ESPN returns for every injured
// player on one team. Visit /api/injurytest?team=9 (Packers) in Safari.
// Use this to confirm the OUT_LIKE regex in gamedata.js actually covers
// every status word ESPN uses, instead of guessing one at a time.

const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";

async function fetchT(url, ms = 7000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

export default async function handler(req, res) {
  const teamId = req.query.team || "9"; // 9 = Green Bay, change via ?team=
  const out = { teamId, raw_items_count: 0, resolved: [] };

  try {
    const r = await fetchT(`${CORE}/teams/${teamId}/injuries`, 8000);
    out.injuriesEndpointStatus = r.status;
    if (!r.ok) return res.status(200).json(out);
    const d = await r.json();
    const items = d.items || [];
    out.raw_items_count = items.length;
    out.first_raw_item_shape = items[0] || null; // see exactly what a list entry looks like

    for (const item of items.slice(0, 25)) {
      let obj = item;
      if (item?.$ref) {
        try {
          const rr = await fetchT(item.$ref, 5000);
          if (rr.ok) obj = await rr.json();
        } catch {}
      }
      out.resolved.push({
        raw_status_field: obj.status,
        athlete_ref: obj.athlete?.$ref || obj.athlete || null,
        full_object_keys: Object.keys(obj)
      });
    }

    return res.status(200).json(out);
  } catch (e) {
    out.error = e.message;
    return res.status(200).json(out);
  }
}
