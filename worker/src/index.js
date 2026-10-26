// Hub sync server: a tiny document store on Cloudflare Workers + D1.
// Every record is {id, data, updated_at}. The server stamps updated_at, so clients
// can ask for "everything changed since X". Requests need the x-hub-secret header.
//
//   GET  /docs                     -> all docs
//   GET  /docs?since=<iso>         -> docs changed after <iso>
//   GET  /docs?prefix=wish:        -> docs whose id starts with the prefix
//   GET  /docs?id=meta:pricebot    -> one doc (as a one-item array)
//   POST /docs   [{id, data}, ...] -> upsert, returns {ok, n, updated_at}
//   GET  /health                   -> {ok:true} (no secret needed)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-hub-secret",
  "Access-Control-Max-Age": "86400",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

// Constant-time compare so the secret can't be guessed byte by byte from timing.
function same(a, b) {
  const x = new TextEncoder().encode(a || ""), y = new TextEncoder().encode(b || "");
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

// Strictly increasing timestamps, so two writes in the same millisecond still sort.
let last = "";
function stamp() {
  let t = new Date().toISOString();
  if (t <= last) { const ms = Date.parse(last) + 1; t = new Date(ms).toISOString(); }
  last = t;
  return t;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname !== "/docs") return json({ error: "not found" }, 404);
    if (!env.HUB_SECRET) return json({ error: "server has no HUB_SECRET set" }, 500);
    if (!same(req.headers.get("x-hub-secret"), env.HUB_SECRET)) return json({ error: "wrong secret word" }, 401);

    if (req.method === "GET") {
      const since = url.searchParams.get("since"), prefix = url.searchParams.get("prefix"), id = url.searchParams.get("id");
      let q = "SELECT id, data, updated_at FROM docs", args = [];
      if (id) { q += " WHERE id = ?"; args.push(id); }
      else if (since) { q += " WHERE updated_at > ?"; args.push(since); }
      else if (prefix) { q += " WHERE id >= ? AND id < ?"; args.push(prefix, prefix + "￿"); }
      q += " ORDER BY updated_at ASC";
      const { results } = await env.DB.prepare(q).bind(...args).all();
      return json(results.map(r => ({ id: r.id, data: JSON.parse(r.data), updated_at: r.updated_at })));
    }

    if (req.method === "POST") {
      let rows;
      try { rows = await req.json(); } catch { return json({ error: "body must be JSON" }, 400); }
      if (!Array.isArray(rows)) rows = [rows];
      if (rows.length > 500) return json({ error: "max 500 docs per request" }, 400);
      const stmts = [];
      let t = "";
      for (const r of rows) {
        if (!r || typeof r.id !== "string" || !r.id || r.id.length > 200) return json({ error: "each doc needs a string id" }, 400);
        const data = JSON.stringify(r.data ?? {});
        if (data.length > 1_000_000) return json({ error: `doc ${r.id} is larger than 1 MB` }, 400);
        t = stamp();
        stmts.push(env.DB.prepare("INSERT INTO docs (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at").bind(r.id, data, t));
      }
      if (stmts.length) await env.DB.batch(stmts);
      return json({ ok: true, n: stmts.length, updated_at: t });
    }
    return json({ error: "method not allowed" }, 405);
  },
};
