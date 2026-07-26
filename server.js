/* ============================================================
   STAYCATION HAVEN PH — NODE.JS SERVER (Express + EJS)
   ------------------------------------------------------------
   - Renders every page as a server-side EJS template.
   - Serves a shared data backend (lib/store.js) over a small
     REST API at /api/kv/:key, replacing per-browser localStorage.
   - On each page load it injects the current data as window.__SEED__
     and loads /js/seed-bridge.js, so all the existing client-side
     code keeps working — but the data is now shared across devices.

   Run:  npm install  &&  npm start      (then open http://localhost:3000)
   ============================================================ */
"use strict";

const express = require("express");
const path = require("path");
const store = require("./lib/store");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.json({ limit: "25mb" })); // QR images are base64 data URLs → allow large bodies

// On serverless hosts (e.g. Vercel) there is no long-lived process, so make sure
// the data store is initialised before the first request. The promise is cached,
// so init() actually runs only once per warm instance.
let _storeReady = null;
function ensureStore() {
  // Don't cache a REJECTED init promise. A transient store/Firestore failure on one cold start
  // would otherwise poison this warm instance forever — every later request awaits the same
  // rejection and returns 500. Clearing it on failure lets the next request retry (self-heal).
  if (!_storeReady) _storeReady = store.init().catch((err) => { _storeReady = null; throw err; });
  return _storeReady;
}
app.use((req, res, next) => {
  ensureStore().then(() => next()).catch(next);
});

// Allow the old file:// page (and any device) to push data to the API.
app.use("/api", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------------- Sessions (server-side auth, 2026-07-18) ----------------
   Login used to be checked IN THE BROWSER against a user list the browser had
   already been handed — so the login screen protected nothing: anyone could
   open /admin/<page> logged out and read every guest's details (and every
   password) from the page source. Now the server verifies credentials and
   issues a signed httpOnly cookie; protected pages redirect to the login page
   when the cookie is absent/invalid, and the data seed is never injected for
   anonymous visitors. Locked out? Run node tools/reset-admin.js (needs the
   service-account key), then log in again. */
const crypto = require("crypto");
const { hashPw, verifyPw, isHashed } = require("./lib/pw");
const SESSION_COOKIE = "shph_sess";
const SESSION_DAYS = 30;
// Cookie-signing secret: SESSION_SECRET env if set; else derived from the Firebase service
// account (stable across serverless instances, no extra env var to manage); else a random
// per-boot secret (local dev without creds — sessions just reset on restart).
const SESSION_SECRET = process.env.SESSION_SECRET
  || (process.env.FIREBASE_SERVICE_ACCOUNT
      ? crypto.createHash("sha256").update("shph-sess:" + process.env.FIREBASE_SERVICE_ACCOUNT).digest("hex")
      : crypto.randomBytes(32).toString("hex"));

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sign = (data) => crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");

function makeSessionCookie(payload) {
  const body = b64u(JSON.stringify({ ...payload, exp: Date.now() + SESSION_DAYS * 864e5 }));
  return body + "." + sign(body);
}
function readSession(req) {
  const raw = String(req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(SESSION_COOKIE + "="));
  if (!raw) return null;
  const val = raw.slice(SESSION_COOKIE.length + 1);
  const dot = val.lastIndexOf(".");
  if (dot < 1) return null;
  const body = val.slice(0, dot), mac = val.slice(dot + 1);
  const expect = sign(body);
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return (s && s.exp > Date.now()) ? s : null;
  } catch (e) { return null; }
}
function setSessionCookie(req, res, payload) {
  const secure = (req.headers["x-forwarded-proto"] || req.protocol) === "https" ? "; Secure" : "";
  res.append("Set-Cookie",
    `${SESSION_COOKIE}=${makeSessionCookie(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
function clearSessionCookie(res) {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// A back-office session (staff or partner) has FULL data access. An AFFILIATE portal session is
// deliberately NOT "full": it may reach only its own /api/affiliate/* endpoints and never the shared
// KV / list data (bookings, users, partners…). Keep these two ideas separate everywhere below.
const isFullSession = (req) => { const s = readSession(req); return !!(s && (s.t === "staff" || s.t === "partner")); };
const affiliateSession = (req) => { const s = readSession(req); return (s && s.t === "affiliate") ? s : null; };

// Staff login. Verifies against the LIVE user list server-side; the list never goes to the
// browser. Bootstrap rule preserved from the old client flow: if NO admin exists yet, a
// non-empty username with password "1234" creates the first admin account.
app.post("/api/login", async (req, res) => {
  try {
    const username = String((req.body || {}).username || "").trim();
    const password = String((req.body || {}).password || "");
    if (!username || !password) return res.status(400).json({ ok: false, error: "missing credentials" });
    let users = [];
    try { users = await store.readFreshList("shph_users"); } catch (e) { users = store.get("shph_users") || []; }
    if (!Array.isArray(users)) users = [];
    let match = users.find(u => u && (u.name || "").toLowerCase() === username.toLowerCase()
      && verifyPw(password, u.password));
    if (!match && !users.some(u => u && u.admin) && password === "1234") {
      const nextId = (users.reduce((m, u) => Math.max(m, Number(u && u.id) || 0), 0) || 0) + 1;
      match = { id: nextId, name: username, password: hashPw("1234"), admin: true, perms: [] };
      await store.upsertOne("shph_users", match);
    }
    // lazy migration: a legacy plain-text password that just verified is upgraded to a hash
    if (match && !isHashed(match.password)) {
      try { await store.upsertOne("shph_users", { ...match, password: hashPw(password) }); } catch (e) {}
    }
    if (!match) return res.status(401).json({ ok: false, error: "invalid login" });
    setSessionCookie(req, res, { t: "staff", u: match.name, adm: !!match.admin });
    res.json({ ok: true, name: match.name, admin: !!match.admin, perms: match.perms || [] });
  } catch (e) {
    console.error("[auth] login failed:", e.message);
    res.status(500).json({ ok: false, error: "login failed" });
  }
});

// Partner login (property partners) — same server-side check against the partner list.
// An admin staff account also passes here as a partner "super admin" (sees every haven),
// replacing the old hardcoded client-side super-admin credentials.
app.post("/api/partner-login", async (req, res) => {
  try {
    const username = String((req.body || {}).username || "").trim();
    const password = String((req.body || {}).password || "");
    if (!username || !password) return res.status(400).json({ ok: false, error: "missing credentials" });
    let users = [];
    try { users = await store.readFreshList("shph_users"); } catch (e) { users = store.get("shph_users") || []; }
    const admin = (Array.isArray(users) ? users : []).find(u => u && u.admin
      && (u.name || "").toLowerCase() === username.toLowerCase() && verifyPw(password, u.password));
    if (admin) {
      setSessionCookie(req, res, { t: "partner", u: admin.name, sa: true });
      return res.json({ ok: true, session: { name: admin.name, login: admin.name, superAdmin: true } });
    }
    let partners = [];
    try { partners = await store.readFreshList("shph_partners"); } catch (e) { partners = store.get("shph_partners") || []; }
    const p = (Array.isArray(partners) ? partners : []).find(x => x
      && (x.login || "").trim() !== ""
      && (x.login || "").toLowerCase() === username.toLowerCase()
      && verifyPw(password, x.pw || ""));
    if (!p) return res.status(401).json({ ok: false, error: "invalid login" });
    if (!p.haven) return res.status(403).json({ ok: false, error: "no haven assigned" });
    setSessionCookie(req, res, { t: "partner", u: p.name || p.login, haven: p.haven, pid: p.id });
    res.json({ ok: true, session: { id: p.id, name: p.name, login: p.login, haven: p.haven } });
  } catch (e) {
    console.error("[auth] partner login failed:", e.message);
    res.status(500).json({ ok: false, error: "login failed" });
  }
});

// Affiliate portal login. Affiliates have no password on file — they log in with their personal
// referral CODE (username) + the CONTACT NUMBER captured on their application (verified server-side).
// Numbers are compared on their trailing 10 digits so +63/0 prefixes and spacing don't matter.
app.post("/api/affiliate-login", async (req, res) => {
  try {
    const code = String((req.body || {}).code || "").trim();
    const contact = String((req.body || {}).contact || "").trim();
    if (!code || !contact) return res.status(400).json({ ok: false, error: "missing credentials" });
    let list = [];
    try { list = await store.readFreshList("shph_affiliates_v1"); } catch (e) { list = store.get("shph_affiliates_v1") || []; }
    const codeKey = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const phone10 = p => String(p || "").replace(/\D/g, "").slice(-10);
    const want = phone10(contact);
    const a = (Array.isArray(list) ? list : []).find(x => x && !x.deleted
      && codeKey(x.code) === codeKey(code)
      && want && phone10(x.contact) === want);
    if (!a) return res.status(401).json({ ok: false, error: "invalid code or number" });
    setSessionCookie(req, res, { t: "affiliate", aid: a.id, code: a.code });
    res.json({ ok: true, name: a.name, code: a.code });
  } catch (e) {
    console.error("[auth] affiliate login failed:", e.message);
    res.status(500).json({ ok: false, error: "login failed" });
  }
});

app.post("/api/logout", (req, res) => { clearSessionCookie(res); res.json({ ok: true }); });
app.get("/api/logout", (req, res) => { clearSessionCookie(res); res.redirect("/admin"); });

/* ---------------- REST API (the shared backend) ---------------- */
const apiRouter = express.Router();

/* ---- API auth gate (Stage 2, 2026-07-18). Everything requires a session EXCEPT the narrow
   set the public guest flow genuinely needs. Before this, anyone could GET the full bookings
   list (guest names, mobiles, payments) or write records anonymously. The allowlist:
   - POST /visit             (public visit counter)
   - POST /send-confirmation (guest booking confirmation email)
   - POST /apply             (partner/affiliate application form)
   - POST /list/…            (guest booking write — hardened per-route below)
   - /backup, /restore       (guarded by their own CRON_SECRET / token, no cookie on a cron)
   Everything else without a valid session cookie → 401. */
apiRouter.use((req, res, next) => {
  if (req.method === "OPTIONS") return next();
  const p = req.path;
  // Affiliate portal sessions are scoped: they reach ONLY their own /affiliate/* endpoints. For
  // everything else an affiliate is treated as anonymous (falls through to the public allowlist),
  // so a portal login can never read bookings/users or write to shared lists as a staff user would.
  if (affiliateSession(req)) {
    if (p.startsWith("/affiliate/")) return next();
  } else if (readSession(req)) {
    return next();   // staff / partner → full back-office access
  }
  if (req.method === "POST" && (p === "/visit" || p === "/send-confirmation" || p === "/apply")) return next();
  if (req.method === "POST" && p.startsWith("/list/")) return next();   // per-route hardening below
  if (p === "/backup" || p === "/restore" || p === "/retention") return next();  // own token guards
  return res.status(401).json({ error: "login required" });
});

// REMOVED: POST /api/import (2026-07-17 audit).
// It took { key: value, … } and called store.set() — a FULL OVERWRITE that bypassed the mergeById
// guards every other write path relies on. With no authentication in front of it, a single
// unauthenticated request could erase every booking, or replace shph_users to grant admin. It also
// reported { ok: true } even when the write failed, because store.set() swallows backend errors.
// Nothing in the app ever called it. Restores go through POST /api/restore (token-guarded) instead.

// Keys that hold credentials — never served to a request without a valid session.
// (Full API gating is a later stage; the public booking flow still needs the other keys.)
const SESSION_ONLY_KEYS = new Set(["shph_users", "shph_partners"]);

// Read every shared key at once — the whole database, so session-only.
// It also has to honour ADMIN_ONLY_KEYS: a session alone is NOT enough. Any logged-in staff or
// partner could fetch("/api/kv") and read the owner's private notes and the guest-guide QR
// tokens, even though GET /kv/:key refuses them one by one.
apiRouter.get("/kv", (req, res) => {
  if (!readSession(req)) return res.status(401).json({ error: "login required" });
  const out = store.all();   // a fresh wrapper object (values are live refs) — deleting a key here
  if (!isAdminSession(req)) {                                                  // never touches the cache
    ADMIN_ONLY_KEYS.forEach(k => { delete out[k]; });
    if (out.shph_settings) out.shph_settings = stripWifi(out.shph_settings);   // guest-guide WiFi: admin only
  }
  res.json(out);
});

// read one key
apiRouter.get("/kv/:key", async (req, res) => {
  const key = req.params.key;
  if (!store.isShared(key)) return res.status(404).json({ error: "unknown key" });
  if (SESSION_ONLY_KEYS.has(key) && !readSession(req)) return res.status(401).json({ error: "login required" });
  if (ADMIN_ONLY_KEYS.has(key) && !isAdminSession(req)) return res.status(403).json({ error: "admin only" });
  // For id-keyed list stores (bookings, etc.) read the LIVE Firestore doc, not this
  // serverless instance's in-memory cache — a warm instance can hold a stale copy that
  // is missing a record saved via another instance (e.g. a website booking), which is
  // exactly how a real booking "doesn't show up" on the dashboard. Fall back to cache.
  if (MERGE_LIST_KEYS.has(key)) {
    try { return res.json(await store.readFreshList(key)); }
    catch (e) { console.warn("[api] fresh read failed for", key, "—", e.message); }
  }
  // the housekeeping log must be live too (object key — not in the list set above)
  if (key === "shph_cleaning_v1") {
    try { return res.json(await store.readFreshKey(key)); }
    catch (e) { console.warn("[api] fresh read failed for", key, "—", e.message); }
  }
  // the guest-guide WiFi rides inside shph_settings — admin browsers only (see stripWifi)
  if (key === "shph_settings" && !isAdminSession(req)) return res.json(stripWifi(store.get(key)));
  res.json(store.get(key));
});

// Id-keyed list stores that are merged per-item on save (multi-user safe + never erased).
// Only stores whose items have a stable unique `id` belong here — merging an id-less list
// would DROP records. (cleaning = object keyed by room; poolpass = no id → NOT here.)
const MERGE_LIST_KEYS = new Set([
  "shph_bookings_v3", "shph_bills_v1", "shph_expenses_v1",
  "shph_users", "shph_staff_v1", "staycation_havens", "shph_partners",
  // violation records carry a uid() id, and seed-bridge already lists this in its MERGE_KEYS —
  // the two must match, or a whole-array push here would overwrite instead of merge.
  "shph_violations_v1",
  "shph_applications_v1",  // partner/affiliate applications (id-keyed; written via /api/apply + /api/list)
  "shph_affiliates_v1",    // approved affiliates: personal code + credit ledger (session-gated writes)
  "shph_notes_v1",         // owner's private notes (admin-only; see ADMIN_ONLY_KEYS)
  // Activity log = employee audit trail. Every device's entries must survive, so it MERGES here
  // (store.js gives it a special content-key merge so even legacy id-less entries are never dropped
  // and it's trimmed to a safe size). Was a plain whole-array write → concurrent devices (Nicole,
  // Jedd, Piaganda…) silently overwrote each other's entries. seed-bridge merges it on load too.
  "shph_activity_log"
]);

// Keys only an ADMIN session may read/write. The owner's private notes must never reach a
// staff or partner browser — not through the API, and not inside a page's data seed.
// shph_stay_tokens_v1 holds the guest-guide QR SECRETS: anyone holding a token can open
// /stay/<token> during a stay, so it is admin-only for the same reason (and it is deliberately
// NOT in PUBLIC_SEED_KEYS, so no guest page ever ships it).
const ADMIN_ONLY_KEYS = new Set(["shph_notes_v1", "shph_stay_tokens_v1"]);
const isAdminSession = (req) => { const s = readSession(req); return !!(s && s.t === "staff" && s.adm); };

// write one key (body is the raw JSON value the browser stored)
apiRouter.put("/kv/:key", async (req, res) => {
  if (!store.isShared(req.params.key)) return res.status(403).json({ error: "key not shared" });
  if (SESSION_ONLY_KEYS.has(req.params.key) && !readSession(req)) return res.status(401).json({ error: "login required" });
  if (ADMIN_ONLY_KEYS.has(req.params.key) && !isAdminSession(req)) return res.status(403).json({ error: "admin only" });
  // Passwords are stored HASHED. The Users/Partners pages still send plain text when one is
  // set or changed — hash it here before it ever touches the store; already-hashed values
  // round-trip untouched (so editing a user's name/perms never invalidates their password).
  if (req.params.key === "shph_users" && Array.isArray(req.body)) {
    req.body.forEach(u => { if (u && u.password != null && u.password !== "" && !isHashed(u.password)) u.password = hashPw(u.password); });
  }
  if (req.params.key === "shph_partners" && Array.isArray(req.body)) {
    req.body.forEach(p => { if (p && p.pw != null && p.pw !== "" && !isHashed(p.pw)) p.pw = hashPw(p.pw); });
  }
  // settings.wifi holds the per-haven guest-guide WiFi and is stripped from every NON-ADMIN
  // browser's seed. That browser would otherwise save the whole settings object back without it
  // and silently wipe it — so keep the stored copy whenever the incoming one carries none.
  // Only an ADMIN may write it. A non-admin's copy never contains wifi, so we always restore the
  // stored value over whatever they sent — dropping it protects an honest staff save from wiping the
  // passwords, and IGNORING it stops a crafted PUT that carries a wifi object of its own. Guarding
  // only the "absent" case would leave that second door wide open.
  if (req.params.key === "shph_settings" && req.body && typeof req.body === "object" && !Array.isArray(req.body)
      && (!isAdminSession(req) || !req.body.wifi)) {
    let cur = null;
    try { cur = await store.readFreshKey("shph_settings"); } catch (e) { cur = store.get("shph_settings"); }
    if (cur && cur.wifi) req.body.wifi = cur.wifi; else delete req.body.wifi;
  }
  try {
    // The housekeeping log is an OBJECT map (bookingId → entry) and is the record cleaners are PAID
    // from. A whole-map PUT — e.g. a legacy queued write replayed by an old tab — would REPLACE it
    // and erase every booking's photos and history, so merge it entry by entry instead (same rule
    // as POST /api/cleaning/:bookingId). It must never reach the plain setStrict below.
    if (req.params.key === "shph_cleaning_v1" && req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
      await store.mergeCleaningMap(req.body);
      return res.json({ ok: true });
    }
    if (MERGE_LIST_KEYS.has(req.params.key) && Array.isArray(req.body)) {
      // ATOMIC per-item merge against the LIVE doc (transaction): two users saving at once
      // never overwrite each other, and a stale cache can't drop another instance's records.
      await store.mergeListWrite(req.params.key, req.body);
    } else {
      // durable write: only report success once the backend confirms, so the client retries.
      await store.setStrict(req.params.key, req.body);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[api] PUT /kv/" + req.params.key + " failed to persist:", e.message);
    res.status(502).json({ ok: false, error: "persist failed" });
  }
});

// ---- website visit counter — records a unique visit (deduped once/day per browser, client-side) ----
apiRouter.post("/visit", async (req, res) => {
  try {
    let v = await store.readFreshKey("shph_visits");
    if (!v || typeof v !== "object" || Array.isArray(v)) v = { total: 0, days: {} };
    if (!v.days || typeof v.days !== "object") v.days = {};
    const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);   // Philippine calendar day (UTC+8)
    v.total = (Number(v.total) || 0) + 1;
    v.days[day] = (Number(v.days[day]) || 0) + 1;
    const keep = Object.keys(v.days).sort().slice(-180);   // bound the daily history
    const trimmed = {}; for (const d of keep) trimmed[d] = v.days[d];
    v.days = trimmed;
    await store.set("shph_visits", v);
    res.set("Cache-Control", "no-store");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
apiRouter.get("/visits", async (req, res) => {
  try {
    let v = await store.readFreshKey("shph_visits");
    if (!v || typeof v !== "object" || Array.isArray(v)) v = { total: 0, days: {} };
    res.set("Cache-Control", "no-store");
    res.json({ total: Number(v.total) || 0, days: v.days || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// store ONE photo and return a tiny /img/<id> link. The browser calls this the moment a
// photo is attached, then saves only the link inside the booking — so the bookings payload
// stays small and never overflows the host's request-size limit (the cause of lost saves).
apiRouter.post("/img", async (req, res) => {
  try {
    const data = req.body && req.body.data;
    if (!data || typeof data !== "string") return res.status(400).json({ error: "no image data" });
    const id = await store.putImage(data);
    if (!id) return res.json({ url: null });   // file backend → no offload; client keeps the base64
    res.json({ id, url: "/img/" + id });
  } catch (e) {
    console.error("[api] POST /img failed:", e.message);
    res.status(502).json({ error: "image store failed" });
  }
});

/* ---------------- Daily backup + restore (off-site safety net) ---------------- */
// Guards the backup/restore endpoints. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`;
// a manual call may pass ?token=<BACKUP_TOKEN>. If NEITHER secret is configured we allow (so it
// works out of the box) but warn — set BACKUP_TOKEN and/or CRON_SECRET to lock these down.
function backupAuthorized(req) {
  const secret = process.env.BACKUP_TOKEN || process.env.CRON_SECRET || "";
  if (!secret) { console.warn("[backup] no BACKUP_TOKEN/CRON_SECRET set — backup endpoints are UNPROTECTED"); return true; }
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const token = (req.query && req.query.token) || bearer || (req.body && req.body.token) || "";
  return token === secret;
}

// email the off-site copy to the owner (best-effort; skipped if Gmail isn't configured)
async function emailBackup(snap) {
  const user = process.env.GMAIL_USER || "staycationhavenph@gmail.com";
  const pass = process.env.GMAIL_APP_PASSWORD || process.env.EMAIL_PASSWORD;
  if (!pass) return { ok: false, error: "email_not_configured" };
  let nodemailer;
  try { nodemailer = require("nodemailer"); } catch (e) { return { ok: false, error: "nodemailer_missing" }; }
  const to = process.env.BACKUP_EMAIL || process.env.OWNER_EMAIL || user;
  const json = JSON.stringify(snap, null, 2);
  const counts = Object.keys(snap.data || {}).map(k => {
    const v = snap.data[k];
    const n = Array.isArray(v) ? v.length : (v && typeof v === "object" ? Object.keys(v).length : (v != null ? 1 : 0));
    return `  ${k}: ${n}`;
  }).join("\n");
  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  await transporter.sendMail({
    from: `"Staycation Haven PH — Backup" <${user}>`,
    to,
    subject: `Daily backup — ${snap.meta.day}`,
    text: `Automatic off-site backup of Staycation Haven PH.\n\nTaken: ${snap.meta.at}\nProject: ${snap.meta.project || "—"}\n\nRecords:\n${counts}\n\nThe full data is attached as JSON. Keep it somewhere safe (Google Drive, etc.).`,
    attachments: [{ filename: `shph-backup-${snap.meta.day}.json`, content: json, contentType: "application/json" }]
  });
  return { ok: true, to };
}

// Vercel Cron hits this daily: writes a full restore point to Firestore, then emails an off-site copy.
apiRouter.all("/backup", async (req, res) => {
  if (!backupAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const backup = await store.backupAll();
    let email = { ok: false, error: "skipped" };
    if (req.query.email !== "0") {
      try { email = await emailBackup(await store.snapshot()); }
      catch (e) { email = { ok: false, error: e.message }; }
    }
    res.set("Cache-Control", "no-store");
    res.json({ ok: !!backup.ok, backup, email });
  } catch (e) {
    console.error("[backup] failed:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// download the full off-site copy as a JSON file (token-guarded — it contains guest PII)
apiRouter.get("/backup/download", async (req, res) => {
  if (!backupAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const snap = await store.snapshot();
    res.set("Content-Type", "application/json; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="shph-backup-${snap.meta.day}.json"`);
    res.set("Cache-Control", "no-store");
    res.send(JSON.stringify(snap, null, 2));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// list every available restore point (token-guarded)
apiRouter.get("/backup/list", async (req, res) => {
  if (!backupAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try { res.json({ ok: true, retentionDays: Number(process.env.BACKUP_RETENTION_DAYS) || 30, backups: await store.listBackups() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// restore ONE key from a dated backup (DESTRUCTIVE — token-guarded). Body: { key, day }
apiRouter.post("/restore", async (req, res) => {
  if (!backupAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const { key, day } = req.body || {};
    if (!key || !day) return res.status(400).json({ ok: false, error: "need key and day" });
    const count = await store.restoreKey(key, day);
    res.json({ ok: true, key, day, restored: count });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// quick health/diagnostics — confirms which backend + whether Cloud Storage is active
app.get("/api/health", async (req, res) => {
  try { await ensureStore(); } catch (e) {}
  try { res.json(store.status()); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// friendly, human-readable health page — open /health anytime to confirm data + images are safe
app.get("/health", async (req, res) => {
  try { await ensureStore(); } catch (e) {}
  let s;
  try { s = store.status(); } catch (e) { s = { ok: false, error: e.message }; }
  const green = "#127a3d", red = "#c0283d", gray = "#5b6470";
  const row = (label, value, good) =>
    `<tr><td style="padding:9px 14px;color:${gray};white-space:nowrap">${label}</td>` +
    `<td style="padding:9px 14px;font-weight:700;color:${good == null ? "#1b1f24" : (good ? green : red)}">${value}</td></tr>`;
  const counts = s.counts || {};
  const countRows = Object.keys(counts).map(k => row(k, counts[k], null)).join("");
  const durable = !!s.durable;
  const imgGood = s.images === "cloud-storage";
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Staycation Haven — System Health</title>
<body style="margin:0;font:15px/1.5 system-ui,Segoe UI,Arial,sans-serif;background:#f4f6f8;color:#1b1f24">
<div style="max-width:560px;margin:32px auto;padding:0 16px">
  <h1 style="font-size:20px;margin:0 0 4px">System Health</h1>
  <div style="color:${gray};font-size:13px;margin-bottom:18px">Live check of where your data &amp; photos are stored.</div>
  <div style="background:${durable ? green : red};color:#fff;border-radius:12px;padding:16px 18px;font-weight:700;font-size:16px;margin-bottom:16px">
    ${durable ? "✅ Data is DURABLE — saved permanently to Firestore." : "🚨 NOT DURABLE — running on temporary file storage. Data can be lost on restart! Set FIREBASE_SERVICE_ACCOUNT."}
  </div>
  <div style="background:#fff;border:1px solid #e3e7ec;border-radius:12px;overflow:hidden">
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      ${row("Backend", s.backend || "?", durable)}
      ${row("Firebase project", s.project || "—", null)}
      ${row("Image storage", s.images === "cloud-storage" ? "Cloud Storage (unlimited)" : "Firestore fallback (1 MB cap ⚠️)", imgGood)}
      ${row("Storage bucket", s.bucket || "—", null)}
      <tr><td colspan="2" style="padding:12px 14px 4px;color:${gray};font-size:12px;text-transform:uppercase;letter-spacing:.04em">Records stored right now</td></tr>
      ${countRows}
      ${row("Checked at", s.at || "", null)}
    </table>
  </div>
  <div style="color:${gray};font-size:12px;margin-top:14px">Refresh this page anytime. Green = your data and photos are safe on the server.</div>
</div>`;
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// stream a stored image by id (Cloud Storage, or the legacy Firestore doc).
// Image refs in the data are served as /img/<id> so payloads stay tiny.
app.get("/img/:id", async (req, res) => {
  try {
    await ensureStore();
    const img = await store.getImage(req.params.id);
    if (!img) return res.status(404).send("image not found");
    res.set("Content-Type", img.contentType || "application/octet-stream");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(img.buffer);
  } catch (e) {
    console.error("[api] GET /img/" + req.params.id + " failed:", e.message);
    res.status(500).send("error");
  }
});

// delete one key (resets it)
apiRouter.delete("/kv/:key", async (req, res) => {
  if (!store.isShared(req.params.key)) return res.status(403).json({ error: "key not shared" });
  // Deleting a shared key WIPES live data (and wiping shph_users would let the login bootstrap
  // recreate an admin with password "1234" → takeover). ADMIN ONLY — a partner/staff session
  // (or an affiliate) must never be able to reset the database.
  if (!isAdminSession(req)) return res.status(403).json({ error: "admin only" });
  await store.remove(req.params.key);
  res.json({ ok: true });
});

// PER-RECORD payment write — appends (or edits) ONE payment on ONE booking, transactionally.
// This is the fix for the whole-array overwrite: the request only ever touches this booking, so
// collecting a payment can NEVER wipe another booking's data. The proof photo should already be
// a tiny /img ref (the browser offloads it via POST /api/img first). updateOneFresh reads the
// live doc inside a Firestore transaction and stamps updatedAt, so concurrent edits are safe.
apiRouter.post("/booking/:id/payment", async (req, res) => {
  const KEY = "shph_bookings_v3";
  const id = req.params.id;
  const payment = req.body && req.body.payment;
  const editIndex = (req.body && req.body.editIndex != null) ? Number(req.body.editIndex) : null;
  const deleteIndex = (req.body && req.body.deleteIndex != null) ? Number(req.body.deleteIndex) : null;
  const editId = req.body && req.body.editId;      // stable payment id (pid) — match by this, not array position
  const deleteId = req.body && req.body.deleteId;  // so a concurrent add elsewhere can't shift the target
  const isDelete = (deleteId != null || deleteIndex != null);
  if ((!payment || typeof payment !== "object") && !isDelete) return res.status(400).json({ error: "no payment" });
  try {
    const ok = await store.updateOneFresh(KEY, id, b => {
      b.payments = Array.isArray(b.payments) ? b.payments : [];
      if (isDelete) {                                                     // remove one collection
        let di = -1;
        if (deleteId != null) di = b.payments.findIndex(p => p && p.pid === deleteId);  // match by stable id
        else if (deleteIndex != null) di = deleteIndex;                   // legacy (no id sent) → position
        // if an id WAS sent but not found, it's already gone → no-op (never index-fallback, which would hit the neighbor)
        if (di >= 0 && b.payments[di]) b.payments.splice(di, 1);
      } else {                                                            // edit or add a collection
        let ei = -1;
        if (editId != null) ei = b.payments.findIndex(p => p && p.pid === editId);      // match by stable id
        else if (editIndex != null) ei = editIndex;                      // legacy (no id sent) → position
        if (ei >= 0 && b.payments[ei]) b.payments[ei] = payment;         // edit the matched collection
        else if (editId == null && editIndex == null) b.payments.push(payment);  // brand-new collection
        // id sent but not found → the payment is gone; do nothing (don't resurrect or duplicate)
      }
    });
    if (!ok) return res.status(404).json({ error: "booking not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[api] booking payment failed:", e.message);
    res.status(502).json({ ok: false, error: "persist failed" });
  }
});

// GENERIC per-record write for id-keyed lists (expenses, bills, etc.): insert/replace ONE
// item, or soft-delete ONE item — transactionally, so adding/editing one record can never
// overwrite the rest of the list. Base64 images in the item (e.g. an expense receipt) are
// offloaded to refs by store.upsertOne.
apiRouter.post("/list/:key", async (req, res) => {
  const key = req.params.key;
  if (!MERGE_LIST_KEYS.has(key)) return res.status(400).json({ error: "not a per-record list" });
  if (ADMIN_ONLY_KEYS.has(key) && !isAdminSession(req)) return res.status(403).json({ error: "admin only" });
  const upsert = req.body && req.body.upsert;   // full item to insert/replace (by id)
  const del = req.body && req.body.del;          // id to soft-delete
  // Anonymous callers (the public booking flow) may ONLY upsert bookings — never delete,
  // never touch other lists — and may never replace a record that staff created: an existing
  // id must belong to a website booking for an unauthenticated overwrite to be accepted.
  // An AFFILIATE portal session counts as non-privileged here (isFullSession, not readSession),
  // so a logged-in affiliate is held to the same booking-only rule as an anonymous guest.
  if (!isFullSession(req)) {
    if (key !== "shph_bookings_v3" || del != null || !upsert || upsert.id == null) {
      return res.status(401).json({ error: "login required" });
    }
    // The incoming record must itself be a website booking, and may NOT arrive already
    // deleted/cancelled. A public visitor knows real booking ids (they're in the page seed), so
    // without this an anonymous POST could flip a paid booking to deleted:true (it vanishes from the
    // dashboard) or cancelled:true (its slot frees for re-sale). The guest create + retry both send a
    // live, website-sourced record, so they're unaffected.
    if (String(upsert.source || "") !== "website" || upsert.deleted === true || upsert.cancelled === true) {
      return res.status(401).json({ error: "login required" });
    }
    try {
      const list = await store.readFreshList(key);
      const existing = (list || []).find(x => x && String(x.id) === String(upsert.id));
      // never overwrite a staff-made record, and never resurrect/flip one already deleted or cancelled
      if (existing && (existing.source !== "website" || existing.deleted === true || existing.cancelled === true)) {
        return res.status(401).json({ error: "login required" });
      }
    } catch (e) { /* fresh read failed → fall through; upsertOne itself is merge-safe */ }
  }
  try {
    if (upsert && upsert.id != null) {
      // hash any plain-text credential on a per-record save too (users/partners)
      if (key === "shph_users" && upsert.password != null && upsert.password !== "" && !isHashed(upsert.password)) upsert.password = hashPw(upsert.password);
      if (key === "shph_partners" && upsert.pw != null && upsert.pw !== "" && !isHashed(upsert.pw)) upsert.pw = hashPw(upsert.pw);
      await store.upsertOne(key, upsert);
    } else if (del != null) {
      const ok = await store.updateOneFresh(key, del, x => { x.deleted = true; if (!x.deletedAt) x.deletedAt = new Date().toISOString(); });
      if (!ok) return res.status(404).json({ error: "item not found" });
    } else {
      return res.status(400).json({ error: "nothing to do" });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[api] POST /list/" + key + " failed:", e.message);
    res.status(502).json({ ok: false, error: "persist failed" });
  }
});

// PER-RECORD deposit-return write — sets/clears the deposit fields on ONE booking,
// transactionally. Same protection as payments: marking a deposit returned can never wipe
// another booking. The refund photo should already be a tiny /img ref (offloaded via /api/img).
apiRouter.post("/booking/:id/deposit", async (req, res) => {
  const KEY = "shph_bookings_v3";
  const id = req.params.id;
  const set = req.body && req.body.set;   // fields to set (e.g. depositReturned + proof + refund)
  const del = req.body && req.body.del;   // field names to delete (for undo)
  if (!set && !del) return res.status(400).json({ error: "nothing to change" });
  try {
    const ok = await store.updateOneFresh(KEY, id, b => {
      if (Array.isArray(del)) del.forEach(k => delete b[k]);
      if (set && typeof set === "object") Object.assign(b, set);
    });
    if (!ok) return res.status(404).json({ error: "booking not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[api] booking deposit failed:", e.message);
    res.status(502).json({ ok: false, error: "persist failed" });
  }
});

// Read a booking's CURRENT guest IDs live from the server, so the editor shows the true saved set
// (a stale browser copy could otherwise show fewer/none — and then overwrite the real ones on save).
apiRouter.get("/booking/:id/ids", async (req, res) => {
  try {
    const arr = await store.readFreshList("shph_bookings_v3");
    const b = Array.isArray(arr) ? arr.find(x => String(x.id) === String(req.params.id)) : null;
    if (!b) return res.status(404).json({ error: "booking not found" });
    res.json({ ids: Array.isArray(b.ids) ? b.ids : [], idOptOut: !!b.idOptOut });
  } catch (e) {
    console.error("[api] GET booking ids failed:", e.message);
    res.status(502).json({ error: "read failed" });
  }
});

// PER-RECORD guest-ID save. Writing the ids the moment they're uploaded (not deferred to the
// whole-booking Save) means a stale whole-array save from another tab/device can't wipe them.
// Photos should already be tiny /img refs (offloaded via /api/img) before being sent here.
apiRouter.post("/booking/:id/ids", async (req, res) => {
  const KEY = "shph_bookings_v3";
  const id = req.params.id;
  const ids = req.body && req.body.ids;
  const idOptOut = req.body && req.body.idOptOut;
  if (!Array.isArray(ids)) return res.status(400).json({ error: "ids must be an array" });
  try {
    const ok = await store.updateOneFresh(KEY, id, b => {
      b.ids = ids;
      if (typeof idOptOut === "boolean") b.idOptOut = idOptOut;
    });
    if (!ok) return res.status(404).json({ error: "booking not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[api] booking ids failed:", e.message);
    res.status(502).json({ ok: false, error: "persist failed" });
  }
});

// PER-RECORD field patch for a booking. Applies ONLY the given fields to the LIVE record inside a
// transaction (Object.assign), so editing a booking's dates/notes/etc. can never wipe fields owned
// by other per-record paths (payments, ids, deposit-return) or clobber another device's edit.
apiRouter.post("/booking/:id/patch", async (req, res) => {
  const KEY = "shph_bookings_v3";
  const id = req.params.id;
  const set = req.body && req.body.set;
  if (!set || typeof set !== "object" || Array.isArray(set)) return res.status(400).json({ error: "nothing to change" });
  try {
    const ok = await store.updateOneFresh(KEY, id, b => { Object.assign(b, set); });
    if (!ok) return res.status(404).json({ error: "booking not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[api] booking patch failed:", e.message);
    res.status(502).json({ ok: false, error: "persist failed" });
  }
});

// PER-ENTRY housekeeping write — saves ONE booking's cleaning log into the shared map,
// transactionally. Replaces the old whole-object kv push, which (a) carried every haven's
// base64 photos so it overflowed the request-size limit and the cleaning work silently never
// saved, and (b) let two cleaners overwrite each other. Photos arrive as tiny /img refs
// (the browser offloads them via POST /api/img first).
// Two shapes, both MERGE-ONLY (the old raw replace is gone — it let any tab holding an older copy
// of an entry delete photos and history it had never seen, wiping most cleaning sessions):
//   { delta: {op:"start"|"done"|"undoStart"|"undoDone"|"addPhoto"|"removePhoto", …, history:{…}} }
//     → current clients: ONE action applied to the LIVE entry inside a transaction.
//   { entry: {…} }
//     → an old browser tab still open after this deploy: merged field-by-field, photos unioned,
//       history appended + deduped. Kept for backward compatibility on purpose.
// Responds with the merged entry so the client can adopt it and self-heal.
apiRouter.post("/cleaning/:bookingId", async (req, res) => {
  const body = req.body || {};
  const delta = body.delta, entry = body.entry;
  const hasDelta = delta && typeof delta === "object" && !Array.isArray(delta);
  const hasEntry = entry && typeof entry === "object" && !Array.isArray(entry);
  if (!hasDelta && !hasEntry) return res.status(400).json({ error: "no delta or entry" });
  try {
    const merged = await store.updateCleaningEntry(String(req.params.bookingId), live =>
      hasDelta ? store.applyCleaningDelta(live, delta) : store.mergeCleaningEntry(live, entry));
    res.json({ ok: true, entry: merged });
  } catch (e) {
    // a malformed/rejected delta is the client's fault (400) — not a persistence failure (502)
    if (hasDelta && /^(unknown cleaning op|.*\bneeds\b)/.test(e.message || "")) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    console.error("[api] cleaning save failed:", e.message);
    res.status(502).json({ ok: false, error: "persist failed" });
  }
});

// LIVE read of one booking's cleaning entry — used before marking DONE, so the "all room photos
// attached?" gate judges the server's truth instead of this browser's page-load-old copy.
apiRouter.get("/cleaning/:bookingId", async (req, res) => {
  try {
    res.json({ ok: true, entry: await store.readCleaningEntry(String(req.params.bookingId)) });
  } catch (e) {
    res.status(502).json({ ok: false, error: "read failed" });
  }
});

/* ---- Partner / affiliate application intake (public recruitment pages). Open by design —
   it's the front door — but hardened: honeypot field drops bots silently, strict field
   allowlist with length caps, and a validated type. Applications land in
   shph_applications_v1 for review on the dashboard's Applications page. */
apiRouter.post("/apply", async (req, res) => {
  try {
    const b = req.body || {};
    if (b.website) return res.json({ ok: true });                    // honeypot: bots fill it, humans never see it
    const type = b.type === "partner" ? "partner" : b.type === "affiliate" ? "affiliate" : null;
    if (!type) return res.status(400).json({ ok: false, error: "invalid type" });
    const s = (v, max) => String(v == null ? "" : v).slice(0, max).trim();
    const app = {
      id: Date.now() * 1000 + Math.floor(Math.random() * 1000),      // collision-safe timestamp id
      type,
      name:    s(b.name, 120),
      contact: s(b.contact, 60),
      email:   s(b.email, 120),
      status:  "new",
      createdAt: new Date().toISOString()
    };
    if (!app.name || !app.contact) return res.status(400).json({ ok: false, error: "name and contact are required" });
    if (type === "partner") {
      app.location   = s(b.location, 200);
      app.unitType   = s(b.unitType, 80);
      app.rooms      = s(b.rooms, 40);
      app.hasCleaner = b.hasCleaner === "yes" ? "yes" : "no";
      app.notes      = s(b.notes, 1000);
    } else {
      app.social     = s(b.social, 300);
      app.notes      = s(b.notes, 1000);
    }
    await store.upsertOne("shph_applications_v1", app);
    console.log(`[apply] new ${type} application from ${app.name}`);
    res.json({ ok: true });
  } catch (e) {
    console.error("[apply] failed:", e.message);
    res.status(502).json({ ok: false, error: "could not save — please try again" });
  }
});

/* ---- Affiliate self-serve portal (2026-07-20). An approved affiliate logs in at /affiliate with
   their code + contact number and sees only THEIR OWN dashboard: referral link, credit ledger,
   referred bookings and the two actions they can take — log a content post (goes to the team for
   verification → ₱50) and request a redemption (goes to the team → voucher). All reads/writes are
   scoped to the one affiliate the session belongs to; the shared booking list is never exposed. */
const _rid = (pfx) => pfx + "_" + crypto.randomBytes(6).toString("hex");
const _phNow = () => new Date(Date.now() + 8 * 3600 * 1000);          // PH is UTC+8
const _phToday = () => _phNow().toISOString().slice(0, 10);
function _affShortName(n) {
  const parts = String(n || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Guest";
  if (parts.length === 1) return parts[0];
  return parts[0].charAt(0).toUpperCase() + ". " + parts[parts.length - 1];
}
function _affBookingStatus(b) {
  const co = b.checkout || b.checkoutDate || b.checkin || b.checkinDate || "";
  if (co && String(co).slice(0, 10) < _phToday()) return "Completed";
  return "Confirmed";
}
function _affCreditLabel(c) {
  const r = String(c && c.reason || "").toLowerCase();
  if (r.includes("post")) return "Content post verified";
  if (r.includes("referral") || r.includes("booking")) return "Referral booking";
  if (!c || !c.reason) return "Credit";
  return c.reason.charAt(0).toUpperCase() + c.reason.slice(1);
}
// Build the portal payload for ONE affiliate — reduced booking view only (initial + surname, no
// phone numbers), plus stats, credit history and the affiliate's own posts/redemptions.
function affiliatePayload(a, bookings) {
  const credits = Array.isArray(a.credits) ? a.credits : [];
  const posts = Array.isArray(a.posts) ? a.posts : [];
  const redemptions = Array.isArray(a.redemptions) ? a.redemptions : [];
  const codeU = String(a.code || "").toUpperCase();
  const mine = (Array.isArray(bookings) ? bookings : [])
    .filter(b => b && !b.cancelled && !b.deleted && String(b.refCode || "").toUpperCase() === codeU);
  const ym = _phToday().slice(0, 7);
  const referred = mine.map(b => ({
    guest: _affShortName((b.guests && b.guests[0] && b.guests[0].name) || b.fbName || "Guest"),
    unit: b.haven || "—",
    date: String(b.checkin || b.checkinDate || "").slice(0, 10),
    status: _affBookingStatus(b)
  })).sort((x, y) => String(y.date).localeCompare(String(x.date)));
  const thisMonth = mine.filter(b => String(b.checkin || b.checkinDate || "").slice(0, 7) === ym).length;
  const earned = credits.reduce((s, c) => s + (Number(c && c.amount) || 0), 0);
  const balance = credits.filter(c => c && !c.used).reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const verifiedPosts = posts.filter(p => p && p.status === "verified").length;
  const history = [];
  credits.forEach(c => history.push({ label: _affCreditLabel(c), at: c.at || "", amount: Number(c && c.amount) || 0 }));
  redemptions.filter(r => r && r.status === "approved").forEach(r =>
    history.push({ label: "Redeemed voucher " + (r.voucher || ""), at: r.approvedAt || r.at || "", amount: -(Number(r.amount) || 0) }));
  history.sort((x, y) => String(y.at).localeCompare(String(x.at)));
  return {
    name: a.name || "", code: a.code || "", memberSince: a.createdAt || "",
    stats: { referred: mine.length, thisMonth, earned, balance, posts: verifiedPosts },
    referred, history,
    posts: posts.slice().sort((x, y) => String(y.at).localeCompare(String(x.at))),
    pendingRedeem: redemptions.some(r => r && r.status === "pending")
  };
}

async function _findAffiliate(aid) {
  let list = [];
  try { list = await store.readFreshList("shph_affiliates_v1"); } catch (e) { list = store.get("shph_affiliates_v1") || []; }
  return (Array.isArray(list) ? list : []).find(x => x && String(x.id) === String(aid) && !x.deleted) || null;
}

// The affiliate's own dashboard data.
apiRouter.get("/affiliate/me", async (req, res) => {
  const sess = affiliateSession(req);
  if (!sess) return res.status(401).json({ error: "login required" });
  try {
    const a = await _findAffiliate(sess.aid);
    if (!a) return res.status(404).json({ error: "affiliate not found" });
    let bookings = [];
    try { bookings = await store.readFreshList("shph_bookings_v3"); } catch (e) { bookings = store.get("shph_bookings_v3") || []; }
    res.json(affiliatePayload(a, bookings));
  } catch (e) {
    console.error("[affiliate] me failed:", e.message);
    res.status(502).json({ error: "read failed" });
  }
});

// Log a content post → recorded as PENDING for the team to verify (credit is minted on verify).
apiRouter.post("/affiliate/post", async (req, res) => {
  const sess = affiliateSession(req);
  if (!sess) return res.status(401).json({ error: "login required" });
  const url = String((req.body || {}).url || "").trim();
  // Anchored + character-restricted: a real URL has no spaces, quotes or angle brackets. This
  // blocks an attribute-breakout payload (e.g. https://x" onmouseover=…) at ingestion — the admin
  // review panel renders this into an href. (esc() there also escapes quotes as defence in depth.)
  if (!/^https?:\/\/[^\s"'<>`]{4,400}$/i.test(url)) return res.status(400).json({ error: "Please paste a valid post link (starting with http, no spaces)." });
  try {
    let dup = false;
    const ok = await store.updateOneFresh("shph_affiliates_v1", sess.aid, a => {
      a.posts = Array.isArray(a.posts) ? a.posts : [];
      if (a.posts.some(p => p && p.url === url && p.status === "pending")) { dup = true; return; }
      a.posts.push({ id: _rid("post"), url, at: new Date().toISOString(), status: "pending" });
    });
    if (!ok) return res.status(404).json({ error: "affiliate not found" });
    if (dup) return res.status(409).json({ error: "That link is already waiting to be verified." });
    res.json({ ok: true });
  } catch (e) {
    console.error("[affiliate] post failed:", e.message);
    res.status(502).json({ error: "could not save — please try again" });
  }
});

// Request a redemption of the whole current balance → PENDING for the team to approve (issue voucher).
apiRouter.post("/affiliate/redeem", async (req, res) => {
  const sess = affiliateSession(req);
  if (!sess) return res.status(401).json({ error: "login required" });
  try {
    let outcome = "", amount = 0;
    const ok = await store.updateOneFresh("shph_affiliates_v1", sess.aid, a => {
      a.redemptions = Array.isArray(a.redemptions) ? a.redemptions : [];
      if (a.redemptions.some(r => r && r.status === "pending")) { outcome = "pending"; return; }
      const bal = (Array.isArray(a.credits) ? a.credits : []).filter(c => c && !c.used).reduce((s, c) => s + (Number(c.amount) || 0), 0);
      if (bal <= 0) { outcome = "empty"; return; }
      amount = bal;
      a.redemptions.push({ id: _rid("redeem"), amount: bal, at: new Date().toISOString(), status: "pending" });
    });
    if (!ok) return res.status(404).json({ error: "affiliate not found" });
    if (outcome === "pending") return res.status(409).json({ error: "You already have a redemption being reviewed." });
    if (outcome === "empty") return res.status(400).json({ error: "No redeemable balance yet." });
    res.json({ ok: true, amount });
  } catch (e) {
    console.error("[affiliate] redeem failed:", e.message);
    res.status(502).json({ error: "could not save — please try again" });
  }
});

// ADMIN-side affiliate actions (verify/reject a post, approve/decline a redemption, manual credit/
// redeem). Every mutation runs INSIDE one store.updateOneFresh transaction on the live record —
// so a concurrent portal write (the affiliate logging a post / requesting a redemption at the same
// moment) can never be clobbered by a whole-record overwrite, and the redemption math is atomic:
// a voucher is issued only for the credits ACTUALLY marked used, never for a stale snapshot amount.
function _affInitials(name) {
  const w = String(name || "").trim().split(/\s+/).filter(Boolean);
  return (((w[0] || "")[0] || "") + (w.length > 1 ? (w[w.length - 1][0] || "") : "")).toUpperCase() || "SHP";
}
apiRouter.post("/affiliate-admin", async (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: "admin only" });
  const b = req.body || {};
  const id = b.id, op = String(b.op || "");
  if (id == null || !op) return res.status(400).json({ error: "missing id or op" });
  const who = (readSession(req) || {}).u || "Admin";
  const out = {};
  try {
    const found = await store.updateOneFresh("shph_affiliates_v1", id, a => {
      const now = new Date().toISOString();
      a.credits = Array.isArray(a.credits) ? a.credits : [];
      a.posts = Array.isArray(a.posts) ? a.posts : [];
      a.redemptions = Array.isArray(a.redemptions) ? a.redemptions : [];
      if (op === "verifyPost" || op === "rejectPost") {
        const p = a.posts.find(x => x && x.id === b.postId && x.status === "pending");
        if (!p) { out.conflict = "That post was already handled."; return; }
        if (op === "verifyPost") {
          p.status = "verified"; p.verifiedAt = now; p.verifiedBy = who;
          a.credits.push({ amount: 50, reason: "verified post", at: now, by: who, used: false });
        } else { p.status = "rejected"; p.reviewedAt = now; p.reviewedBy = who; }
        out.ok = true;
      } else if (op === "approveRedeem" || op === "declineRedeem") {
        const r = a.redemptions.find(x => x && x.id === b.redId && x.status === "pending");
        if (!r) { out.conflict = "That request was already handled."; return; }
        if (op === "declineRedeem") { r.status = "declined"; r.reviewedAt = now; r.reviewedBy = who; out.ok = true; return; }
        // approve: consume oldest-unused credits up to the requested amount; issue the voucher for
        // the amount ACTUALLY covered (guards against over-issue if credits were spent since the request).
        let need = Number(r.amount) || 0, covered = 0;
        a.credits.filter(c => c && !c.used).sort((x, y) => String(x.at || "").localeCompare(String(y.at || "")))
          .forEach(c => { if (need > 0) { const amt = Number(c.amount) || 0; c.used = true; c.usedAt = now; c.usedBy = "voucher"; need -= amt; covered += amt; } });
        const voucher = "HAVENCREDIT-" + _affInitials(a.name) + "-" + crypto.randomBytes(2).toString("hex").toUpperCase();
        r.status = "approved"; r.amount = covered; r.voucher = voucher; r.approvedAt = now; r.approvedBy = who;
        out.ok = true; out.voucher = voucher; out.amount = covered;
      } else if (op === "addCredit") {
        a.credits.push({ amount: 50, reason: "verified post", at: now, by: who, used: false });
        out.ok = true;
      } else if (op === "redeemCredit") {
        const c = a.credits.find(x => x && !x.used);
        if (!c) { out.conflict = "No unused credit to redeem."; return; }
        c.used = true; c.usedAt = now; c.usedBy = who;
        out.ok = true;
      } else {
        out.badop = true;
      }
    });
    if (!found) return res.status(404).json({ error: "affiliate not found" });
    if (out.badop) return res.status(400).json({ error: "unknown op" });
    if (out.conflict) return res.status(409).json({ error: out.conflict });
    res.json(out);
  } catch (e) {
    console.error("[affiliate-admin]", op, "failed:", e.message);
    res.status(502).json({ error: "could not save — please try again" });
  }
});

/* ---- ID-photo retention (data privacy). Runs daily via Vercel Cron (same CRON_SECRET guard
   as the backup) or manually by a signed-in admin hitting /api/retention. Deletes GUEST ID
   PHOTOS 30 days after check-out (settings.site.idRetentionDays overrides) for bookings that
   are fully closed. NEVER touches money or client info: payment proofs, amounts, names and
   contact details all stay. Skips any booking with an open balance, an unreturned security
   deposit, or an unresolved violation. A photo whose content-hashed image is still referenced
   by another record is left in storage (only the link on this booking is removed). Sets
   idsPurged so the "missing ID photo" flag doesn't light up for purged stays. The daily
   backup runs 30 minutes BEFORE this, so every purged photo is in that day's backup. */
apiRouter.all("/retention", async (req, res) => {
  // Destructive (deletes guest ID photos). Only the cron/backup token OR an ADMIN may trigger it —
  // not any logged-in staff/partner.
  if (!backupAuthorized(req) && !isAdminSession(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const settings = (await store.readFreshKey("shph_settings")) || {};
    const days = Number(settings.site && settings.site.idRetentionDays) || 30;
    const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const bookings = await store.readFreshList("shph_bookings_v3");
    let violations = [];
    try { violations = await store.readFreshList("shph_violations_v1"); } catch (e) {}
    const openViolation = new Set((violations || []).filter(v => v && !v.resolved && !v.waived).map(v => String(v.bookingId)));
    // image ids still referenced by any OTHER record (ids/proofs/payments) — never delete those
    const usedElsewhere = (skipId) => {
      const s = new Set();
      for (const ob of bookings) {
        if (!ob || String(ob.id) === String(skipId)) continue;
        String(JSON.stringify(ob)).replace(/\/img\/([A-Za-z0-9_-]+)/g, (m, i) => { s.add(i); return m; });
      }
      return s;
    };
    const out = { retentionDays: days, cutoff, purgedBookings: 0, photosDeleted: 0, skipped: [] };
    for (const b of bookings) {
      if (!b || !Array.isArray(b.ids) || !b.ids.length || b.idsPurged) continue;
      const co = b.checkout || b.checkin;
      if (!co || co >= cutoff) continue;
      const paid = (Number(b.downpayment) || 0) + (b.payments || []).reduce((s, p) => s + (Number(p && p.amount) || 0), 0);
      if (!b.cancelled && (Number(b.total) || 0) - paid > 0) { out.skipped.push(b.id + ":open-balance"); continue; }
      if (!b.cancelled && Number(b.deposit) > 0 && !b.depositReturned) { out.skipped.push(b.id + ":deposit-held"); continue; }
      if (openViolation.has(String(b.id))) { out.skipped.push(b.id + ":open-violation"); continue; }
      const shared = usedElsewhere(b.id);
      for (const ref of b.ids) {
        const m = /^\/img\/([A-Za-z0-9_.-]+)$/.exec(String(ref || ""));
        if (m && !shared.has(m[1])) { try { if (await store.deleteImageById(m[1])) out.photosDeleted++; } catch (e) {} }
      }
      const ok = await store.updateOneFresh("shph_bookings_v3", b.id, x => {
        x.ids = [];
        x.idsPurged = true;
        x.idsPurgedAt = new Date().toISOString();
      });
      if (ok) out.purgedBookings++;
    }
    console.log(`[retention] purged ${out.purgedBookings} booking(s), ${out.photosDeleted} photo(s); cutoff ${cutoff}`);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error("[retention] failed:", e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

/* ---- Assist: the in-house AI assistant. Two endpoints, deliberately different.

   GET  /api/assist/brief  — the daily briefing + alerts. Plain JavaScript, no AI,
        no API key needed, costs nothing. Safe to load on every page open.
   POST /api/assist        — one question to Claude, answered with read-only tools
        over live data. Costs money per call, so it only runs when someone asks.

   Staff session required (a partner session must never reach whole-business data).
   Financial figures are admin-only: a non-admin staff member gets the assistant,
   but the money tool refuses and the prompt tells it not to speculate. */
const assist = require("./lib/assist");
const staffOnly = (req, res) => {
  const s = readSession(req);
  if (!s || s.t !== "staff") { res.status(403).json({ ok: false, error: "staff login required" }); return null; }
  return s;
};

// Cheap flag: is the AI chat switched on? (No data read — just whether the key exists.)
apiRouter.get("/assist/enabled", (req, res) => {
  const s = staffOnly(req, res); if (!s) return;
  res.json({ ai: assist.enabled() });
});

apiRouter.get("/assist/brief", async (req, res) => {
  const s = staffOnly(req, res); if (!s) return;
  try {
    const brief = await assist.getBrief();
    if (!s.adm) { delete brief.numbers.collected_today; delete brief.numbers.owed_today; }
    res.json({ ...brief, ai: assist.enabled() });
  } catch (e) {
    console.error("[assist] brief failed:", e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

apiRouter.post("/assist", async (req, res) => {
  const s = staffOnly(req, res); if (!s) return;
  try {
    const out = await assist.ask({ messages: (req.body || {}).messages, user: s.u, admin: !!s.adm });
    if (out.usage) console.log(`[assist] ${s.u}: in=${out.usage.input} cached=${out.usage.cache_read} out=${out.usage.output} ~₱${out.cost_php} tools=${(out.tools || []).join(",")}`);
    res.json(out);
  } catch (e) {
    console.error("[assist] ask failed:", e.message);
    res.status(502).json({ ok: false, error: e.message, reply: "Something went wrong reaching the assistant — try again in a moment." });
  }
});

// lightweight per-booking status change — cancel / reinstate / delete.
// The browser only sends the id + action (tiny), so a quick refresh can't lose it
// (unlike re-uploading the whole bookings array, which carries base64 images).
apiRouter.post("/booking/:id/:action", async (req, res) => {
  const KEY = "shph_bookings_v3";
  const id = req.params.id, action = req.params.action;
  let ok;
  try {
    if (action === "cancel") {
      ok = await store.updateOneFresh(KEY, id, b => { b.cancelled = true; if (!b.cancelledAt) b.cancelledAt = new Date().toISOString(); });
    } else if (action === "reinstate") {
      ok = await store.updateOneFresh(KEY, id, b => { delete b.cancelled; delete b.cancelledAt; });
    } else if (action === "delete") {
      // SOFT delete: the record is NEVER erased — just flagged (and hidden in the dashboard).
      ok = await store.updateOneFresh(KEY, id, b => { b.deleted = true; if (!b.deletedAt) b.deletedAt = new Date().toISOString(); });
    } else {
      return res.status(400).json({ error: "unknown action" });
    }
  } catch (e) {
    console.error("[api] booking action failed:", e.message);
    return res.status(502).json({ ok: false, error: "persist failed" });
  }
  if (!ok) return res.status(404).json({ error: "booking not found" });
  res.json({ ok: true });
});

// ---- Email the guest a booking confirmation (Gmail SMTP via nodemailer) --------------
// The client sends structured booking fields (never raw HTML), so this can't be abused to
// send arbitrary content. Requires GMAIL_USER + GMAIL_APP_PASSWORD env vars; OWNER_EMAIL
// (optional) gets a BCC copy. Returns { ok:false, error:"not_configured" } until set up,
// so the booking still succeeds even before email is wired.
const _esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function _confirmationHtml(bk) {
  const row = (k, v) => `<tr><td style="padding:7px 0;color:#6a6459;font-size:14px">${_esc(k)}</td><td style="padding:7px 0;text-align:right;font-weight:600;color:#1c1a17;font-size:14px">${_esc(v)}</td></tr>`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#faf6ef;padding:24px">
    <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #ece5d7;border-radius:16px;overflow:hidden">
      <div style="background:#1c1a17;color:#f0d488;padding:20px 24px;font-size:20px;font-weight:700">Staycation Haven PH</div>
      <div style="padding:24px">
        <h2 style="margin:0 0 4px;color:#1c1a17;font-size:22px">Thank you for booking with us! 🏠</h2>
        <p style="color:#6a6459;font-size:14px;margin:0 0 4px">We’ve received your reservation and are reviewing your payment.</p>
        <p style="color:#a9842b;font-weight:700;font-size:15px;margin:0 0 16px">Booking #${_esc(bk.code || "")}</p>
        <table style="width:100%;border-collapse:collapse">
          ${row("Haven", bk.haven)}
          ${row("Check-in", bk.checkin)}
          ${row("Check-out", bk.checkout)}
          ${row("Stay", bk.stay)}
          ${bk.guests ? row("Guests", bk.guests) : ""}
          ${bk.contact ? row("Contact", bk.contact) : ""}
          <tr><td colspan="2" style="border-top:1px solid #ece5d7;padding-top:6px"></td></tr>
          ${row("Total", bk.total)}
          ${row("Downpayment", bk.downpayment)}
          ${row("Balance on arrival", bk.balance)}
        </table>
        <p style="color:#6a6459;font-size:13.5px;margin:18px 0 0">Please message us with your booking number <b>${_esc(bk.code || "")}</b> to confirm your booking. We’ll message a confirmation once your payment is verified. See you at your staycation! ❤️</p>
        <p style="margin:14px 0 0"><a href="https://www.facebook.com/staycationhavenph" style="color:#a9842b">facebook.com/staycationhavenph</a></p>
      </div>
      <div style="background:#f2ece0;color:#9a9384;padding:14px 24px;font-size:12px;text-align:center">© Staycation Haven PH · Mplace Tower D, Panay Ave, Quezon City</div>
    </div>
  </div>`;
}
apiRouter.post("/send-confirmation", async (req, res) => {
  try {
    const { to, booking } = req.body || {};
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to))) return res.status(400).json({ ok: false, error: "bad_email" });
    if (!booking || typeof booking !== "object") return res.status(400).json({ ok: false, error: "no_booking" });
    const user = process.env.GMAIL_USER || "staycationhavenph@gmail.com";
    const pass = process.env.GMAIL_APP_PASSWORD || process.env.EMAIL_PASSWORD;   // reuse existing EMAIL_PASSWORD if set
    if (!pass) return res.status(200).json({ ok: false, error: "not_configured" });
    let nodemailer;
    try { nodemailer = require("nodemailer"); } catch (e) { return res.status(200).json({ ok: false, error: "not_installed" }); }
    const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
    // subject = "MMDDYYYY - CODE" (date it was booked · booking #). Prefer the client's booked date;
    // else fall back to the server clock shifted to PH time (UTC+8).
    const _ph = new Date(Date.now() + 8 * 3600 * 1000);
    const _bookedOn = booking.bookedOn || (String(_ph.getUTCMonth() + 1).padStart(2, "0") + String(_ph.getUTCDate()).padStart(2, "0") + _ph.getUTCFullYear());
    await transporter.sendMail({
      from: `"Staycation Haven PH" <${user}>`,
      to: String(to),
      bcc: process.env.OWNER_EMAIL || "staycationhavenph@gmail.com, piacarlaclav@gmail.com",   // owner copies
      subject: `NEW BOOKING - ${_bookedOn} - ${String(booking.code || "").slice(0, 12)}`,
      html: _confirmationHtml(booking)
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("[api] send-confirmation failed:", e.message);
    res.status(200).json({ ok: false, error: "send_failed" });
  }
});

/* ============================================================================
   GUEST GUIDE — the check-in/check-out walkthrough behind /stay/<token>
   ----------------------------------------------------------------------------
   ONE QR FOR EVERY GUEST (Pia's call, 2026-07-26). One permanent link that is
   sent to everyone and printed once; the guide lists every unit and the guest
   taps their own for the WiFi. The URL still carries a RANDOM token so it can't
   be guessed, and the guide still only opens while a stay is actually running.

   ⚠️ THE TRADE-OFF, STATED PLAINLY: with a single shared QR the server cannot
   tell WHICH haven is scanning, so the gate is now "is ANY haven occupied right
   now" instead of "is THIS haven occupied". Any guest of any haven — and anyone
   they forward the link to — can open the guide whenever the business has at
   least one guest in house, which is most of the time. In exchange the guide
   shows every unit's WiFi, so a guest can read another unit's password. That is
   accepted: this is house information, not money or PII, and NO guest data of
   any kind is on the page. Do not "fix" this by narrowing the gate without
   asking Pia — she chose one QR deliberately.

   The per-haven tokens minted before this change still work and still gate on
   their own haven (they cost nothing to keep, and one may be stuck to a wall).

   Nothing on the public site links here. The response is noindex + private, and
   the guide carries no guest name, number, booking id or any other PII. An
   unknown token and a closed window return the identical friendly page, so
   scanning can't reveal whether a token is real.

   TOKENS ARE KEYED BY THE HAVEN'S ID, NOT ITS NAME (the shared one lives under
   STAY_ALL_KEY). Renaming a haven used to kill the QR already stuck to its wall,
   silently and forever (this project renamed one in commit 6c93d81). Old
   name-keyed entries are carried across to the id on read.
   ========================================================================== */
const fs = require("fs");
const STAY_TOKENS_KEY = "shph_stay_tokens_v1";
// The one shared QR's token. Lives in the same map as the per-haven ones under a key that can
// never collide with a haven id (ids are numbers; this starts with an underscore).
const STAY_ALL_KEY = "_all";
const GUIDE_FILE = path.join(__dirname, "guest-guide", "guide.html");

/* ACCESS WINDOW — PIA'S RULE. Tune it HERE and nowhere else:
   from check-in until check-out, OR 24 hours after check-in, WHICHEVER IS LATER.
   The usual booking is 21 hours, so 24h comfortably covers a guest who is still
   packing up; "whichever is later" is what stops a multi-night stay from losing
   the guide on day 2. */
const STAY_ACCESS_MIN = 24 * 60;

// Haven names are compared spelling-tolerantly: current bookings hold "CasaBienca" while
// older ones hold "Casa Bienca" (the same trap lib/assist.js havenTimeIn() guards against).
const havenKey = (n) => String(n == null ? "" : n).toLowerCase().replace(/\s+/g, "");
const newStayToken = () => crypto.randomBytes(12).toString("base64url");   // 16 URL-safe chars (96 bits)

// The guide is 3.1 MB and self-contained, so read it from disk ONCE per warm instance.
// _guideHtml is the PRISTINE TEMPLATE and must never be mutated — the per-haven WiFi copy is
// built fresh for each request (see stayGuideHtml), or every later scan would inherit the
// previous guest's network.
let _guideHtml = null;
function guideHtml() {
  if (_guideHtml == null) _guideHtml = fs.readFileSync(GUIDE_FILE, "utf8");
  return _guideHtml;
}

/* JSON for a value that goes INSIDE a <script> tag. Escaping "<" and "/" makes "</script>"
   unwritable, so no WiFi name could ever break out of the tag; U+2028/2029 are escaped
   because they are raw line terminators in JS source. */
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003C").replace(/>/g, "\\u003E").replace(/\//g, "\\u002F")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/* Build the served copy of the guide: the same bundle plus one tiny <script> at the top of
   <head> carrying the WiFi list — [{ label, ssid, pass }, …], one per haven — which is what
   fills the unit picker. The bundle swaps the whole document at DOMContentLoaded but keeps the
   same window, so a global set here survives into the React app (guest-guide/guide.html reads
   window.__STAY_WIFI__). This is why no password is stored in the file itself.
   Returns a NEW string — the cached template is left untouched. */
function stayGuideHtml(wifi) {
  const tpl = guideHtml();
  const tag = `<script>window.__STAY_WIFI__=${scriptJson(wifi)};</script>`;
  // Insert AFTER <meta charset> when there is one, not straight after <head>. The tag grows with
  // the number of havens, and pushing the charset declaration past the first 1024 bytes would
  // make the browser guess the encoding — the guide is full of ₱, — and ✓.
  const m = tpl.match(/<meta[^>]+charset[^>]*>/i) || tpl.match(/<head[^>]*>/i);
  if (!m) return tag + tpl;                       // no <head> at all (shouldn't happen) — still works
  const at = m.index + m[0].length;
  return tpl.slice(0, at) + tag + tpl.slice(at);
}

async function stayTokensLive() {
  let map = null;
  try { map = await store.readFreshKey(STAY_TOKENS_KEY); } catch (e) { map = store.get(STAY_TOKENS_KEY); }
  return (map && typeof map === "object" && !Array.isArray(map)) ? map : {};
}
// live haven records ({ id, name }), newest truth — a haven added a minute ago must appear
async function havensLive() {
  let list = [];
  try { list = await store.readFreshList("staycation_havens"); } catch (e) { list = store.get("staycation_havens") || []; }
  return (Array.isArray(list) ? list : [])
    .filter(h => h && !h.deleted && h.name && h.id != null)
    .map(h => ({ id: String(h.id), name: String(h.name) }));
}

/* Normalise the stored token map to ID → token.
   Entries minted before the id switch are keyed by the haven's NAME; they are carried across to
   that haven's id (while the name still matches) so no already-printed QR is lost. An id entry
   always wins over a name entry for the same haven. `migrate` lists the ones that still need
   writing — only the admin QR page persists them, so a guest scan never writes. */
function stayTokensById(raw, havens) {
  const byId = {}, migrate = {};
  for (const k of Object.keys(raw || {})) {
    const token = raw[k];
    if (!token) continue;
    if (havens.some(h => h.id === k)) { byId[k] = token; continue; }        // already id-keyed
    const h = havens.find(x => havenKey(x.name) === havenKey(k));           // legacy name key
    if (h && !raw[h.id]) { byId[h.id] = token; migrate[h.id] = token; }
  }
  return { byId, migrate };
}

/* EVERY haven's WiFi, in haven order, for the guide's unit picker — one QR means the guest
   picks their own unit, so the page needs the whole list. Read from the settings store
   (Rates & Add-ons → WiFi), keyed by haven id, with a name-keyed fallback for anything typed
   in by hand. A haven with nothing configured is still listed, with blanks: the guide shows
   "Ask the host" for it rather than hiding the unit.
   This is the ONLY place the credentials enter a page — they are never in the bundle on disk. */
async function stayWifiAll(havens) {
  let s = null;
  try { s = await store.readFreshKey("shph_settings"); } catch (e) { s = store.get("shph_settings"); }
  const map = (s && s.wifi && typeof s.wifi === "object") ? s.wifi : {};
  return havens.map(h => {
    let w = map[h.id];
    if (!w) { const k = Object.keys(map).find(x => havenKey(x) === havenKey(h.name)); if (k) w = map[k]; }
    return {
      label: h.name,
      ssid: String((w && w.ssid) || "").trim(),
      pass: String((w && w.pass) || "").trim()
    };
  });
}

/* Is a stay running RIGHT NOW? Pass a haven name to ask about that one haven (the old per-haven
   QRs), or null/undefined to ask about ANY haven — which is what the single shared QR uses,
   because one link can't tell us who is scanning. See the trade-off note at the top.
   Uses the app's OWN booking time maths (lib/assist.js bookingInterval) rather than a seventh
   private copy — including the midnight rule, where a 12:00 MN check-in counts as the start of
   the NEXT day. bookingInterval returns absolute minutes anchored to Manila (+08:00), which is
   exactly why comparing it with Date.now()/60000 is correct on a UTC (Vercel) server. */
function activeStayIn(bookings, haven) {
  const now = Math.round(Date.now() / 60000);
  const want = (haven == null || haven === "") ? null : havenKey(haven);
  return (Array.isArray(bookings) ? bookings : []).some(b => {
    if (!b || b.cancelled || b.deleted) return false;
    if (want !== null && havenKey(b.haven) !== want) return false;
    if (!b.checkin) return false;
    const iv = assist.bookingInterval(b);
    if (!iv || !isFinite(iv.start) || !isFinite(iv.end)) return false;
    const until = Math.max(iv.end, iv.start + STAY_ACCESS_MIN);   // check-out, or +24h — whichever is LATER
    return now >= iv.start && now < until;
  });
}

// The friendly "not right now" page. Same reply for an unknown token and a finished stay.
function stayClosedHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Staycation Haven PH — Guest Guide</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f2f2;
    color:#201f1d;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,Arial,sans-serif;padding:26px;text-align:center}
  .card{max-width:430px}
  .logo{width:74px;height:74px;border-radius:18px;background:#fff;overflow:hidden;display:flex;
    align-items:center;justify-content:center;margin:0 auto 24px;box-shadow:0 10px 30px rgba(120,90,30,.13)}
  .logo img{width:100%;height:100%;object-fit:contain}
  h1{font-family:Georgia,'Times New Roman',serif;font-size:25px;font-weight:700;line-height:1.3}
  .rule{width:46px;height:2px;background:#b68235;margin:18px auto}
  p{font-size:15px;line-height:1.75;color:#5d5952}
  a.btn{display:inline-block;margin-top:24px;background:#b68235;color:#fff;text-decoration:none;
    padding:13px 26px;border-radius:999px;font-size:14.5px;font-weight:700}
  .tag{margin-top:26px;font-size:11px;color:#b68235;font-weight:700;letter-spacing:1.5px;text-transform:uppercase}
</style></head><body>
  <div class="card">
    <div class="logo"><img src="/images/logo.png" alt="Staycation Haven PH"></div>
    <h1>Para po ito sa mga naka&#8209;check&nbsp;in</h1>
    <div class="rule"></div>
    <p>Nakikita lang ang guest guide habang nasa haven pa kayo. Kung naka-check in na kayo pero
       hindi pa rin ito bumubukas — o kung may kailangan kayo — message niyo lang po kami,
       tutulungan namin kayo agad. 💛</p>
    <a class="btn" href="https://m.me/staycationhavenph">Message us on Messenger</a>
    <div class="tag">Staycation Haven PH</div>
  </div>
</body></html>`;
}

// ---- the gated route itself. PUBLIC on purpose: guests are never logged in. It sits outside
// /api (so the API session gate doesn't apply) and outside PROTECTED_PAGES (so it isn't treated
// as an admin page). Registered BEFORE the /:user/<slug> deep links so a token can never be
// swallowed by one of those. ----
app.get("/stay/:token", async (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("X-Robots-Tag", "noindex, nofollow");
  const token = String(req.params.token || "");
  try {
    const raw = await stayTokensLive();
    const havens = await havensLive();
    const { byId } = stayTokensById(raw, havens);
    // The ONE shared QR: it can't say who is scanning, so it gates on ANY haven being occupied.
    // A legacy per-haven token still gates on its own haven.
    const shared = raw[STAY_ALL_KEY] && raw[STAY_ALL_KEY] === token;
    const id = shared ? null : Object.keys(byId).find(k => byId[k] === token);
    const haven = id ? havens.find(h => h.id === id) : null;   // id → the haven's CURRENT name
    if (shared || haven) {
      // LIVE read — a guest who checked in a minute ago must never be told "no stay right now",
      // and a warm instance's cached list can easily be missing that booking.
      let bookings = [];
      try { bookings = await store.readFreshList("shph_bookings_v3"); }
      catch (e) { bookings = store.get("shph_bookings_v3") || []; }
      if (activeStayIn(bookings, haven ? haven.name : null)) {
        // 3 MB of guide on every scan. The handler (and therefore the gate above) still runs on
        // every request, but an unchanged guide can answer 304 with no body — hence no-cache
        // rather than no-store. `private` keeps any shared proxy out of it. The body is set
        // BEFORE Express computes the ETag, so the injected WiFi list is part of the ETag.
        res.set("Cache-Control", "private, no-cache, must-revalidate");
        return res.send(stayGuideHtml(await stayWifiAll(havens)));
      }
    }
  } catch (e) {
    console.error("[stay] gate failed:", e.message);   // fail CLOSED — fall through to the notice
  }
  res.status(200).send(stayClosedHtml());              // 200, not 404, so it renders nicely on a phone
});

// ---- admin: the token behind the printable QR page (dashboard → Guest Guide QR) ----
// Mints the ONE shared token the first time the page is opened, then leaves it alone forever.
// Legacy per-haven tokens are still migrated/returned so an already-printed sticker keeps
// working, but the page only shows the single QR.
apiRouter.get("/stay-tokens", async (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: "admin only" });
  try {
    const havens = await havensLive();
    const raw = await stayTokensLive();
    const { byId, migrate } = stayTokensById(raw, havens);
    // one PROPERTY at a time, transactionally — never a whole-map replace, so two admins opening
    // this page at once can't wipe each other's tokens. (An old name key is left in place: it is
    // harmless dead weight, and deleting it would need exactly the whole-map write we avoid.)
    for (const id of Object.keys(migrate)) await store.setObjectProp(STAY_TOKENS_KEY, id, migrate[id]);
    let all = raw[STAY_ALL_KEY];
    if (!all) { all = newStayToken(); await store.setObjectProp(STAY_TOKENS_KEY, STAY_ALL_KEY, all); }
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, token: all, havens, tokens: byId });   // `tokens` = legacy per-haven, by ID
  } catch (e) {
    console.error("[stay] token read failed:", e.message);
    res.status(502).json({ ok: false, error: "could not load the QR code — try again" });
  }
});

// Explicit REGENERATE. Deliberately a separate call the dashboard confirms first: a new token
// kills every QR already printed, posted or sent to a guest.
// Body: {} / { id:"_all" } for the shared QR, or { id:"<haven id>" } for a legacy per-haven one.
apiRouter.post("/stay-tokens", async (req, res) => {
  if (!isAdminSession(req)) return res.status(403).json({ error: "admin only" });
  const id = String((req.body || {}).id || STAY_ALL_KEY).trim() || STAY_ALL_KEY;
  try {
    let label = "the shared guest-guide QR";
    if (id !== STAY_ALL_KEY) {
      const haven = (await havensLive()).find(h => h.id === id);
      if (!haven) return res.status(404).json({ ok: false, error: "unknown haven" });
      label = `"${haven.name}" (id ${id})`;
    }
    const token = newStayToken();
    await store.setObjectProp(STAY_TOKENS_KEY, id, token);
    console.log(`[stay] QR token regenerated for ${label} by ${(readSession(req) || {}).u || "admin"} — every QR already printed or sent for it is now dead`);
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, id, token });
  } catch (e) {
    console.error("[stay] token regenerate failed:", e.message);
    res.status(502).json({ ok: false, error: "could not save — try again" });
  }
});

app.use("/api", apiRouter);

/* ---------------- Pages (server-rendered EJS) ---------------- */
// Every page that has real content. Empty placeholder files are skipped.
const PAGES = [
  "index", "havens", "booknow", "payment",
  "admin", "dashboard", "todaysbooking", "Nicole", "nicole-dashboard", "payroll",
  "partner-login", "be-a-partner"
];

// Guest-facing pages that the website Maintenance switch takes offline.
const PUBLIC_PAGES = new Set(["index", "havens", "booknow", "payment", "be-a-partner"]);

/* ---------- Public seed projection (2026-07-17 audit) ----------
   renderPage() injects the whole store as window.__SEED__ so the existing localStorage-based page
   code keeps working. On the PUBLIC pages that handed every anonymous visitor the entire database:
   185 bookings with guest names + phone numbers, all users with PLAINTEXT passwords, partner
   logins, staff, bills, expenses and the activity log. Guest pages need almost none of it.

   Only these keys are needed publicly: the haven list + settings (rates, payment methods), and the
   bookings — reduced to the fields the website's availability and duplicate checks actually read.

   `updatedAt` is deliberately NOT included, and that omission is load-bearing: seed-bridge merges
   __SEED__ with localStorage and can push the result back (payment.html writes the array), while
   store.js mergeById keeps the stored record whenever the incoming copy has no updatedAt. Omitting
   it means a projected record can never overwrite a full one. Do not add it. */
const PUBLIC_SEED_KEYS = ["staycation_havens", "shph_settings"];
const PUBLIC_BOOKING_FIELDS = [
  "id",                                                              // merge identity
  "haven", "checkin", "checkout", "checkinTime", "stayHours",        // availability window
  "slot", "extend", "cancelled", "deleted",                          // …and what frees it
  "source", "bookingNo"                                              // SH-000x sequence (contact REMOVED — it leaked every guest's phone in page source; the website dup-check still catches same-session re-clicks and slot conflicts are refused separately)
];
/* settings.wifi = the per-haven guest-guide WiFi (SSID + password). shph_settings is public-seeded,
   so without this it would be printed into the page source of every guest page. It is stripped here
   AND for any non-admin dashboard session (renderPage below); the only browser that ever receives
   it is an admin's, and the only other consumer is the server itself in /stay/:token. */
function stripWifi(settings) {
  if (!settings || typeof settings !== "object" || !settings.wifi) return settings;
  const copy = { ...settings };   // COPY: seed values are live references to the store cache
  delete copy.wifi;
  return copy;
}

function publicSeed(seed) {
  const out = {};
  for (const k of PUBLIC_SEED_KEYS) if (k in seed) out[k] = seed[k];
  if (out.shph_settings) out.shph_settings = stripWifi(out.shph_settings);
  const list = Array.isArray(seed.shph_bookings_v3) ? seed.shph_bookings_v3 : [];
  out.shph_bookings_v3 = list.map(b => {
    const o = {};
    for (const f of PUBLIC_BOOKING_FIELDS) if (b && b[f] !== undefined) o[f] = b[f];
    return o;
  });
  return out;
}

// A friendly, branded "we'll be right back" page shown to guests while the owner has the website
// under maintenance. Self-contained (no external assets except the logo) so it always renders.
function maintenanceHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Staycation Haven PH — We'll be right back</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#faf6ef;
    color:#1c1a17;font-family:'Segoe UI',system-ui,-apple-system,Arial,sans-serif;padding:24px;text-align:center}
  .card{max-width:460px}
  .logo{width:78px;height:78px;border-radius:18px;background:#fff;border:1px solid #ece5d7;overflow:hidden;
    display:flex;align-items:center;justify-content:center;margin:0 auto 26px;box-shadow:0 12px 34px rgba(120,90,30,.14)}
  .logo img{width:100%;height:100%;object-fit:contain}
  h1{font-family:Georgia,'Times New Roman',serif;font-size:27px;font-weight:800;margin-bottom:14px}
  p{font-size:15px;line-height:1.65;color:#6a6459}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#a9842b;margin-right:9px;
    vertical-align:middle;animation:pulse 1.4s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.35;transform:scale(.9)}50%{opacity:1;transform:scale(1)}}
  .tag{margin-top:28px;font-size:12px;color:#a9842b;font-weight:800;letter-spacing:1.4px;text-transform:uppercase}
</style></head><body>
  <div class="card">
    <div class="logo"><img src="/images/logo.png" alt="Staycation Haven PH"></div>
    <h1><span class="dot"></span>We'll be right back</h1>
    <p>Our website is currently under maintenance.<br>Please check back in a few minutes — thank you for your patience! 💛</p>
    <div class="tag">Staycation Haven PH</div>
  </div>
</body></html>`;
}

// Views that hold the business's data — bookings, guests, money. Serving one of these to an
// anonymous visitor hands over the whole seed, so they require a session. The login pages
// (admin, partner-login) and the guest pages (index/havens/booknow/payment) stay open.
const PROTECTED_PAGES = new Set(["dashboard", "todaysbooking", "Nicole", "nicole-dashboard", "payroll"]);

function renderPage(name) {
  return async (req, res) => {
    // ---- auth gate (2026-07-18): no valid session → login page, and NO data seed ----
    if (PROTECTED_PAGES.has(name)) {
      const sess = readSession(req);
      if (!sess) {
        const onPartnerPath = String(req.path || "").toLowerCase().startsWith("/partners");
        return res.redirect(302, onPartnerPath ? "/partner-login" : "/admin");
      }
    }
    // The login pages themselves render with a MINIMAL seed (site settings only): the server
    // now checks credentials, so the browser no longer needs — and must not receive — the
    // user/partner lists it used to compare passwords against.
    if (name === "admin" || name === "partner-login") {
      // stripWifi: the login pages are reachable by ANYONE, so the guest-guide WiFi passwords
      // must not ride along in their seed either.
      const s = { shph_settings: stripWifi(store.get("shph_settings")) };
      return res.render(name, { seed: s, page: name }, (err, html) => {
        if (err) return res.status(500).send("Page render error: " + err.message);
        res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.send(html);
      });
    }
    const seed = store.all();
    // The bookings a page renders with (dashboard list, calendar, website
    // availability) must reflect the TRUE current list — not this serverless
    // instance's possibly-stale in-memory cache. A warm instance can be missing a
    // booking saved via another instance (e.g. a website booking), so it would
    // silently vanish from the dashboard or a taken slot would look free. Read the
    // live Firestore list for the seed; fall back to the cache if that read fails.
    // EVERY id-keyed list store — not just bookings — must reflect the LIVE Firestore list, or a
    // record saved via another serverless instance (a partner, user, haven, booking…) is missing
    // from this warm instance's cache and "vanishes" on the next page load. Read them fresh (in
    // parallel, so it's ~one round-trip) and fall back to the cached copy per-key on failure.
    await Promise.all([...MERGE_LIST_KEYS].map(async (_key) => {
      try {
        const fresh = await store.readFreshList(_key);
        if (Array.isArray(fresh)) seed[_key] = fresh;
      } catch (e) {
        console.warn("[render] fresh read failed for", _key, "—", e.message);
      }
    }));
    // The housekeeping log is an OBJECT key (bookingId → entry), so the list loop above doesn't
    // cover it — read it fresh too, or a warm instance shows "Not started" for cleaning work
    // already saved through another instance.
    try {
      const freshClean = await store.readFreshKey("shph_cleaning_v1");
      if (freshClean && typeof freshClean === "object" && !Array.isArray(freshClean)) seed.shph_cleaning_v1 = freshClean;
    } catch (e) { console.warn("[render] fresh read failed for shph_cleaning_v1 —", e.message); }
    // Website Maintenance switch: guest-facing pages show a "back soon" notice while it's on. Read
    // the flag FRESH so a stale per-instance cache can't keep the site up after the owner takes it
    // down. The dashboard/admin pages are NOT gated, so the owner can always flip it back.
    if (PUBLIC_PAGES.has(name)) {
      try {
        const freshSettings = await store.readFreshKey("shph_settings");
        if (freshSettings) seed.shph_settings = freshSettings;
        if (freshSettings && freshSettings.site && freshSettings.site.maintenance) {
          return res.status(503).set("Retry-After", "300").send(maintenanceHtml());
        }
      } catch (e) {
        console.warn("[render] maintenance check failed for", name, "—", e.message);
      }
    }
    // Never let the browser/CDN serve a STALE cached page HTML — the dashboard changes often and
    // a cached old copy shows the wrong sidebar/menu. Always revalidate the HTML (assets in
    // /public keep their own caching, so this doesn't hurt load speed meaningfully).
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    // guest pages get a minimal, PII-free projection; the dashboard/admin pages get the full store
    const pageSeed = PUBLIC_PAGES.has(name) ? publicSeed(seed) : seed;
    // The owner's private notes are stripped from the seed unless an ADMIN is signed in — a
    // staff or partner browser must never receive them, even though they load the same view.
    if (!PUBLIC_PAGES.has(name) && !isAdminSession(req)) {
      ADMIN_ONLY_KEYS.forEach(k => { delete pageSeed[k]; });
      // …and the guest-guide WiFi passwords, which only the admin WiFi tab ever edits. PUT /kv
      // re-attaches them, so a staff/partner Save can't wipe what their browser never saw.
      if (pageSeed.shph_settings) pageSeed.shph_settings = stripWifi(pageSeed.shph_settings);
    }
    res.render(name, { seed: pageSeed, page: name }, (err, html) => {
      if (err) {
        console.error("Render error for", name, "—", err.message);
        return res.status(500).send("Page render error: " + err.message);
      }
      res.send(html);
    });
  };
}

for (const name of PAGES) {
  const handler = renderPage(name);
  app.get("/" + name, handler);          // clean URL  e.g. /havens
  app.get("/" + name + ".html", handler); // keep old links working e.g. /havens.html
}
app.get("/", renderPage("index"));
// Partner dashboard: serves the dashboard view at a partner-branded URL.
// Single path segment so the dashboard's relative assets still resolve to root.
// Partner mode is detected client-side from this path (see dashboard.html).
app.get("/partners", renderPage("dashboard"));
app.get("/partner-dashboard", renderPage("dashboard"));   // alias
// Recruitment front doors — one page holds both offers; the affiliate URL deep-links to its section
app.get("/become-an-affiliate", renderPage("be-a-partner"));

// Affiliate self-serve portal. Rendered with a MINIMAL seed (site settings only): the page holds
// no back-office data — it fetches the signed-in affiliate's own dashboard from /api/affiliate/me,
// and shows a login card first if there's no valid affiliate session.
app.get("/affiliate", (req, res) => {
  // /affiliate has NO auth gate (the login card is drawn client-side), so its seed is public: strip
  // the per-haven WiFi passwords, exactly like publicSeed/renderPage do. Without this the whole set
  // is readable from View Source on a linked, indexable URL.
  const s = { shph_settings: stripWifi(store.get("shph_settings")) };
  res.render("affiliate", { seed: s, page: "affiliate" }, (err, html) => {
    if (err) { console.error("Render error for affiliate —", err.message); return res.status(500).send("Page render error: " + err.message); }
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.send(html);
  });
});

// Nicole's branded shortcut URLs — the same back-office pages behind friendlier addresses.
// No auth change: each page still requires a logged-in user (the client bounces to the login
// screen if none). Single path segment so the pages' relative assets still resolve to root.
// The dashboard opens straight to the matching section, detected client-side (see dashboard.html).
app.get("/nicole-todaysbooking", renderPage("nicole-dashboard"));   // Nicole's premium redesigned Today's Booking
app.get("/nicole-board",     renderPage("dashboard"));
app.get("/nicole-calendar",  renderPage("dashboard"));
app.get("/nicole-guestform", renderPage("dashboard"));
app.get("/nicole-deposit",   renderPage("dashboard"));

// Deep-link URL for every dashboard sidebar page — /admin/<slug>. All render the dashboard view
// (which opens the matching section, detected client-side from the path); Today's Booking has its
// own page, so it renders that view. The dashboard's <base href="/"> keeps assets resolving.
const ADMIN_PAGE_ROUTES = {
  "board":"dashboard", "todays-booking":"todaysbooking", "calendar-bookings":"dashboard",
  "guest-form":"dashboard", "collection-reports":"dashboard", "website":"dashboard",
  "booking-approval":"dashboard", "security-deposit":"dashboard", "violations-damages":"dashboard",
  "partner-list":"dashboard", "commissions":"dashboard", "bookings-by-partner":"dashboard",
  "pr-rooms":"dashboard", "add-partner":"dashboard", "applications":"dashboard", "affiliates":"dashboard", "havens":"dashboard", "rates-addons":"dashboard",
  "guest-guide-qr":"dashboard",
  "housekeeping":"dashboard", "inventory":"dashboard", "finance":"dashboard", "payments":"dashboard",
  "payroll":"dashboard", "bills":"dashboard", "expenses":"dashboard", "analytics":"dashboard",
  "users":"dashboard", "employees":"dashboard", "assist":"dashboard", "log":"dashboard", "notes":"dashboard"
};
for (const slug in ADMIN_PAGE_ROUTES) {
  app.get("/admin/" + slug, renderPage(ADMIN_PAGE_ROUTES[slug]));
  // The same pages for a logged-in PARTNER, under /partners/<slug>. The dashboard detects partner
  // mode from the path, so a partner must never sit on an /admin/<slug> URL: refreshing there would
  // load the page unscoped — no haven filter, no partner chrome — showing every haven's bookings.
  app.get("/partners/" + slug, renderPage(ADMIN_PAGE_ROUTES[slug]));
  // The same pages under the signed-in user's OWN name — /<user>/<slug>, e.g. /Jedd/housekeeping.
  // Registered last so /admin/<slug> and /partners/<slug> keep priority. The slug is a literal, so
  // this can never swallow /api, /images or any single-segment page route. The name is cosmetic:
  // access is still decided by the session, not by what's typed in the URL.
  app.get("/:user/" + slug, renderPage(ADMIN_PAGE_ROUTES[slug]));
}

/* ---------------- Static assets ---------------- */
// Client JS/CSS live in /public; images stay in /images.
// The project root is intentionally NOT served, so server.js / data
// / package.json are never exposed.
app.use(express.static(path.join(__dirname, "public")));
app.use("/images", express.static(path.join(__dirname, "images")));

// Run a normal long-lived server only when started directly (local / VPS).
// On Vercel the app is imported as a serverless handler instead (see api/index.js),
// so we must NOT call app.listen there.
if (require.main === module) {
  ensureStore()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Staycation Haven PH running →  http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error("Failed to initialise data store:", err);
      process.exit(1);
    });
}

module.exports = app;
