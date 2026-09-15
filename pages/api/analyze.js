// pages/api/analyze.js
// Ranks players by anytime-TD likelihood for the full slate. Reuses the proven
// HR Oracle architecture: multi-provider LLM fallback (Gemini → OpenRouter →
// Cerebras), truncation salvage, and — critically — authoritative team/matchup
// override so the model can never put a player on the wrong team.

export const config = { maxDuration: 60 };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const estTokens = (s) => Math.ceil((s || "").length / 4);

// ── Prompt building ─────────────────────────────────────────────────────────
function gameBlock(game, gd) {
  const fmt = (arr, oppDef) => (arr || []).map(p => {
    const usage = p.td_rate != null
      ? ` TD/g${p.td_rate} touch/g${p.touches_pg ?? "?"} tgt/g${p.targets_pg ?? "?"} L${p.recent_games}:${p.recent_tds}TD`
      : " (limited recent data)";
    return `${p.name}(${p.pos}) ${usage}`;
  }).join("\n");

  const defStr = (d) => {
    if (!d) return "";
    const bits = [];
    if (d.pts_allowed != null) bits.push(`PA ${d.pts_allowed}`);
    if (d.rush_td_allowed != null) bits.push(`rushTD-allowed ${d.rush_td_allowed}`);
    if (d.pass_td_allowed != null) bits.push(`passTD-allowed ${d.pass_td_allowed}`);
    return bits.length ? ` [opp def: ${bits.join(", ")}]` : "";
  };

  const line = game.spread != null ? ` spread ${game.spread}` : "";
  const ou = game.over_under != null ? ` O/U ${game.over_under}` : "";
  const impl = (game.away_implied != null)
    ? ` implied: ${game.away_team} ${game.away_implied} / ${game.home_team} ${game.home_implied}` : "";

  return `=== ${game.away_team}@${game.home_team}${line}${ou}${impl}
${game.away_team} players (vs ${game.home_team} def${defStr(gd?.defense?.home)}):
${fmt(gd?.players?.away, gd?.defense?.home)}
${game.home_team} players (vs ${game.away_team} def${defStr(gd?.defense?.away)}):
${fmt(gd?.players?.home, gd?.defense?.away)}`;
}

const INSTRUCTIONS_HEAD = `You are an NFL anytime-touchdown predictor. For the slate below, rank the players MOST likely to score a touchdown (rushing OR receiving) in their game.

Return the 2-3 STRONGEST anytime-TD candidates FROM EACH GAME — every game represented by its best scorers. Rank the whole list by td_score. Skip a game's low-probability players, but do NOT skip whole games.`;

const INSTRUCTIONS_TAIL = `SCORING PRIORITY:
(1) VEGAS IMPLIED TEAM TOTAL is the #1 environment factor — a team implied for 27+ points scores multiple TDs; under ~17 rarely finds the end zone. Favor players on high-implied-total teams.
(2) RED-ZONE / GOAL-LINE ROLE — running backs who get goal-line carries and receivers/TEs who are red-zone targets score most anytime TDs. Recent TD rate (TD/g) and touch volume (touch/g, tgt/g) are the best proxies; weight recent usage heavily.
(3) OPPONENT DEFENSE — a defense allowing many rushing TDs makes opposing RBs strong plays; one giving up passing TDs lifts WR/TE. Higher points-allowed = softer defense.
(4) GAME SCRIPT from the spread — a heavy favorite (negative spread) tends to run near the goal line late → boosts its RBs; a big underdog throws → boosts its pass-catchers in garbage time.
(5) VOLUME — high touches/targets per game means more scoring chances; a workhorse RB or target-hog WR beats a committee player.

Realistic: even the best anytime-TD play is ~55-70% likely; most good plays are 35-55%. Do NOT inflate. Spread td_score 0-100 honestly.

Return ONLY valid JSON, no markdown:
{"candidates":[{"name":"","team":"","pos":"RB","opponent":"","td_score":62.5,"td_prob":"48%","key_factors":[{"label":"Implied Total","value":"28.5"},{"label":"TD/g","value":"0.8"}],"summary":"brief"}]}`;

function buildPrompt(blocks) {
  return `${INSTRUCTIONS_HEAD}\n\n${blocks.join("\n\n")}\n\n${INSTRUCTIONS_TAIL}`;
}

// ── JSON extraction + salvage (from HR Oracle, proven) ──────────────────────
function extractCandidates(rawText) {
  if (!rawText) return null;
  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch {
    const o1 = rawText.indexOf("{"), o2 = rawText.lastIndexOf("}");
    if (o1 !== -1 && o2 > o1) { try { parsed = JSON.parse(rawText.slice(o1, o2+1)); } catch {} }
    if (!parsed) { const a1=rawText.indexOf("["),a2=rawText.lastIndexOf("]"); if(a1!==-1&&a2>a1){try{parsed=JSON.parse(rawText.slice(a1,a2+1));}catch{}} }
  }
  if (!parsed) return null;
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.candidates) && parsed.candidates.some(c => c && c.name)) return parsed.candidates;
  const isCand = (v) => Array.isArray(v) && v.some(x => x && typeof x === "object" && "name" in x);
  let best = null, bestScore = 0;
  const consider = (v) => { if (!isCand(v)) return; const sc = v.filter(x=>x&&x.name).length; if (sc>bestScore){best=v;bestScore=sc;} };
  for (const v of Object.values(parsed)) {
    consider(v);
    if (v && typeof v === "object" && !Array.isArray(v)) for (const v2 of Object.values(v)) consider(v2);
  }
  if (best) return best;
  if (Array.isArray(parsed.candidates)) return parsed.candidates;
  return Object.values(parsed).find(v => Array.isArray(v)) || null;
}

function salvageCandidates(rawText) {
  if (!rawText) return null;
  const out = [];
  const stack = [];
  let inStr = false, esc = false;
  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    if (inStr) { if (esc) esc=false; else if (ch==="\\") esc=true; else if (ch==='"') inStr=false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") stack.push(i);
    else if (ch === "}") {
      const start = stack.pop();
      if (start === undefined) continue;
      const chunk = rawText.slice(start, i+1);
      if (/"name"\s*:/.test(chunk) && !/"candidates"\s*:/.test(chunk)) {
        try { const o = JSON.parse(chunk); if (o && o.name) out.push(o); } catch {}
      }
    }
  }
  const seen = new Set();
  const uniq = out.filter(o => { const k=(o.name||"")+"|"+(o.team||""); if(seen.has(k))return false; seen.add(k); return true; });
  return uniq.length ? uniq : null;
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

// ── Providers ───────────────────────────────────────────────────────────────
async function callGemini(model, prompt, key, timeoutMs) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent((key||"").trim())}`;
  try {
    const r = await fetchWithTimeout(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8000, responseMimeType: "application/json" } })
    }, timeoutMs || 30000);
    if (!r.ok) { const b = await r.json().catch(()=>({})); return { ok:false, kind: b.error?.code===429?"rate":"error", msg:`${model} ${b.error?.code===429?"rate-limited":"error"}` }; }
    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!text) return { ok:false, kind:"empty", msg:`${model} empty` };
    let cands = extractCandidates(text); if (!cands) cands = salvageCandidates(text);
    if (!cands) return { ok:false, kind:"unparseable", msg:`${model} unparseable` };
    return { ok:true, candidates: cands };
  } catch(e) { return { ok:false, kind: e.name==="AbortError"?"timeout":"network", msg:`${model} ${e.name==="AbortError"?"timed out":"network error"}` }; }
}

async function callOpenRouter(model, prompt, key, timeoutMs) {
  try {
    const r = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
      method:"POST", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${(key||"").trim()}` },
      body: JSON.stringify({ model, messages:[{role:"user",content:prompt}], temperature:0.3, max_tokens:8000 })
    }, timeoutMs || 20000);
    if (!r.ok) return { ok:false, kind: r.status===429?"rate":"error", msg:`OR ${r.status}` };
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || "";
    const finish = data.choices?.[0]?.finish_reason || "";
    if (!text) return { ok:false, kind:"empty", msg:"OR empty" };
    let cands = extractCandidates(text); if (!cands) cands = salvageCandidates(text);
    if (!cands) { if (finish==="length") return { ok:false, kind:"toobig", msg:"OR truncated" }; return { ok:false, kind:"unparseable", msg:"OR unparseable" }; }
    return { ok:true, candidates: cands };
  } catch(e) { return { ok:false, kind:e.name==="AbortError"?"timeout":"network", msg:"OR "+(e.name==="AbortError"?"timeout":"network") }; }
}

async function callCerebras(prompt, key) {
  try {
    const r = await fetchWithTimeout("https://api.cerebras.ai/v1/chat/completions", {
      method:"POST", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${(key||"").trim()}` },
      body: JSON.stringify({ model:"gpt-oss-120b", messages:[{role:"user",content:prompt}], temperature:0.3, max_completion_tokens:6000 })
    }, 20000);
    if (!r.ok) return { ok:false, kind: r.status===429?"rate":(r.status===400?"toobig":"error"), msg:`Cerebras ${r.status}` };
    const data = await r.json();
    const msg = data.choices?.[0]?.message || {};
    const text = msg.content || msg.reasoning || "";
    const finish = data.choices?.[0]?.finish_reason || "";
    if (!text) return { ok:false, kind:"empty", msg:"Cerebras empty" };
    let cands = extractCandidates(text); if (!cands) cands = salvageCandidates(text);
    if (!cands) { if (finish==="length") return { ok:false, kind:"toobig", msg:"Cerebras truncated (length)" }; return { ok:false, kind:"unparseable", msg:"Cerebras unparseable" }; }
    return { ok:true, candidates: cands };
  } catch(e) { return { ok:false, kind:e.name==="AbortError"?"timeout":"network", msg:"Cerebras "+(e.name==="AbortError"?"timeout":"network") }; }
}

function chunkForCerebras(blocks) {
  const BUDGET = 1900;
  const overhead = estTokens(INSTRUCTIONS_HEAD) + estTokens(INSTRUCTIONS_TAIL) + 50;
  const chunks = []; let cur = [], curTok = overhead;
  for (const b of blocks) {
    const t = estTokens(b) + 2;
    if (cur.length && curTok + t > BUDGET) { chunks.push(cur); cur = []; curTok = overhead; }
    cur.push(b); curTok += t;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const startedAt = Date.now();
  const timeLeft = () => 58000 - (Date.now() - startedAt);

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const games = body?.games || [];
  if (!games.length) return res.status(200).json({ candidates: [], reason: "no games provided" });

  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  const normName = (s) => String(s||"").toLowerCase()
    .replace(/^#?\d+\s+/, "").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[.\-']/g,"").replace(/\s+/g," ").trim();

  // Build blocks + authoritative truth map (team + opponent per player).
  const blocks = [];
  const validNorm = new Set();
  const truthByPlayer = {}; // normName -> { team, opponent }
  for (const { game, gameData } of games) {
    const ap = gameData?.players?.away || [], hp = gameData?.players?.home || [];
    if (!ap.length && !hp.length) continue;
    ap.forEach(p => { validNorm.add(normName(p.name)); truthByPlayer[normName(p.name)] = { team: game.away_team, opponent: game.home_team }; });
    hp.forEach(p => { validNorm.add(normName(p.name)); truthByPlayer[normName(p.name)] = { team: game.home_team, opponent: game.away_team }; });
    blocks.push(gameBlock(game, gameData));
  }
  if (!blocks.length) return res.status(200).json({ candidates: [], reason: "no player data in any game" });

  const validLast = new Set([...validNorm].map(n => n.split(" ").pop()));

  const finalize = (cands, source) => {
    const clean = (cands || []).filter(c => c && c.name)
      .map(c => ({ ...c, name: String(c.name).replace(/^#?\d+\s+/, "").trim() }));

    let kept = clean.filter(c => validNorm.has(normName(c.name)));
    if (kept.length < 3) {
      const byLast = clean.filter(c => validLast.has(normName(c.name).split(" ").pop()));
      if (byLast.length > kept.length) kept = byLast;
    }
    let note = "";
    if (clean.length >= 6 && kept.length < Math.max(3, Math.floor(clean.length/3))) { note = ` (name-match kept ${kept.length}/${clean.length}; showing all)`; kept = clean; }
    else if (!kept.length && clean.length) kept = clean;

    // Authoritative override: correct team + opponent from the real rosters.
    const truthFor = (c) => {
      const n = normName(c.name);
      if (truthByPlayer[n]) return truthByPlayer[n];
      const last = n.split(" ").pop();
      const hits = Object.entries(truthByPlayer).filter(([k]) => k.split(" ").pop() === last);
      return hits.length === 1 ? hits[0][1] : null;
    };

    const seen = new Set();
    const out = kept.map(c => {
      const t = truthFor(c);
      const cc = { ...c, td_score: Math.round((parseFloat(c.td_score)||0)*10)/10 };
      if (t) { cc.team = t.team; cc.opponent = t.opponent; }
      return cc;
    }).filter(c => { const k=normName(c.name)+"|"+(c.team||""); if(seen.has(k))return false; seen.add(k); return true; })
      .sort((a,b) => b.td_score - a.td_score)
      .slice(0, 40);

    if (!out.length) {
      const rawN = Array.isArray(cands) ? cands.length : 0;
      return res.status(200).json({ candidates: [], source, reason: rawN===0 ? `${source} returned empty` : `${source} returned ${rawN} but 0 matched rosters` });
    }
    return res.status(200).json({ candidates: out, source: source + note });
  };

  let lastMsg = "";

  // Provider 1: Gemini flash-lite first (reliable, full slate, 1M context).
  if (GEMINI_KEY && timeLeft() > 15000) {
    const prompt = buildPrompt(blocks);
    for (const model of ["gemini-2.5-flash-lite", "gemini-2.5-flash"]) {
      if (timeLeft() < 12000) break;
      const r = await callGemini(model, prompt, GEMINI_KEY, Math.max(10000, timeLeft() - 6000));
      if (r.ok) return finalize(r.candidates, model);
      lastMsg = r.msg;
    }
  }

  // Provider 2: OpenRouter (tight timeout so it can't starve Cerebras).
  if (OPENROUTER_KEY && timeLeft() > 20000) {
    const prompt = buildPrompt(blocks);
    const r = await callOpenRouter("meta-llama/llama-3.3-70b-instruct:free", prompt, OPENROUTER_KEY, Math.min(10000, timeLeft() - 20000));
    if (r.ok) return finalize(r.candidates, "openrouter:llama-3.3-70b");
    lastMsg = r.msg;
  }

  // Provider 3: Cerebras (last resort, chunked for its small context).
  if (CEREBRAS_KEY && timeLeft() > 12000) {
    const allChunks = chunkForCerebras(blocks);
    const chunks = allChunks.slice(0, 16);
    const collected = [];
    let partial = false;
    for (let i = 0; i < chunks.length; i++) {
      if (timeLeft() < 6000) { partial = true; break; }
      if (i > 0) await sleep(1100);
      let done = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const r = await callCerebras(buildPrompt(chunks[i]), CEREBRAS_KEY);
        if (r.ok) { collected.push(...r.candidates); done = true; break; }
        lastMsg = r.msg;
        if (r.kind === "toobig" && chunks[i].length > 1) { const mid=Math.ceil(chunks[i].length/2); chunks.splice(i,1,chunks[i].slice(0,mid),chunks[i].slice(mid)); i--; done=true; break; }
        if (r.kind === "toobig" && chunks[i].length === 1) { done = true; break; }
        if (r.kind === "rate" && attempt < 2 && timeLeft() > 8000) { await sleep(1200); continue; }
        break;
      }
      if (!done) continue;
    }
    if (collected.length) return finalize(collected, partial ? "cerebras (partial)" : "cerebras");
  }

  return res.status(200).json({ candidates: [], reason: lastMsg || "all providers failed" });
}
