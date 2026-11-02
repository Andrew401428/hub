// Web Push from a Cloudflare Worker with nothing but WebCrypto.
// VAPID (RFC 8292) signs a short JWT with the server's P-256 key; the payload is
// encrypted with aes128gcm (RFC 8291) for the browser's subscription keys.

const te = new TextEncoder();
export const b64u = {
  enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); },
};
const concat = (...parts) => { const n = parts.reduce((k, p) => k + p.byteLength, 0), out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(new Uint8Array(p), o); o += p.byteLength; } return out; };

async function hkdf(salt, ikm, info, bits) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits));
}

// VAPID keys as produced by `npx web-push generate-vapid-keys`: public = 65-byte
// uncompressed point, private = 32-byte scalar, both base64url.
async function vapidJwt(pub, priv, aud, subject) {
  const p = b64u.dec(pub);
  const jwk = { kty: "EC", crv: "P-256", x: b64u.enc(p.slice(1, 33)), y: b64u.enc(p.slice(33, 65)), d: priv, ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u.enc(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u.enc(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(head + "." + body));
  return `${head}.${body}.${b64u.enc(sig)}`;
}

async function encrypt(sub, plaintext) {
  const uaPub = b64u.dec(sub.keys.p256dh), auth = b64u.dec(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const prk = await hkdf(auth, shared, concat(te.encode("WebPush: info\0"), uaPub, asPub), 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, prk, te.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(salt, prk, te.encode("Content-Encoding: nonce\0"), 96);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = concat(te.encode(plaintext), new Uint8Array([2]));   // 0x02 = last record
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, padded));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

// Returns {ok, status, gone} — gone = the subscription is dead and should be deleted.
export async function sendPush(env, sub, payload) {
  const url = new URL(sub.endpoint), aud = url.origin;
  const subject = env.VAPID_SUBJECT || "https://andrew401428.github.io/hub/";
  const jwt = await vapidJwt(env.VAPID_PUBLIC, env.VAPID_PRIVATE, aud, subject);
  const body = await encrypt(sub, JSON.stringify(payload));
  const r = await fetch(sub.endpoint, { method: "POST", headers: { Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`, "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high" }, body });
  return { ok: r.ok, status: r.status, gone: r.status === 404 || r.status === 410 };
}

// ---- reminder schedule (mirrors occurrences() + checkReminders() in index.html) ----
const pad = n => String(n).padStart(2, "0");
const ymdUTC = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return ymdUTC(d); };
const addMonth = s => { const d = parse(s); d.setUTCMonth(d.getUTCMonth() + 1); return ymdUTC(d); };

export function occurrences(events, from, to) {
  const out = [];
  for (const ev of events) {
    if (!ev || !ev.date) continue;
    if (!ev.repeat || ev.repeat === "none") { if (ev.date >= from && ev.date <= to) out.push({ ev, date: ev.date }); continue; }
    let d = ev.date, guard = 0;
    while (d <= to && guard++ < 800) {
      if (d >= from && (!ev.until || d <= ev.until)) out.push({ ev, date: d });
      if (ev.until && d > ev.until) break;
      d = ev.repeat === "daily" ? addDays(d, 1) : ev.repeat === "weekly" ? addDays(d, 7) : ev.repeat === "biweekly" ? addDays(d, 14) : addMonth(d);
    }
  }
  return out;
}

// Local wall-clock in an IANA zone as {ymd, minutes}.
export function localNow(tz, at = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
    const g = k => parts.find(p => p.type === k)?.value;
    return { ymd: `${g("year")}-${g("month")}-${g("day")}`, minutes: Number(g("hour")) * 60 + Number(g("minute")) };
  } catch { return { ymd: ymdUTC(at), minutes: at.getUTCHours() * 60 + at.getUTCMinutes() }; }
}

const fmtTime = t => { const [h, m] = t.split(":").map(Number); return `${((h + 11) % 12) + 1}:${pad(m)} ${h >= 12 ? "pm" : "am"}`; };

// Reminders that should fire now (within a 10-minute window) for one subscriber's zone.
export function dueReminders(events, tz, now = new Date()) {
  const { ymd, minutes } = localNow(tz, now), due = [];
  for (const { ev, date } of occurrences(events, addDays(ymd, -1), addDays(ymd, 1))) {
    if (ev.remind == null || ev.remind < 0 || !ev.start) continue;
    const [h, m] = ev.start.split(":").map(Number);
    const dayDiff = (parse(date) - parse(ymd)) / 864e5;
    const fireAt = dayDiff * 1440 + h * 60 + m - ev.remind, delta = minutes - fireAt;
    if (delta >= 0 && delta < 10) due.push({ key: `${ev.id}@${date}`, title: ev.title, body: `${fmtTime(ev.start)}${ev.loc ? " · " + ev.loc : ""}${ev.remind ? " (in " + ev.remind + " min)" : ""}`, id: ev.id });
  }
  return due;
}
