// pages/api/results.js
// Returns the players who actually scored a TD on a given date, so the tracker
// can grade past picks. Uses ESPN's free scoreboard + summary endpoints.
//   /api/results?date=2026-09-14 -> { date, tdScorers: ["Name", ...] }

export const config = { maxDuration: 30 };

const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

async function fetchT(url, ms = 9000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const date = req.query.date;
  if (!date) return res.status(200).json({ error: "date required (YYYY-MM-DD)" });

  try {
    // ESPN scoreboard accepts ?dates=YYYYMMDD
    const ymd = date.replace(/-/g, "");
    const r = await fetchT(`${SITE}/scoreboard?dates=${ymd}`);
    const d = await r.json();
    const finals = [];
    for (const ev of d.events || []) {
      const st = ev.status?.type?.state;
      if (st === "post") finals.push(ev.id);
    }
    if (!finals.length) return res.status(200).json({ date, tdScorers: [], gamesFinal: 0, note: "no completed games" });

    const scorers = new Set();
    await Promise.all(finals.map(async (id) => {
      try {
        const sr = await fetchT(`${SITE}/summary?event=${id}`);
        const sd = await sr.json();
        // scoringPlays lists every TD with the scorer's name in the text/athletes.
        for (const play of sd.scoringPlays || []) {
          const typeAbbr = (play.scoringType?.abbreviation || play.type?.abbreviation || "").toUpperCase();
          const txt = (play.text || "").toLowerCase();
          if (typeAbbr === "TD" || txt.includes("touchdown")) {
            // Prefer structured athlete refs; fall back to parsing the play text.
            const parts = play.participants || play.athletes || [];
            let named = false;
            for (const pt of parts) {
              const nm = pt.athlete?.displayName || pt.displayName;
              if (nm) { scorers.add(nm); named = true; }
            }
            if (!named && play.text) {
              // Text like "Bijan Robinson 2 Yd Run (Younghoe Koo Kick)" → scorer is
              // the leading name before the yardage.
              const m = play.text.match(/^([A-Z][a-zA-Z.'-]+(?:\s[A-Z][a-zA-Z.'-]+){1,2})\s+\d+\s+Yd/);
              if (m) scorers.add(m[1]);
            }
          }
        }
      } catch {}
    }));

    return res.status(200).json({ date, gamesFinal: finals.length, tdScorers: [...scorers].filter(Boolean).sort() });
  } catch (e) {
    return res.status(200).json({ date, error: e.message, tdScorers: [] });
  }
}
