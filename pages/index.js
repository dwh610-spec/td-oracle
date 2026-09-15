// pages/index.js — TD ORACLE frontend
import React, { useState } from "react";
import Head from "next/head";

function weekStr(week) {
  return week ? `NFL Week ${week} · ${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}`
              : new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
}
function todayISO() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }

const HEAT = [
  { min: 60, label:"🔥 ELITE", color:"#22c55e" },
  { min: 45, label:"STRONG",   color:"#4ade80" },
  { min: 32, label:"LEAN",     color:"#a3e635" },
  { min: 0,  label:"DART",     color:"#64748b" }
];
const heatFor = (s) => HEAT.find(h => (s||0) >= h.min) || HEAT[HEAT.length-1];
const POS_COLOR = { RB:"#f97316", WR:"#38bdf8", TE:"#a78bfa", FB:"#94a3b8", QB:"#eab308" };

function Row({ rank, b, onClick, selected }) {
  const heat = heatFor(b.td_score);
  return (
    <div onClick={onClick} style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 14px", marginBottom:7,
      background: selected?"rgba(34,197,94,0.08)":"rgba(255,255,255,0.03)",
      border:`1px solid ${selected?"rgba(34,197,94,0.4)":"rgba(255,255,255,0.07)"}`, borderRadius:10, cursor:"pointer" }}>
      <div style={{ fontSize:15, fontWeight:800, color:"#475569", fontFamily:"Georgia,serif", width:22, textAlign:"center" }}>{rank}</div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:7 }}>
          <span style={{ fontSize:15, fontWeight:700, color:"#f8fafc" }}>{b.name}</span>
          <span style={{ fontSize:9, fontWeight:800, color:POS_COLOR[b.pos]||"#94a3b8", fontFamily:"monospace" }}>{b.pos||""}</span>
        </div>
        <div style={{ fontSize:10, color:"#64748b", fontFamily:"monospace", marginTop:2 }}>
          {b.team}{b.opponent?` vs ${b.opponent}`:""}{b.td_prob?` · ${b.td_prob} TD`:""}
        </div>
      </div>
      <div style={{ textAlign:"right" }}>
        <div style={{ fontSize:20, fontWeight:800, color:heat.color, fontFamily:"Georgia,serif" }}>{b.td_score}</div>
        <div style={{ fontSize:7, fontWeight:800, color:heat.color, fontFamily:"monospace", letterSpacing:"0.06em" }}>{heat.label}</div>
      </div>
    </div>
  );
}

function ByGame({ games, scorers }) {
  const [sel, setSel] = useState(games[0] || null);
  const teamMatch = (a, b) => {
    const x=(a||"").toUpperCase(), y=(b||"").toUpperCase();
    if (!x||!y) return false;
    if (x===y) return true;
    const s = x.length<=y.length?x:y, l = x.length<=y.length?y:x;
    return s.length>=2 && l.startsWith(s);
  };
  const gs = sel ? scorers.filter(b => teamMatch(b.team, sel.away_team) || teamMatch(b.team, sel.home_team))
                          .sort((a,b)=>b.td_score-a.td_score) : [];
  return (
    <div>
      <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:16 }}>
        {games.map(g => (
          <button key={g.game_id} onClick={()=>setSel(g)} style={{
            background: sel?.game_id===g.game_id?"rgba(34,197,94,0.15)":"rgba(255,255,255,0.04)",
            color: sel?.game_id===g.game_id?"#22c55e":"#94a3b8",
            border:`1px solid ${sel?.game_id===g.game_id?"rgba(34,197,94,0.4)":"rgba(255,255,255,0.08)"}`,
            borderRadius:8, padding:"6px 12px", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"monospace" }}>
            {g.away_team}@{g.home_team}
          </button>
        ))}
      </div>
      {sel && (
        <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:10, padding:"13px 16px", marginBottom:14 }}>
          <div style={{ fontSize:19, fontWeight:700, color:"#f8fafc", fontFamily:"Georgia,serif" }}>{sel.away_team} @ {sel.home_team}</div>
          <div style={{ fontSize:10, color:"#64748b", marginTop:3, fontFamily:"monospace" }}>
            {sel.venue||""}{sel.over_under?` · O/U ${sel.over_under}`:""}{sel.favorite?` · ${sel.favorite} favored`:""}
            {sel.away_implied!=null?` · implied ${sel.away_team} ${sel.away_implied}/${sel.home_team} ${sel.home_implied}`:""}
          </div>
        </div>
      )}
      {gs.map((b,i) => <Row key={b.name+i} rank={i+1} b={b} />)}
      {sel && !gs.length && <div style={{ color:"#475569", textAlign:"center", padding:24, fontSize:13 }}>No projected scorers ranked for this game.</div>}
    </div>
  );
}

function Tracker() {
  const [rows, setRows] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const norm = (s)=>String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[.\-']/g,"").replace(/\s+/g," ").trim();

  const grade = async () => {
    setBusy(true);
    try {
      const log = JSON.parse(localStorage.getItem("tdoracle_picks")||"{}");
      const today = todayISO();
      const graded = JSON.parse(localStorage.getItem("tdoracle_graded")||"{}");
      for (const d of Object.keys(log).filter(x=>x<today)) {
        if (graded[d]) continue;
        try {
          const r = await fetch(`/api/results?date=${d}`);
          const data = await r.json();
          if (!data.tdScorers) continue;
          const set = new Set(data.tdScorers.map(norm));
          const picks = log[d].picks||[];
          const hits = picks.filter(p=>set.has(norm(p.name)));
          graded[d] = { picks:picks.length, hits:hits.length, hitNames:hits.map(p=>p.name) };
        } catch {}
      }
      localStorage.setItem("tdoracle_graded", JSON.stringify(graded));
      const out = [];
      if (log[today]) out.push({ date:today, pending:true, picks:(log[today].picks||[]).length });
      for (const d of Object.keys(graded).sort().reverse()) out.push({ date:d, ...graded[d] });
      setRows(out);
    } finally { setBusy(false); }
  };
  React.useEffect(()=>{ grade(); }, []);

  const g = (rows||[]).filter(r=>!r.pending && r.picks);
  const totHits = g.reduce((s,r)=>s+(r.hits||0),0), totPicks = g.reduce((s,r)=>s+(r.picks||0),0);
  const rate = totPicks?Math.round(totHits/totPicks*100):0;
  const fmt = (d)=>{ const p=d.split("-"); return `${p[1]}/${p[2]}`; };

  return (
    <div>
      <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
        <div style={{ flex:1, minWidth:100, background:"rgba(34,197,94,0.1)", border:"1px solid rgba(34,197,94,0.3)", borderRadius:10, padding:"12px 14px" }}>
          <div style={{ fontSize:9, color:"#94a3b8", fontFamily:"monospace" }}>HIT RATE</div>
          <div style={{ fontSize:26, fontWeight:800, color:"#22c55e", fontFamily:"Georgia,serif" }}>{rate}%</div>
          <div style={{ fontSize:9, color:"#64748b", fontFamily:"monospace" }}>{totHits}/{totPicks} scored</div>
        </div>
        <div style={{ flex:1, minWidth:100, background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:10, padding:"12px 14px" }}>
          <div style={{ fontSize:9, color:"#94a3b8", fontFamily:"monospace" }}>WEEKS TRACKED</div>
          <div style={{ fontSize:26, fontWeight:800, color:"#f8fafc", fontFamily:"Georgia,serif" }}>{g.length}</div>
        </div>
      </div>
      {busy && <div style={{ color:"#64748b", textAlign:"center", padding:12, fontSize:12, fontFamily:"monospace" }}>grading past picks…</div>}
      {rows && rows.length===0 && !busy && (
        <div style={{ color:"#475569", textAlign:"center", padding:24, fontSize:13 }}>No picks logged yet. Run analysis and your top scorers are saved here, graded once games finish.</div>
      )}
      {rows && rows.map((r,i)=>(
        <div key={i} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:9, padding:"10px 14px", marginBottom:7, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontSize:13, fontWeight:700, color:"#f8fafc", fontFamily:"monospace" }}>{fmt(r.date)}</div>
            {r.pending ? <div style={{ fontSize:10, color:"#eab308", fontFamily:"monospace" }}>{r.picks} picks · awaiting results</div>
                       : <div style={{ fontSize:10, color:"#64748b", fontFamily:"monospace" }}>{r.hitNames&&r.hitNames.length?r.hitNames.join(", "):"no picks scored"}</div>}
          </div>
          {!r.pending && <div style={{ textAlign:"right" }}><div style={{ fontSize:18, fontWeight:800, fontFamily:"Georgia,serif", color:(r.hits>0?"#22c55e":"#475569") }}>{r.hits}/{r.picks}</div></div>}
        </div>
      ))}
      <div style={{ fontSize:9, color:"#334155", fontFamily:"monospace", textAlign:"center", marginTop:12, lineHeight:1.5 }}>
        Picks saved on THIS device only. A "hit" = a top pick who scored a TD that day.<br/>Realistic anytime-TD hit rates run ~30-45% on strong plays.
      </div>
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(p){ super(p); this.state={err:null}; }
  static getDerivedStateFromError(err){ return { err }; }
  render(){
    if (this.state.err) return (
      <div style={{ background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.3)", borderRadius:10, padding:20, margin:"20px 0" }}>
        <div style={{ color:"#f87171", fontWeight:700, marginBottom:6 }}>⚠️ Display error</div>
        <div style={{ color:"#fca5a5", fontSize:13, fontFamily:"monospace" }}>{String(this.state.err.message||this.state.err)}</div>
      </div>
    );
    return this.props.children;
  }
}

export default function TDOracle() {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [errors, setErrors] = useState([]);
  const [games, setGames] = useState([]);
  const [scorers, setScorers] = useState([]);
  const [week, setWeek] = useState(null);
  const [tab, setTab] = useState(0);
  const [refreshed, setRefreshed] = useState(null);
  const [source, setSource] = useState(null);

  const run = async () => {
    setLoading(true); setErrors([]); setGames([]); setScorers([]); setSource(null);
    const errs = [];
    try {
      setStatus("Loading this week's slate…");
      const schedRes = await fetch("/api/schedule");
      const sched = await schedRes.json();
      if (sched.error) throw new Error(sched.error);
      const fetchedGames = sched.games || [];
      setWeek(sched.week);
      setGames(fetchedGames);
      if (!fetchedGames.length) { setErrors(["No upcoming games found for this week."]); setLoading(false); setStatus(""); return; }

      setStatus(`Loading player data for ${fetchedGames.length} games…`);
      const ready = [];
      const BATCH = 4;
      for (let i=0; i<fetchedGames.length; i+=BATCH) {
        const slice = fetchedGames.slice(i, i+BATCH);
        setStatus(`Loading rosters & usage… (${Math.min(i+BATCH, fetchedGames.length)}/${fetchedGames.length})`);
        await Promise.all(slice.map(async (g) => {
          try {
            const r = await fetch("/api/gamedata", {
              method:"POST", headers:{ "Content-Type":"application/json" },
              body: JSON.stringify({ away_team:g.away_team, home_team:g.home_team, away_team_id:g.away_team_id, home_team_id:g.home_team_id })
            });
            const gd = await r.json();
            const n = (gd.players?.away?.length||0) + (gd.players?.home?.length||0);
            if (n >= 2) ready.push({ game:g, gameData:gd });
          } catch(e) { /* skip */ }
        }));
      }
      if (!ready.length) { setErrors(["Player data didn't load for any game. Try again in a moment."]); setLoading(false); setStatus(""); return; }

      setStatus(`Analyzing ${ready.length} games for TD scorers…`);
      const anRes = await fetch("/api/analyze", {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ games: ready })
      });
      const anData = await anRes.json();
      if (anData.error) throw new Error(anData.error);
      if (Array.isArray(anData.candidates) && anData.candidates.length) {
        const seen = new Set();
        const final = anData.candidates
          .filter(b => { const k=`${b.name}|${b.team}`; if(seen.has(k))return false; seen.add(k); return true; })
          .sort((a,b)=>b.td_score-a.td_score);
        setScorers(final);
        if (anData.source) setSource(anData.source);
        setRefreshed(new Date().toLocaleTimeString());
        try {
          const key="tdoracle_picks"; const log=JSON.parse(localStorage.getItem(key)||"{}"); const d=todayISO();
          if (!log[d]) {
            log[d] = { savedAt:new Date().toISOString(), picks: final.slice(0,12).map(b=>({name:b.name,team:b.team,score:b.td_score})) };
            const days=Object.keys(log).sort(); while(days.length>60){ delete log[days.shift()]; }
            localStorage.setItem(key, JSON.stringify(log));
          }
        } catch {}
      } else {
        throw new Error(anData.reason || "Analysis returned no scorers");
      }
      if (errs.length) setErrors(errs);
    } catch(e) {
      setErrors([e.message]);
    } finally {
      setLoading(false); setStatus("");
    }
  };

  return (
    <>
      <Head><title>TD Oracle</title><meta name="viewport" content="width=device-width, initial-scale=1" /></Head>
      <div style={{ minHeight:"100vh", background:"#0a0e1a", color:"#f8fafc", fontFamily:"system-ui,-apple-system,sans-serif", padding:"32px 18px 60px", maxWidth:640, margin:"0 auto" }}>
        <h1 style={{ fontSize:44, fontWeight:800, margin:0, fontFamily:"Georgia,serif", background:"linear-gradient(90deg,#22c55e,#4ade80)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", letterSpacing:"-0.02em" }}>TD ORACLE</h1>
        <div style={{ fontSize:12, color:"#64748b", fontFamily:"monospace", marginTop:4 }}>
          {weekStr(week)}{refreshed?` · Updated ${refreshed}`:""}
        </div>

        <button onClick={run} disabled={loading} style={{ marginTop:18, background:loading?"rgba(34,197,94,0.3)":"linear-gradient(90deg,#16a34a,#22c55e)", color:"#fff", border:"none", borderRadius:12, padding:"15px 30px", fontSize:15, fontWeight:800, cursor:loading?"default":"pointer", fontFamily:"monospace", letterSpacing:"0.05em", boxShadow:loading?"none":"0 0 24px rgba(34,197,94,0.4)" }}>
          {loading ? "⏳ WORKING…" : (scorers.length?"↻ REFRESH":"⚡ RUN ANALYSIS")}
        </button>

        {status && <div style={{ marginTop:14, color:"#4ade80", fontSize:12, fontFamily:"monospace" }}>{status}</div>}

        {errors.map((e,i)=>(
          <div key={i} style={{ marginTop:14, background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.3)", borderRadius:10, padding:"14px 16px", color:"#fca5a5", fontSize:13 }}>⚠️ {e}</div>
        ))}

        {!loading && !scorers.length && !errors.length && (
          <div style={{ marginTop:28, color:"#64748b", fontSize:14, lineHeight:1.6 }}>
            Hit <strong style={{color:"#22c55e"}}>RUN ANALYSIS</strong> to pull this week's slate, player usage, defenses, and Vegas lines — then rank every skill player by anytime-touchdown likelihood.
          </div>
        )}

        {scorers.length > 0 && (
          <ErrorBoundary>
            <div style={{ marginTop:24 }}>
              <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:16, flexWrap:"wrap" }}>
                {["🏆 TOP TD","🎯 BY GAME","📊 TRACKER"].map((t,i)=>(
                  <button key={i} onClick={()=>setTab(i)} style={{ background:tab===i?"rgba(34,197,94,0.15)":"rgba(255,255,255,0.04)", color:tab===i?"#22c55e":"#64748b", border:`1px solid ${tab===i?"rgba(34,197,94,0.4)":"rgba(255,255,255,0.07)"}`, borderRadius:7, padding:"7px 14px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"monospace", letterSpacing:"0.05em" }}>{t}</button>
                ))}
                <div style={{ marginLeft:"auto", fontSize:10, color:"#334155", fontFamily:"monospace", textAlign:"right" }}>
                  <div>{scorers.length} players · {games.length} games</div>
                  {source ? <div style={{ color:"#22c55e", marginTop:2 }}>via {source}</div> : null}
                </div>
              </div>

              {tab===0 && (
                <div>
                  {scorers.slice(0,25).map((b,i)=><Row key={b.name+i} rank={i+1} b={b} />)}
                  <div style={{ fontSize:9, color:"#334155", fontFamily:"monospace", textAlign:"center", marginTop:12, lineHeight:1.5 }}>
                    ⚠️ Research & entertainment only. ESPN data + Vegas lines + AI analysis (provider shown above).
                  </div>
                </div>
              )}
              {tab===1 && <ByGame games={games} scorers={scorers} />}
              {tab===2 && <Tracker />}
            </div>
          </ErrorBoundary>
        )}
      </div>
    </>
  );
}
