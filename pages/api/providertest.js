// pages/api/providertest.js
// Diagnostic endpoint: tests Gemini, OpenRouter, and Cerebras independently
// and reports exactly why each one succeeds or fails.
// Visit /api/providertest in the browser after deploying.

export default async function handler(req, res) {
  const out = { gemini: {}, openrouter: {}, cerebras: {} };

  const gKeyRaw = process.env.GEMINI_API_KEY || "";
  const gKey = gKeyRaw.trim();
  const orKey = (process.env.OPENROUTER_API_KEY || "").trim();
  const cKey = (process.env.CEREBRAS_API_KEY || "").trim();

  out.gemini.keyPresent = !!gKey;
  out.gemini.keyLength = gKey.length;
  out.gemini.hadWhitespace = gKeyRaw !== gKey;
  out.openrouter.keyPresent = !!orKey;
  out.cerebras.keyPresent = !!cKey;

  const tinyPrompt = 'Reply with this exact JSON and nothing else: {"ok":true}';

  async function fetchWithTimeout(url, opts, ms) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  }

  // ── Test Cerebras ─────────────────────────────────────────────────────
  if (cKey) {
    try {
      const r = await fetchWithTimeout(
        "https://api.cerebras.ai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cKey}`,
          },
          body: JSON.stringify({
            model: "llama3.1-8b",
            messages: [{ role: "user", content: tinyPrompt }],
            max_tokens: 50,
          }),
        },
        25000
      );
      out.cerebras.httpStatus = r.status;
      let data;
      try {
        data = await r.json();
      } catch {
        data = null;
      }
      if (r.status === 402) {
        out.cerebras.result = "402 — billing/credits issue on the Cerebras account (not a rate limit)";
        out.cerebras.detail = JSON.stringify(data).slice(0, 200);
      } else if (data?.choices?.[0]?.message?.content) {
        out.cerebras.result = "SUCCESS ✅";
        out.cerebras.sample = data.choices[0].message.content.slice(0, 60);
      } else if (data?.error) {
        out.cerebras.result = `ERROR (${r.status})`;
        out.cerebras.detail = (data.error.message || JSON.stringify(data.error)).slice(0, 200);
      } else {
        out.cerebras.result = "UNEXPECTED";
        out.cerebras.detail = JSON.stringify(data).slice(0, 200);
      }
    } catch (e) {
      out.cerebras.result = "THREW";
      out.cerebras.detail = e.name === "AbortError" ? "timed out (25s)" : e.message.slice(0, 200);
    }
  } else {
    out.cerebras.result = "NO KEY — not set in Vercel env vars";
  }

  // ── Test OpenRouter ──────────────────────────────────────────────────
  if (orKey) {
    try {
      const r = await fetchWithTimeout(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${orKey}`,
          },
          body: JSON.stringify({
            model: "meta-llama/llama-3.1-8b-instruct:free",
            messages: [{ role: "user", content: tinyPrompt }],
            max_tokens: 50,
          }),
        },
        25000
      );
      out.openrouter.httpStatus = r.status;
      let data;
      try {
        data = await r.json();
      } catch {
        data = null;
      }
      if (data?.error) {
        out.openrouter.result = `ERROR (${r.status})`;
        out.openrouter.detail = (data.error.message || JSON.stringify(data.error)).slice(0, 200);
      } else if (data?.choices?.[0]?.message?.content || data?.choices?.[0]?.message?.reasoning) {
        out.openrouter.result = "SUCCESS ✅";
        out.openrouter.sample = (data.choices[0].message.content || data.choices[0].message.reasoning).slice(0, 60);
      } else {
        out.openrouter.result = "UNEXPECTED";
        out.openrouter.detail = JSON.stringify(data).slice(0, 200);
      }
    } catch (e) {
      out.openrouter.result = "THREW";
      out.openrouter.detail = e.name === "AbortError" ? "timed out (25s)" : e.message.slice(0, 200);
    }
  } else {
    out.openrouter.result = "NO KEY — not set in Vercel env vars";
  }

  // ── Test Gemini ───────────────────────────────────────────────────────
  if (gKey) {
    for (const model of ["gemini-2.5-flash-lite", "gemini-2.5-flash"]) {
      const entry = {};
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(gKey)}`;
        const r = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: tinyPrompt }] }],
              generationConfig: { maxOutputTokens: 50, responseMimeType: "application/json" },
            }),
          },
          25000
        );
        entry.httpStatus = r.status;
        let data;
        try {
          data = await r.json();
        } catch {
          data = null;
        }
        if (data?.error) {
          entry.result = data.error.code === 429 ? "RATE-LIMITED (429) — likely daily quota used up" : "ERROR";
          entry.detail = (data.error.message || "").slice(0, 200);
        } else if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
          entry.result = "SUCCESS ✅";
          entry.sample = data.candidates[0].content.parts[0].text.slice(0, 60);
        } else {
          entry.result = "UNEXPECTED";
          entry.detail = JSON.stringify(data).slice(0, 200);
        }
      } catch (e) {
        entry.result = "THREW";
        entry.detail = e.name === "AbortError" ? "timed out (25s)" : e.message.slice(0, 200);
      }
      out.gemini[model] = entry;
    }
  } else {
    out.gemini.result = "NO KEY — not set in Vercel env vars";
  }

  // ── Verdict ───────────────────────────────────────────────────────────
  const gLiteOk = out.gemini["gemini-2.5-flash-lite"]?.result === "SUCCESS ✅";
  const gFlashOk = out.gemini["gemini-2.5-flash"]?.result === "SUCCESS ✅";
  const orOk = out.openrouter.result === "SUCCESS ✅";
  const cOk = out.cerebras.result === "SUCCESS ✅";

  if (gLiteOk || gFlashOk) out.VERDICT = "Gemini works — app should succeed via Gemini (first in chain).";
  else if (orOk) out.VERDICT = "Gemini down but OpenRouter works — app should succeed via OpenRouter.";
  else if (cOk) out.VERDICT = "Gemini and OpenRouter down — app should succeed via Cerebras fallback only.";
  else out.VERDICT = "All providers failing. See detail fields above for the exact reason per provider.";

  return res.status(200).json(out);
}
