// Hub sync server: a tiny document store on Cloudflare Workers + D1, plus Web Push reminders.
// Every record is {id, data, updated_at}. The server stamps updated_at, so clients
// can ask for "everything changed since X". Requests need the x-hub-secret header.
//
//   GET  /docs                     -> all docs
//   GET  /docs?since=<iso>         -> docs changed after <iso>
//   GET  /docs?prefix=wish:        -> docs whose id starts with the prefix
//   GET  /docs?id=meta:pricebot    -> one doc (as a one-item array)
//   POST /docs   [{id, data}, ...] -> upsert, returns {ok, n, updated_at}
//   GET  /push/key                 -> {key} VAPID public key (empty if push is not set up)
//   POST /push/subscribe {subscription, tz} -> remember this browser for reminders
//   POST /push/unsubscribe {endpoint}
//   POST /push/test                -> send a test notification to every subscriber
//   GET  /health                   -> {ok:true, push:bool} (no secret needed)
//
// A cron trigger (every 5 minutes) sends event reminders, plus one daily goal summary, to every subscriber in
// their own time zone. Needs secrets VAPID_PUBLIC + VAPID_PRIVATE (see README).

import { sendPush, dueReminders, goalDigest } from "./push.js";

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

let tablesReady = false;
async function ensureTables(env) {
  if (tablesReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, sub TEXT NOT NULL, tz TEXT NOT NULL, created_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS sent (key TEXT PRIMARY KEY, at TEXT NOT NULL)"),
  ]);
  tablesReady = true;
}
const pushReady = env => !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE);
async function subId(endpoint) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)); return [...new Uint8Array(h)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join(""); }

async function allEvents(env) {
  const { results } = await env.DB.prepare("SELECT id, data FROM docs WHERE id >= 'event:' AND id < 'event;'").all();
  return results.map(r => { try { return { id: r.id, ...JSON.parse(r.data) }; } catch { return null; } }).filter(e => e && !e.deleted);
}

async function docsWithPrefix(env, prefix) {
  const { results } = await env.DB.prepare("SELECT id, data FROM docs WHERE id >= ? AND id < ?").bind(prefix, prefix + "￿").all();
  return results.map(r => { try { return { id: r.id, ...JSON.parse(r.data) }; } catch { return null; } }).filter(e => e && !e.deleted);
}

async function broadcast(env, payload, { onlyDueFor } = {}) {
  await ensureTables(env);
  const { results } = await env.DB.prepare("SELECT id, sub, tz FROM subs").all();
  let sent = 0, dropped = 0;
  for (const row of results) {
    let sub; try { sub = JSON.parse(row.sub); } catch { continue; }
    const items = onlyDueFor ? onlyDueFor(row.tz) : [payload];
    for (const item of items) {
      if (item.key) {
        const dup = await env.DB.prepare("SELECT 1 FROM sent WHERE key = ?").bind(`${row.id}:${item.key}`).first();
        if (dup) continue;
        await env.DB.prepare("INSERT OR IGNORE INTO sent (key, at) VALUES (?, ?)").bind(`${row.id}:${item.key}`, new Date().toISOString()).run();
      }
      try {
        const r = await sendPush(env, sub, { title: item.title, body: item.body, tag: item.key || "hub-test", url: item.url || "./#cal" });
        if (r.gone) { await env.DB.prepare("DELETE FROM subs WHERE id = ?").bind(row.id).run(); dropped++; break; }
        if (r.ok) sent++;
      } catch (e) { console.log("push failed", e.message); }
    }
  }
  return { sent, dropped, subscribers: results.length };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (url.pathname === "/health") return json({ ok: true, push: pushReady(env) });
    if (url.pathname !== "/docs" && !url.pathname.startsWith("/push/")) return json({ error: "not found" }, 404);
    if (!env.HUB_SECRET) return json({ error: "server has no HUB_SECRET set" }, 500);
    if (!same(req.headers.get("x-hub-secret"), env.HUB_SECRET)) return json({ error: "wrong secret word" }, 401);

    if (url.pathname.startsWith("/push/")) {
      await ensureTables(env);
      if (url.pathname === "/push/key") return json({ key: env.VAPID_PUBLIC || "", ready: pushReady(env) });
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      let body; try { body = await req.json(); } catch { body = {}; }
      if (url.pathname === "/push/subscribe") {
        const s = body.subscription; if (!s?.endpoint || !s.keys?.p256dh || !s.keys?.auth) return json({ error: "subscription needs endpoint + keys" }, 400);
        const tz = typeof body.tz === "string" && body.tz.length < 64 ? body.tz : "UTC";
        await env.DB.prepare("INSERT INTO subs (id, sub, tz, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET sub = excluded.sub, tz = excluded.tz").bind(await subId(s.endpoint), JSON.stringify(s), tz, new Date().toISOString()).run();
        return json({ ok: true, ready: pushReady(env) });
      }
      if (url.pathname === "/push/unsubscribe") {
        if (!body.endpoint) return json({ error: "endpoint required" }, 400);
        await env.DB.prepare("DELETE FROM subs WHERE id = ?").bind(await subId(body.endpoint)).run();
        return json({ ok: true });
      }
      if (url.pathname === "/push/test") {
        if (!pushReady(env)) return json({ error: "VAPID keys are not set on the server" }, 500);
        return json({ ok: true, ...(await broadcast(env, { title: "Hub", body: "Reminders reach this device even when Hub is closed." })) });
      }
      return json({ error: "not found" }, 404);
    }

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

  // Cron: every 5 minutes, send the reminders that are due in each subscriber's time zone.
  async scheduled(event, env, ctx) {
    if (!pushReady(env) || !env.HUB_SECRET) return;
    await ensureTables(env);
    const events = await allEvents(env), now = new Date(), goals = await docsWithPrefix(env, "goal:");
    const cfg = (await docsWithPrefix(env, "settings:notify"))[0] || {};
    ctx.waitUntil((async () => {
      const r = await broadcast(env, null, { onlyDueFor: tz => [...dueReminders(events, tz, now), ...goalDigest(goals, cfg, tz, now)] });
      await env.DB.prepare("DELETE FROM sent WHERE at < ?").bind(new Date(Date.now() - 3 * 864e5).toISOString()).run();
      console.log("reminders", JSON.stringify(r));
    })());
  },
};
