// pages/index.js — minimal placeholder so the app deploys and you can hit the
// diagnostic at /api/gametest. The real UI comes after we verify ESPN shapes.
export default function Home() {
  return (
    <div style={{ minHeight:"100vh", background:"#0a0e1a", color:"#f8fafc", fontFamily:"system-ui", padding:"40px 24px" }}>
      <h1 style={{ color:"#22c55e", fontFamily:"Georgia,serif", fontSize:40, margin:0 }}>TD ORACLE</h1>
      <p style={{ color:"#64748b", marginTop:8 }}>Setup mode — verifying data sources.</p>
      <div style={{ marginTop:24, background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:10, padding:20, maxWidth:520 }}>
        <p style={{ margin:0, fontSize:14, lineHeight:1.6 }}>
          Open <a href="/api/gametest" style={{ color:"#22c55e" }}>/api/gametest</a> to run the ESPN data diagnostic,
          then share the JSON so the data parsing can be finalized.
        </p>
      </div>
    </div>
  );
}
