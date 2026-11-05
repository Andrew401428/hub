// Hub service worker: opens instantly from the saved copy, checks GitHub for a newer version in the
// background, and tells the page when one is ready (the page shows "Update ready" with a Reload button).
// Never caches sync calls (other origins). Shows Web Push reminders.
const CACHE = "hub-v5";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./icon-180.png", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });

const verOf = t => (t && t.match(/APP_VERSION = "([\d.]+)"/) || [])[1] || null;
const isPage = req => req.mode === "navigate" || /\/(index\.html)?$/.test(new URL(req.url).pathname);

// Fetch the newest copy (no-cache = ask GitHub whether it changed), store it, and tell open pages
// when the app version moved.
async function refresh(req, key) {
  const c = await caches.open(CACHE);
  const r = await fetch(req, { cache: "no-cache" });
  if (!r.ok || r.redirected) return r;
  if (key === "./index.html") {
    const old = await c.match(key), oldV = old ? verOf(await old.clone().text()) : null, newV = verOf(await r.clone().text());
    await c.put(key, r.clone());
    if (oldV && newV && oldV !== newV) (await self.clients.matchAll({ type: "window" })).forEach(w => w.postMessage({ type: "hub-update", v: newV }));
  } else await c.put(req, r.clone());
  return r;
}

self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin) return;
  const key = isPage(req) ? "./index.html" : req;
  e.respondWith((async () => {
    const hit = await caches.match(key, { ignoreSearch: true });
    if (hit) { e.waitUntil(refresh(req, key).catch(() => {})); return hit; }   // instant open, update in the background
    try { return await refresh(req, key); }
    catch { return (await caches.match("./index.html")) || Response.error(); }
  })());
});
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Hub", body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Hub", { body: d.body || "", tag: d.tag || undefined, icon: "./icon-192.png", badge: "./icon-192.png", data: { url: d.url || "./" }, renotify: false }));
});
self.addEventListener("notificationclick", e => { e.notification.close(); const url = (e.notification.data && e.notification.data.url) || "./"; e.waitUntil(clients.matchAll({ type: "window" }).then(ws => ws.length ? (ws[0].focus(), ws[0].navigate ? ws[0].navigate(url).catch(() => {}) : null) : clients.openWindow(url))); });
