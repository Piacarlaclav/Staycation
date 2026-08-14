/* ============================================================
   STAYCATION HAVEN PH — SERVER-SIDE DATA STORE
   ------------------------------------------------------------
   A small key/value store with TWO interchangeable backends:

     • Firebase Firestore  — used when a service-account key is
       available (cloud, shared across devices, survives deploys).
     • Local JSON file      — used otherwise (data/store.json), so
       the app keeps working with zero setup.

   Either way the rest of the app is unchanged: it mirrors the
   localStorage keys the front-end already uses. An in-memory cache
   keeps get()/all() synchronous; writes go through to the backend.

   To use Firestore: put your Firebase service-account JSON at
   ./serviceAccountKey.json (git-ignored), or set the
   FIREBASE_SERVICE_ACCOUNT env var to its JSON contents.
   ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const KEY_FILE = path.join(__dirname, "..", "serviceAccountKey.json");
const FS_COLLECTION = "shph_store";   // one document per shared key
const BACKUP_COLLECTION = "shph_backups"; // rolling restore points: one doc per key per day
const BACKUP_RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS) || 30; // auto-prune older restore points
const IMG_COLLECTION = "shph_images"; // one document per offloaded base64 image
const IMG_PREFIX = "shphimg::";       // marker that replaces a base64 image with its image-doc id
const IMG_MAX_BYTES = 1040000;        // safety: stay just under Firestore's 1MB per-document limit
const IMG_CHUNK_BYTES = 900000;       // when an image is bigger than one doc, split the data-url into pieces this size
const IMG_ABS_MAX = 3000000;          // absolute ceiling for a stored image data-url (~2.2MB decoded) — the client compresses under this

/* ---- Defaults (same values the old browser scripts shipped) ---- */
const DEFAULT_HAVENS = [
  {
    id: 1,
    name: "Haven 1",
    image: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?w=1200",
    gallery: [],
    price: "₱2,500 / night",
    description: "Perfect for couples and small families.",
    amenities: ["📶 Fast WiFi", "📺 Netflix", "❄️ Air Conditioning", "🛏️ Comfortable Beds"]
  },
  {
    id: 2,
    name: "Haven 2",
    image: "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=1200",
    gallery: [],
    price: "₱3,200 / night",
    description: "Modern city-view staycation.",
    amenities: ["📶 Fast WiFi", "📺 Netflix", "🚗 Parking", "🍳 Kitchen"]
  },
  {
    id: 3,
    name: "Casa Bienca",
    image: "https://images.unsplash.com/photo-1560185007-c5ca9d2c014d?w=1200",
    gallery: [],
    price: "₱5,000 / night",
    description: "Luxury experience with premium amenities.",
    amenities: ["📶 Fast WiFi", "📺 Netflix", "❄️ Air Conditioning", "🚗 Parking", "🍳 Kitchen", "🛏️ Comfortable Beds"]
  }
];

const DEFAULT_SETTINGS = {
  pricing: {
    stay6: 999, stay10: 1599, stay10Sat: 1599, stay21Weekday: 1799, stay21Weekend: 2099,
    longWeekday: 1699, longWeekend: 1899, holidayNight: 2099, holidayDayUse: 1799,
    deposit: 1000, includedPax: 2, addPax: 300, poolRegular: 150, poolHoliday: 300,
    extraHour: 150, towelRate: 50, towelMaxPerPax: 2, maxDays: 14,
    offer6: true, offer10: true, offer21: true
  },
  customAddons: [],
  promos: [],
  downpayment: [
    { maxDays: 2, amount: 500 },
    { maxDays: 4, amount: 1000 },
    { maxDays: 8, amount: 2000 },
    { maxDays: 14, amount: 4000 }
  ],
  payment: {
    intro: "Kindly send your payment here po 😊",
    screenshotNote: "PLEASE SEND A SCREENSHOT AFTER PAYMENT PO.",
    warnNote: "Please be noted po: no payment = no reservation. Thank you ❤️",
    cashNote: "Please prepare the downpayment in cash upon check-in.",
    methods: [
      { name: "GCash", number: "0945 693 5211", account: "Pia Carla Salamat", qr: "" },
      { name: "Maya", number: "0945 693 5211", account: "Pia Carla Salamat", qr: "" },
      { name: "BDO", number: "010940093073", account: "Pia Carla Salamat", qr: "" }
    ]
  }
};

// The shared business keys that live on the server. Per-session keys
// (current_user, dashboard_page, the pending/confirmed booking handoff,
// UI filters) stay in the browser and are NOT listed here.
const SHARED_KEYS = [
  "staycation_havens",
  "shph_settings",
  "shph_bookings_v3",
  "shph_staff_v1",
  "shph_bills_v1",
  "shph_expenses_v1",
  "shph_cleaning_v1",
  "shph_poolpass_v1",
  "shph_guestform_units",
  "shph_employee_nicole",
  "shph_users",
  "shph_activity_log",
  "shph_partners",
  "shph_partner_board",
  // Both were listed as shared by the client (public/js/seed-bridge.js) but missing here, so every
  // PUT returned 403 "key not shared" and the data NEVER persisted — Partner Inventory and
  // Violations & Damages lived only in whichever browser typed them. (2026-07-17 audit.)
  "shph_partner_inventory",
  "shph_violations_v1",
  "shph_deleted_bookings",
  "shph_visits",
  "shph_applications_v1",  // partner/affiliate applications from the public recruitment pages
  "shph_affiliates_v1",    // approved affiliates: personal code + ₱50-credit ledger
  "shph_notes_v1",         // owner's private notes (super-admin only; never shown to staff/partners)
  // Guest-guide QR secrets: { "<haven id>": "<random token>", … }. Keyed by the haven's stable ID,
  // never its name — renaming a haven would otherwise orphan the QR already printed and stuck to
  // its wall. Listed here so the DAILY BACKUP covers them: a lost token map kills every printed QR.
  // It is an OBJECT map, not an id-keyed list, so it must NOT go in MERGE_LIST_KEYS/MERGE_KEYS;
  // it is only ever written one haven at a time via setObjectProp (never a whole-map replace).
  "shph_stay_tokens_v1",
  // Partner payouts: what the owner has actually PAID each partner, and for which month. Records
  // carry an id, so this must appear in BOTH server MERGE_LIST_KEYS and seed-bridge MERGE_KEYS —
  // a whole-array write would drop another device's entry, and this is money.
  "shph_payouts_v1"
];

function defaults() {
  return {
    staycation_havens: DEFAULT_HAVENS,
    shph_settings: DEFAULT_SETTINGS,
    shph_bookings_v3: [],
    shph_staff_v1: [],
    shph_bills_v1: [],
    shph_expenses_v1: [],
    shph_cleaning_v1: [],
    shph_poolpass_v1: [],
    shph_guestform_units: {},
    shph_employee_nicole: {},
    shph_users: [],
    shph_activity_log: [],
    shph_partners: [],
    shph_partner_board: {},
    shph_partner_inventory: {},   // object keyed by haven (partners.js loadInventory)
    shph_violations_v1: [],       // list; records carry a uid() id
    shph_deleted_bookings: [],
    shph_visits: { total: 0, days: {} },
    shph_applications_v1: [],     // list; records carry an id (partner/affiliate applications)
    shph_affiliates_v1: [],       // list; records carry an id (approved affiliates + credits)
    shph_notes_v1: [],            // list; records carry an id (private owner notes)
    shph_stay_tokens_v1: {},      // object map: haven id → guest-guide QR token
    shph_payouts_v1: []           // list; records carry an id (partner payout ledger)
  };
}

let cache = null;     // in-memory mirror of every shared key (with images inlined)
let backend = "file"; // "file" | "firestore"
let projectId = null; // Firebase project id (when backend === "firestore") — for the health page
let db = null;        // Firestore instance (when backend === "firestore")
let initPromise = null;
let imageCache = {};  // id → base64 data-url (file backend / legacy only)
let bucket = null;            // Firebase Cloud Storage bucket (when available)
let knownImageIds = new Set();// ids already uploaded this process (dedupe)
const IMG_DIR = "shph-images";// folder inside the Storage bucket
const STORAGE_BUCKET_ENV = process.env.FIREBASE_STORAGE_BUCKET || "";

/* ----------------------- Firebase credentials ----------------------- */
// Returns a parsed service-account object, or null if none is configured.
function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try { return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); }
    catch (e) { console.warn("[store] FIREBASE_SERVICE_ACCOUNT is not valid JSON — ignoring."); }
  }
  if (fs.existsSync(KEY_FILE)) {
    try { return JSON.parse(fs.readFileSync(KEY_FILE, "utf8")); }
    catch (e) { console.warn("[store] serviceAccountKey.json is not valid JSON — ignoring."); }
  }
  return null;
}

/* --------------------------- File backend --------------------------- */
function fileLoad() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    return null;
  }
}

function filePersist() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmp, DATA_FILE); // atomic-ish swap
  } catch (e) {
    // Serverless filesystems (e.g. Vercel) are read-only, so writing throws
    // ENOENT/EROFS. Don't crash the request — keep serving from the in-memory
    // cache. (Durable persistence there comes from the Firestore backend.)
    console.warn("[store] file persist skipped (read-only filesystem?):", e.message);
  }
}

/* --------------------- Image offload (Firestore) -------------------- */
// Base64 images (payment proofs, IDs, QR codes…) are huge and would push a
// shared document past Firestore's 1MB limit. So we store each image in its
// own document (collection IMG_COLLECTION) and leave only a tiny "shphimg::<id>"
// reference inside the shared document. On read we swap the references back to
// the real image, so the rest of the app never notices.
function isDataUrl(s) {
  return typeof s === "string" && s.startsWith("data:") && s.indexOf(";base64,") !== -1;
}
function imageId(dataUrl) {
  return crypto.createHash("sha1").update(dataUrl).digest("hex");
}
// deep clone, applying fn() to every string
function mapStrings(v, fn) {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map(x => mapStrings(x, fn));
  if (v && typeof v === "object") {
    const out = {};
    for (const k in v) out[k] = mapStrings(v[k], fn);
    return out;
  }
  return v;
}
// returns { clean, images } — clean has refs, images is { id: dataUrl } of new ones
function extractImages(value) {
  const images = {};
  const clean = mapStrings(value, s => {
    if (!isDataUrl(s)) return s;
    const id = imageId(s);
    images[id] = s;
    return IMG_PREFIX + id;
  });
  return { clean, images };
}
// returns a copy of value with every "shphimg::<id>" reference rewritten to a
// tiny on-demand URL (/img/<id>) that the server streams from Cloud Storage (or
// the legacy Firestore image doc). Keeps the payload small — no inline base64.
function inlineImages(value) {
  return mapStrings(value, s => {
    if (typeof s === "string" && s.startsWith(IMG_PREFIX)) {
      return "/img/" + s.slice(IMG_PREFIX.length);
    }
    return s;
  });
}

/* ----------------------- Cloud Storage images ---------------------- */
// split a "data:<mime>;base64,<data>" string into a Buffer + content type
function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataUrl || "");
  if (!m) return null;
  return { contentType: m[1], buffer: Buffer.from(m[2], "base64") };
}
// upload one image to the Storage bucket at shph-images/<id> (no 1MB limit),
// retrying a few times so a transient hiccup doesn't drop the photo.
async function uploadImage(id, dataUrl, attempt) {
  attempt = attempt || 1;
  const p = parseDataUrl(dataUrl);
  if (!p) throw new Error("not a base64 data URL");
  try {
    await bucket.file(IMG_DIR + "/" + id).save(p.buffer, {
      resumable: false,
      contentType: p.contentType,
      metadata: { cacheControl: "public, max-age=31536000, immutable" }
    });
  } catch (e) {
    if (attempt < 3) { await new Promise(r => setTimeout(r, 500 * attempt)); return uploadImage(id, dataUrl, attempt + 1); }
    throw e;   // give up after retries → propagates so the whole save retries
  }
}
// Write ONE base64 image to Firestore (the fallback when no Cloud Storage bucket is configured).
// Small enough for a single doc → store as { data }. Bigger than the 1MB per-doc limit → SPLIT the
// data-url across chunk docs (id~0, id~1, …) and write a manifest { chunks:N } LAST, so a partially
// written image is never read as if complete. This lifts the effective size limit to ~2MB WITHOUT a
// Storage bucket, and never drops a photo (it refuses only an image past the absolute ceiling, which
// the browser already compresses under). Chunk writes are idempotent, so a retry can't corrupt one.
async function firestoreWriteImage(id, dataUrl) {
  const bytes = Buffer.byteLength(dataUrl);
  if (bytes <= IMG_MAX_BYTES) { await db.collection(IMG_COLLECTION).doc(id).set({ data: dataUrl }); return; }
  if (bytes > IMG_ABS_MAX) throw new Error(`image exceeds ${(IMG_ABS_MAX / 1e6).toFixed(1)}MB`);
  const parts = [];
  for (let i = 0; i < dataUrl.length; i += IMG_CHUNK_BYTES) parts.push(dataUrl.slice(i, i + IMG_CHUNK_BYTES));
  await Promise.all(parts.map((p, i) => db.collection(IMG_COLLECTION).doc(id + "~" + i).set({ data: p })));
  await db.collection(IMG_COLLECTION).doc(id).set({ chunks: parts.length });   // manifest written LAST
}
// Read ONE base64 image back from Firestore — a single { data } doc, or reassembled from its chunks.
async function firestoreReadImage(id) {
  const doc = await db.collection(IMG_COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  const d = doc.data() || {};
  if (typeof d.data === "string") { const p = parseDataUrl(d.data); return p ? { buffer: p.buffer, contentType: p.contentType } : null; }
  if (d.chunks) {
    const snaps = await Promise.all(Array.from({ length: d.chunks }, (_, i) => db.collection(IMG_COLLECTION).doc(id + "~" + i).get()));
    let full = "";
    for (const s of snaps) { if (!s.exists) return null; full += (s.data() && s.data().data) || ""; }   // a missing chunk → treat as not-found (never a partial image)
    const p = parseDataUrl(full);
    return p ? { buffer: p.buffer, contentType: p.contentType } : null;
  }
  return null;
}
// store ONE base64 image and return its id, so the browser can offload a photo the moment
// it's attached and keep the booking payload tiny (instead of pushing the whole list with
// every image inline, which overflows the host's request-size limit). Returns null on the
// file backend (no offload there) so the caller just keeps the inline base64.
async function putImage(dataUrl) {
  if (!isDataUrl(dataUrl)) return null;
  if (backend !== "firestore") return null;
  const id = imageId(dataUrl);
  if (knownImageIds.has(id)) return id;          // already uploaded this process → reuse
  if (bucket) {
    await uploadImage(id, dataUrl);
  } else {
    await firestoreWriteImage(id, dataUrl);
  }
  knownImageIds.add(id);
  return id;
}
// fetch one image by id for the GET /img/:id endpoint — Storage first, then the
// legacy Firestore image doc (so photos saved before the migration still work).
async function getImage(id) {
  if (bucket) {
    try {
      const file = bucket.file(IMG_DIR + "/" + id);
      const [exists] = await file.exists();
      if (exists) {
        const [meta] = await file.getMetadata();
        const [buf] = await file.download();
        return { buffer: buf, contentType: meta.contentType || "application/octet-stream" };
      }
    } catch (e) { /* fall through to legacy */ }
  }
  if (db) {
    try {
      const img = await firestoreReadImage(id);
      if (img) return img;
    } catch (e) { /* not found */ }
  }
  return null;
}

/* ------------------------ Firestore backend ------------------------ */
// Each shared key is one document { json: "<stringified value>" }. Storing
// the value as a JSON string sidesteps Firestore's type limits (e.g. it
// rejects nested arrays, which booking "lines" use) and keeps round-trips
// loss-free. Read = JSON.parse, write = JSON.stringify.
async function firestoreHydrate() {
  const d = defaults();
  // load the shared docs (image refs are rewritten to /img/<id> URLs, served on
  // demand) — no more pulling every base64 image into memory / into the payload.
  const col = db.collection(FS_COLLECTION);
  const out = {};
  const snap = await col.get();
  const found = {};
  snap.forEach(doc => {
    try { found[doc.id] = JSON.parse(doc.data().json); }
    catch (e) { /* unreadable doc → leave it ALONE (see below); never overwrite it */ }
  });
  for (const k of SHARED_KEYS) {
    out[k] = (k in found) ? inlineImages(found[k]) : d[k];   // missing/unreadable → in-memory default only
  }
  // IMPORTANT: hydrate NEVER writes to Firestore. The old code seeded empty defaults for any key
  // it couldn't read and WROTE them back — so a transiently unreadable/missing bookings doc on a
  // cold start would be overwritten with [], wiping everything "a few hours later" when a new
  // serverless instance spun up. Missing keys are created by the first real save instead.
  return out;
}

// offload any new base64 images (to Cloud Storage if available, else the legacy
// Firestore image docs), then store the shared doc which holds only tiny refs.
async function firestorePersistKey(key) {
  const { clean, images } = extractImages(cache[key]);
  const writes = [];
  for (const id in images) {
    if (knownImageIds.has(id)) continue;                 // already uploaded this process
    const dataUrl = images[id];
    if (bucket) {
      // Cloud Storage — no size limit, uses the bucket you purchased. A failure
      // PROPAGATES (no .catch) so the whole save is reported as failed and the
      // client keeps retrying — the photo is never silently dropped.
      writes.push(uploadImage(id, dataUrl).then(() => knownImageIds.add(id)));
    } else {
      // fallback: Firestore image doc(s) — single doc when small, chunked across docs when big
      // (so an image up to ~2MB still stores without a Storage bucket, and is never dropped).
      writes.push(firestoreWriteImage(id, dataUrl).then(() => knownImageIds.add(id)));
    }
  }
  if (writes.length) await Promise.all(writes);
  return db.collection(FS_COLLECTION).doc(key).set({ json: JSON.stringify(clean) });
}

function firestoreDeleteKey(key) {
  return db.collection(FS_COLLECTION).doc(key).delete();
}

// merge two id-keyed lists: last write wins per id, but NEVER un-delete a soft-deleted record
function mergeById(stored, incoming) {
  const byId = new Map();
  for (const b of stored) if (b && b.id != null) byId.set(String(b.id), b);
  for (const b of incoming) {
    if (!b || b.id == null) continue;
    const cur = byId.get(String(b.id));
    if (cur) {
      if (cur.deleted && !b.deleted) continue;            // never un-delete a tombstoned record
      // keep the most-recently-EDITED record. A record WITH an updatedAt stamp is newer than
      // one without — so an un-stamped (or older) stale client can't clobber a newer edit made
      // elsewhere (e.g. a deposit marked returned).
      if (cur.updatedAt && (!b.updatedAt || String(b.updatedAt) < String(cur.updatedAt))) continue;
    }
    byId.set(String(b.id), b);
  }
  return Array.from(byId.values());
}

// ---- Activity log merge (audit trail — nothing may ever be lost) --------------------------------
// The activity log is an append-only record of who did what, used to track employees, so entries
// from EVERY device/user must survive. It merges like the id-keyed lists but with two differences:
//   (a) legacy entries predate the per-entry `id`, so we key by `id` WHEN PRESENT and otherwise by
//       a content key (time|user|action) that is identical on every device holding the same entry —
//       so old id-less entries are NEVER dropped (which plain mergeById would do) and duplicates
//       across devices still collapse to one; and
//   (b) it grows forever, so we cap it to a byte budget safely under Firestore's ~1MB doc limit,
//       keeping the NEWEST entries. Older ones live on in the daily backups.
const ACTIVITY_LOG_KEY = "shph_activity_log";
const ACTIVITY_MAX_BYTES = 800000;   // ~5–6k entries; well under the 1,048,576-byte Firestore doc limit
const ACTIVITY_KEEP_DAYS = 90;       // how far back the live log goes; older entries live on in the daily backups
function activityEntryKey(e) {
  if (e && e.id != null) return "id:" + String(e.id);
  return "c:" + String((e && e.at) || "") + "|" + String((e && e.user) || "") + "|" + String((e && e.action) || "");
}
function mergeActivityLog(stored, incoming) {
  const byKey = new Map();
  const add = (e) => { if (e && (e.at || e.action || e.id != null)) byKey.set(activityEntryKey(e), e); };
  (Array.isArray(stored) ? stored : []).forEach(add);
  (Array.isArray(incoming) ? incoming : []).forEach(add);   // incoming wins on a key collision (same entry)
  // oldest → newest by ISO `at` (lexical == chronological); trim the OLDEST until under the budget
  let arr = Array.from(byKey.values()).sort((a, b) => String((a && a.at) || "").localeCompare(String((b && b.at) || "")));
  // 90 days of history, Pia's rule. It is an employee audit trail, so the window has to be long
  // enough to settle a pay dispute — but it grows every day forever and every page load carried it.
  // Anything older still exists in the daily backups; it just stops riding along in the live doc.
  const cutoff = new Date(Date.now() - ACTIVITY_KEEP_DAYS * 864e5).toISOString();
  const recent = arr.filter(e => e && typeof e.at === "string" && e.at >= cutoff);
  if (recent.length) arr = recent;                          // never empty the log on a bad/absent stamp
  if (arr.length > 6000) arr = arr.slice(-6000);            // coarse count cap first (bounds the stringify cost)
  while (arr.length > 1 && Buffer.byteLength(JSON.stringify(arr)) > ACTIVITY_MAX_BYTES) {
    arr = arr.slice(Math.max(1, Math.floor(arr.length * 0.05)));   // drop ~5% oldest per pass; converges fast
  }
  return arr;
}

// Rolling SAFETY BACKUP: after a successful bookings write, save the result to a dated doc in a
// separate "shph_backups" collection. Never backs up an empty list and never lets a backup
// shrink — so even an unknown future bug is recoverable. Best-effort: a failure never breaks the
// real write.
async function backupList(key, merged) {
  try {
    if (backend !== "firestore") return;
    if (key !== "shph_bookings_v3") return;                       // only the critical store, for now
    if (!Array.isArray(merged) || merged.length === 0) return;    // never back up an empty list
    const day = new Date().toISOString().slice(0, 10);            // one rolling restore point per day
    const ref = db.collection(BACKUP_COLLECTION).doc(key + "_" + day);
    const snap = await ref.get();
    if (snap.exists && (snap.data().count || 0) > merged.length) return;   // don't let a backup shrink
    await ref.set({ json: JSON.stringify(merged), count: merged.length, at: new Date().toISOString() });
  } catch (e) { console.warn("[store] backup skipped:", e.message); }
}

// ATOMIC per-item merge write for id-keyed list stores. On Firestore it reads the LIVE
// document inside a transaction (NOT the possibly-stale in-memory cache), merges the
// incoming items by id, and writes — so two concurrent saves (different users, server
// instances, or during a deploy) can never overwrite each other or drop a record.
async function mergeListWrite(key, incoming) {
  if (!Array.isArray(incoming)) {                       // not a list → normal durable write
    ensureLoaded()[key] = incoming;
    if (backend === "firestore") await firestorePersistKey(key); else filePersist();
    return;
  }
  const mergeFn = (key === ACTIVITY_LOG_KEY) ? mergeActivityLog : mergeById;   // audit log unions by content, never drops
  if (backend !== "firestore") {                        // file backend: single process, no concurrency
    const cur = ensureLoaded()[key];
    cache[key] = mergeFn(Array.isArray(cur) ? cur : [], incoming);
    filePersist();
    return;
  }
  // 1) upload any NEW base64 images first (outside the txn) so the doc holds only tiny refs
  const { clean: incomingClean, images } = extractImages(incoming);
  const imgWrites = [];
  for (const id in images) {
    if (knownImageIds.has(id)) continue;
    const dataUrl = images[id];
    if (bucket) {
      imgWrites.push(uploadImage(id, dataUrl).then(() => knownImageIds.add(id)));
    } else {
      if (Buffer.byteLength(dataUrl) > IMG_MAX_BYTES) throw new Error(`image ${id} exceeds 1MB and no Storage bucket configured`);
      imgWrites.push(db.collection(IMG_COLLECTION).doc(id).set({ data: dataUrl }).then(() => knownImageIds.add(id)));
    }
  }
  if (imgWrites.length) await Promise.all(imgWrites);
  // 2) atomic read-merge-write against the LIVE doc
  const ref = db.collection(FS_COLLECTION).doc(key);
  let merged = [];
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    let stored = [];
    if (snap.exists) { try { stored = JSON.parse(snap.data().json) || []; } catch (e) { stored = []; } }
    merged = mergeFn(stored, incomingClean);
    txn.set(ref, { json: JSON.stringify(merged) });
  });
  // 3) refresh the cache with the authoritative result (refs → /img/ urls)
  if (cache) cache[key] = inlineImages(merged);
  await backupList(key, merged);   // best-effort rolling backup
}

// ATOMIC single-record change in an id-keyed list (cancel/reinstate/delete a booking).
// Reads the LIVE doc in a transaction so it never overwrites the whole list from a stale
// cache. Returns true if the record was found and changed.
async function updateOneFresh(key, id, mutate) {
  if (backend !== "firestore") {
    const arr = ensureLoaded()[key] || [];
    const idx = arr.findIndex(x => String(x.id) === String(id));
    if (idx < 0) return false;
    mutate(arr[idx]);
    arr[idx].updatedAt = new Date().toISOString();   // mark edit time so a stale save can't clobber it
    filePersist();
    return true;
  }
  const ref = db.collection(FS_COLLECTION).doc(key);
  let found = false, merged = [];
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    let arr = [];
    if (snap.exists) { try { arr = JSON.parse(snap.data().json) || []; } catch (e) { arr = []; } }
    const idx = arr.findIndex(x => String(x.id) === String(id));
    merged = arr;
    if (idx < 0) { found = false; return; }
    mutate(arr[idx]);
    arr[idx].updatedAt = new Date().toISOString();   // mark edit time so a stale save can't clobber it
    found = true;
    txn.set(ref, { json: JSON.stringify(arr) });
  });
  if (found && cache) cache[key] = inlineImages(merged);
  if (found) await backupList(key, merged);   // best-effort rolling backup
  return found;
}

// Delete ONE stored image by its /img/<id> id — the Storage object and/or the legacy
// Firestore image doc. Used by the ID-photo retention purge; callers must first make sure
// no other record still references the id (image ids are content-hashed and can be shared).
async function deleteImageById(id) {
  if (backend !== "firestore" || !id) return false;
  let done = false;
  if (bucket) { try { await bucket.file(IMG_DIR + "/" + id).delete({ ignoreNotFound: true }); done = true; } catch (e) {} }
  try {
    // if this image was stored chunked, delete every chunk doc too (so nothing is orphaned)
    const doc = await db.collection(IMG_COLLECTION).doc(id).get();
    const n = (doc.exists && doc.data() && doc.data().chunks) || 0;
    if (n) { try { await Promise.all(Array.from({ length: n }, (_, i) => db.collection(IMG_COLLECTION).doc(id + "~" + i).delete())); } catch (e) {} }
    await db.collection(IMG_COLLECTION).doc(id).delete(); done = true;
  } catch (e) {}
  try { knownImageIds.delete(id); } catch (e) {}
  return done;
}

// Transactionally set ONE property of an OBJECT-shaped shared key (e.g. the housekeeping log,
// which maps bookingId → cleaning entry). Two cleaners saving different havens at the same time
// can never clobber each other — each write merges just its own property into the LIVE doc.
async function setObjectProp(key, prop, value) {
  if (backend !== "firestore") {
    const c = ensureLoaded();
    const cur = c[key];
    const obj = (cur && typeof cur === "object" && !Array.isArray(cur)) ? cur : {};
    obj[prop] = value;
    c[key] = obj;
    filePersist();
    return true;
  }
  const ref = db.collection(FS_COLLECTION).doc(key);
  let merged = {};
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    let obj = {};
    if (snap.exists) { try { obj = JSON.parse(snap.data().json) || {}; } catch (e) { obj = {}; } }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) obj = {};   // default seed was []
    obj[prop] = value;
    merged = obj;
    txn.set(ref, { json: JSON.stringify(obj) });
  });
  if (cache) cache[key] = merged;
  return true;
}

/* ---------------- Housekeeping log (bookingId → cleaning entry) ----------------
   The cleaning entry { startedAt, doneAt, doneBy, photos:{room:ref}, history:[] } is edited from
   several phones at once and is the ONLY record of a cleaner's work (it drives housekeeping pay),
   so a write must NEVER replace it. A browser builds its copy once at page load; posting that whole
   copy back was a RAW REPLACE that silently deleted photos and history the tab had never seen.
   Everything below merges into the LIVE entry inside a transaction instead:
     • photos merge KEY BY KEY (a kitchen photo can't drop a bedroom photo),
     • history APPENDS and dedupes by a stable per-entry id (content key for legacy id-less
       entries) — the exact approach the activity log uses above, deliberately not a third style. */
const CLEANING_KEY = "shph_cleaning_v1";
const CLEANING_MAX_HISTORY = 400;      // one booking's log never legitimately grows past this
function cleaningHistoryKey(h) {
  if (h && h.id != null) return "id:" + String(h.id);
  return "c:" + String((h && h.at) || "") + "|" + String((h && h.user) || "") + "|" + String((h && h.action) || "");
}
function mergeCleaningHistory(stored, incoming) {
  const byKey = new Map();
  const add = (h) => { if (h && (h.at || h.action || h.id != null)) byKey.set(cleaningHistoryKey(h), h); };
  (Array.isArray(stored) ? stored : []).forEach(add);
  (Array.isArray(incoming) ? incoming : []).forEach(add);   // same entry from 2 devices → one row
  const arr = Array.from(byKey.values())
    .sort((a, b) => String((a && a.at) || "").localeCompare(String((b && b.at) || "")));   // ISO: lexical == chronological
  return arr.length > CLEANING_MAX_HISTORY ? arr.slice(-CLEANING_MAX_HISTORY) : arr;
}
// Damage/issue reports merge exactly like history — they are evidence (they feed the violation
// detection that charges a guest's security deposit), so two cleaners reporting different damage
// from different phones must BOTH survive. Keyed by id when present, else by content.
function cleaningReportKey(r) {
  if (r && r.id != null) return "id:" + String(r.id);
  return "c:" + String((r && r.at) || "") + "|" + String((r && r.user) || "") + "|" + String((r && r.note) || "");
}
function mergeCleaningReports(stored, incoming) {
  const byKey = new Map();
  const add = (r) => { if (r && (r.note || r.at || r.id != null)) byKey.set(cleaningReportKey(r), r); };
  (Array.isArray(stored) ? stored : []).forEach(add);
  (Array.isArray(incoming) ? incoming : []).forEach(add);
  const arr = Array.from(byKey.values())
    .sort((a, b) => String((a && a.at) || "").localeCompare(String((b && b.at) || "")));
  return arr.length > CLEANING_MAX_HISTORY ? arr.slice(-CLEANING_MAX_HISTORY) : arr;
}
// A photo value must be a stored-image reference — never a javascript:/inline-HTML payload. The
// dashboard renders these straight into an <a href> and <img src> in the ADMIN's browser, so a
// scoped-partner session could otherwise plant a script there with one small POST.
const CLEANING_REF_RE = /^(\/img\/|shphimg::|data:image\/)/;
const isCleaningRef = (v) => typeof v === "string" && CLEANING_REF_RE.test(v);
// Cap the free-text fields so one entry can't be inflated (the whole map is ONE Firestore doc).
function sanitizeHistoryRow(h) {
  if (!h || typeof h !== "object" || Array.isArray(h)) return null;
  const out = {
    user: String(h.user == null ? "" : h.user).slice(0, 80),
    action: String(h.action == null ? "" : h.action).slice(0, 300),
    at: (typeof h.at === "string" && h.at) ? h.at.slice(0, 40) : new Date().toISOString()
  };
  if (h.id != null) out.id = String(h.id).slice(0, 60);
  return out;
}
function sanitizeReportRow(r, fallbackAt) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const out = {
    note: String(r.note == null ? "" : r.note).slice(0, 2000),
    user: String(r.user == null ? "" : r.user).slice(0, 80),
    at: (typeof r.at === "string" && r.at) ? r.at.slice(0, 40) : fallbackAt
  };
  if (r.id != null) out.id = String(r.id).slice(0, 60);
  return out;
}
function emptyCleaningEntry() { return { startedAt: null, doneAt: null, photos: {}, history: [], reports: [] }; }
// Every cleaning timestamp is compared as a STRING (ISO sorts chronologically), and payroll pays off
// iso(new Date(doneAt)) — so a stamp that isn't ISO isn't just untidy, it wins those compares and
// moves a cleaner's money. Anything that fails this is discarded and replaced with the server's now.
function isIsoStamp(v) { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && !isNaN(Date.parse(v)); }
function asCleaningEntry(v) {
  const e = (v && typeof v === "object" && !Array.isArray(v)) ? Object.assign({}, v) : emptyCleaningEntry();
  e.photos = (e.photos && typeof e.photos === "object" && !Array.isArray(e.photos)) ? Object.assign({}, e.photos) : {};
  e.history = Array.isArray(e.history) ? e.history.slice() : [];
  e.reports = Array.isArray(e.reports) ? e.reports.slice() : [];
  return e;
}

// Apply ONE action to the live entry. This is the path new clients use: they describe what the
// cleaner just did instead of shipping their whole (stale) copy, so nothing else can be lost.
function applyCleaningDelta(live, delta) {
  const e = asCleaningEntry(live);
  const d = delta || {};
  // The stamp MUST be a real ISO date. Payroll buckets a cleaned room by iso(new Date(doneAt)), so a
  // hand-crafted stamp like 999999999 or "zzz" would beat a real date in the string compare below,
  // bury the room in 1970 and silently move the money to whoever sent it. Reject, don't trust.
  const at = isIsoStamp(d.at) ? d.at : new Date().toISOString();
  const room = (typeof d.room === "string" && d.room) ? d.room.slice(0, 40) : "";
  switch (d.op) {
    case "start":
      e.startedAt = at;
      if (e.doneAt && e.doneAt < e.startedAt) { e.doneAt = null; e.doneBy = null; }   // restarted after a done → re-open
      break;
    case "done":
      e.doneAt = at;
      if (d.by) e.doneBy = String(d.by).slice(0, 80);          // who finished it → drives housekeeping payroll
      if (!e.startedAt) e.startedAt = at;                      // never leave a done task with no start
      break;
    case "undoStart":
      e.startedAt = null; e.doneAt = null; e.doneBy = null;
      break;
    case "undoDone":
      e.doneAt = null; e.doneBy = null;
      break;
    case "addPhoto":
      if (!room || !isCleaningRef(d.ref)) throw new Error("addPhoto needs room + a valid image ref");
      e.photos[room] = d.ref;                                  // touches ONLY this room's slot
      break;
    case "removePhoto":
      if (!room) throw new Error("removePhoto needs room");
      delete e.photos[room];                                   // a real delete of one slot — the map survives
      break;
    case "report": {
      // damage/issue report: APPENDS like history. It used to ride along on a whole-entry save,
      // which destroyed a report another cleaner had just filed on a different phone.
      const r = sanitizeReportRow(d.report, at);
      if (!r || !r.note) throw new Error("report needs a note");
      e.reports = mergeCleaningReports(e.reports, [r]);
      break;
    }
    default:
      throw new Error("unknown cleaning op: " + String(d.op));
  }
  const h = d.history ? sanitizeHistoryRow(d.history) : null;
  if (h) e.history = mergeCleaningHistory(e.history, [h]);
  return e;
}

// BACKWARD COMPATIBILITY: an old browser tab that is still open keeps POSTing its whole entry.
// Treat that as a MERGE, never a replace — union the photos, append+dedupe the history, and keep
// any field the server holds that the stale payload lacks. A null/blank in the payload does NOT
// clear a saved value (a stale tab must not be able to erase a doneAt that pays a cleaner); real
// undos come through the delta path, which clears fields explicitly.
const CLEANING_PAY_FIELDS = { startedAt: 1, doneAt: 1, doneBy: 1 };
function mergeCleaningEntry(live, incoming) {
  const e = asCleaningEntry(live);
  const inc = (incoming && typeof incoming === "object" && !Array.isArray(incoming)) ? incoming : {};
  for (const k in inc) {
    if (k === "photos" || k === "history" || k === "reports" || CLEANING_PAY_FIELDS[k]) continue;
    const v = inc[k];
    if ((v == null || v === "") && e[k] != null && e[k] !== "") continue;   // never let a stale blank win
    e[k] = v;
  }
  /* THE PAY FIELDS ARE AGE-AWARE — this decides WHO GETS PAID. Payroll buckets a cleaning by
     iso(doneAt) + doneBy, so letting a stale-but-non-blank payload win would move the room off the
     cleaner who actually finished it onto an older entry's cleaner, on the wrong day. So:
       • doneAt/doneBy only advance when the incoming doneAt is NEWER, and they move as a PAIR
         (falling back to the stored name, never to nobody, so the credit can't evaporate);
       • startedAt keeps the EARLIER stamp — the true moment the work began. */
  /* Both comparisons below are STRING compares, which is only safe while every stamp is a real ISO
     date. An out-of-format value (999999999, "zzz") would win them outright and hand the room — and
     the pay — to whoever sent it, so anything that isn't ISO is ignored here rather than trusted. */
  const s = (v) => String(v == null ? "" : v);
  const incDone = isIsoStamp(inc.doneAt) ? inc.doneAt : null;
  const incStart = isIsoStamp(inc.startedAt) ? inc.startedAt : null;
  if (incDone && incDone > s(e.doneAt)) {
    e.doneAt = incDone;
    e.doneBy = (inc.doneBy == null || inc.doneBy === "") ? (e.doneBy || null) : inc.doneBy;
  } else if (incDone && incDone === s(e.doneAt) && !e.doneBy && inc.doneBy) {
    e.doneBy = inc.doneBy;                                    // same finish, we were just missing the name
  }
  if (incStart && (!s(e.startedAt) || incStart < s(e.startedAt))) e.startedAt = incStart;
  // union photos key by key, ignoring anything that isn't a real stored-image ref
  for (const k in inc.photos || {}) { if (isCleaningRef(inc.photos[k])) e.photos[k] = inc.photos[k]; }
  e.history = mergeCleaningHistory(e.history, (Array.isArray(inc.history) ? inc.history : []).map(sanitizeHistoryRow).filter(Boolean));
  e.reports = mergeCleaningReports(e.reports, (Array.isArray(inc.reports) ? inc.reports : []).map(r => sanitizeReportRow(r, new Date().toISOString())).filter(Boolean));
  return e;
}

// Transactionally read → mutate → write ONE booking's cleaning entry against the LIVE document
// (mirrors updateOneFresh). Returns the merged entry so the caller can hand it back to the client,
// letting a stale tab adopt the truth instead of fighting the server.
async function updateCleaningEntry(bookingId, mutate) {
  const id = String(bookingId);
  if (backend !== "firestore") {
    const c = ensureLoaded();
    let obj = c[CLEANING_KEY];
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) obj = {};   // default seed was []
    const out = mutate(obj[id]);
    obj[id] = out;
    c[CLEANING_KEY] = obj;
    filePersist();
    return inlineImages(out);
  }
  const ref = db.collection(FS_COLLECTION).doc(CLEANING_KEY);
  let out = null, merged = {};
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    let obj = {};
    if (snap.exists) { try { obj = JSON.parse(snap.data().json) || {}; } catch (e) { obj = {}; } }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) obj = {};
    out = mutate(obj[id]);          // reads the LIVE entry — never this instance's cached copy
    obj[id] = out;
    merged = obj;
    txn.set(ref, { json: JSON.stringify(obj) });
  });
  if (cache) cache[CLEANING_KEY] = merged;
  warnCleaningDocSize(merged);
  // hand the client a copy with image refs resolved to /img urls — LEGACY entries can still hold
  // "shphimg::<id>" refs from the old whole-key write path, and the client renders these directly
  return inlineImages(out);
}

// The WHOLE cleaning map is one Firestore document (~1,048,576-byte ceiling) and the history/report
// unions now retain strictly more rows than the old replace did. If it ever reaches the limit EVERY
// cleaning save starts failing at once, so shout in the logs well before that happens.
const CLEANING_WARN_BYTES = 700000;
function warnCleaningDocSize(obj) {
  try {
    const bytes = Buffer.byteLength(JSON.stringify(obj || {}));
    if (bytes > CLEANING_WARN_BYTES) {
      console.warn("[store] cleaning log is " + bytes + " bytes — approaching the ~1MB Firestore doc limit. "
        + "Archive old entries before saves start failing.");
    }
  } catch (e) { /* never let a size probe break a save */ }
}

// Merge a WHOLE cleaning map (bookingId → entry) into the live one, in a single transaction.
// Only path for a whole-map write: PUT /api/kv/shph_cleaning_v1 would otherwise REPLACE the map and
// erase every booking's photos and history (a legacy queued write from an old tab can still fire it).
async function mergeCleaningMap(incoming) {
  const inc = (incoming && typeof incoming === "object" && !Array.isArray(incoming)) ? incoming : {};
  const mergeAll = (obj) => {
    for (const id in inc) obj[id] = mergeCleaningEntry(obj[id], inc[id]);
    return obj;
  };
  if (backend !== "firestore") {
    const c = ensureLoaded();
    let obj = c[CLEANING_KEY];
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) obj = {};
    c[CLEANING_KEY] = mergeAll(obj);
    filePersist();
    return c[CLEANING_KEY];
  }
  const ref = db.collection(FS_COLLECTION).doc(CLEANING_KEY);
  let merged = {};
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    let obj = {};
    if (snap.exists) { try { obj = JSON.parse(snap.data().json) || {}; } catch (e) { obj = {}; } }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) obj = {};
    merged = mergeAll(obj);
    txn.set(ref, { json: JSON.stringify(merged) });
  });
  if (cache) cache[CLEANING_KEY] = merged;
  warnCleaningDocSize(merged);
  return merged;
}

// Live read of ONE booking's cleaning entry. The DONE button refuses to finish a task with a
// missing room photo, so that check has to run against the server's truth — a tab whose copy is
// hours old would otherwise block a cleaner (and their pay) over photos that ARE saved.
async function readCleaningEntry(bookingId) {
  const id = String(bookingId);
  if (backend !== "firestore") {
    const obj = ensureLoaded()[CLEANING_KEY];
    return (obj && typeof obj === "object" && !Array.isArray(obj)) ? (obj[id] || null) : null;
  }
  const snap = await db.collection(FS_COLLECTION).doc(CLEANING_KEY).get();
  let obj = {};
  if (snap.exists) { try { obj = JSON.parse(snap.data().json) || {}; } catch (e) { obj = {}; } }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  return inlineImages(obj[id] || null);
}

// Read ONE shared key straight from Firestore (not the possibly-stale per-instance cache), image
// refs inlined. Used where a warm instance must NOT serve stale data — e.g. the website maintenance
// flag, which has to take effect the moment the owner flips it. Falls back to the cache on any error.
async function readFreshKey(key) {
  if (backend !== "firestore") return ensureLoaded()[key];
  try {
    const snap = await db.collection(FS_COLLECTION).doc(key).get();
    if (snap.exists) return inlineImages(JSON.parse(snap.data().json));
  } catch (e) { /* fall back to cache */ }
  return ensureLoaded()[key];
}

// Read the LIVE id-keyed list straight from Firestore (not the possibly-stale in-memory cache of
// this serverless instance), image refs inlined to /img urls. Used when the client must see the
// current truth (e.g. a booking's saved guest IDs) before editing, so a stale browser can't hide
// or overwrite saved data.
async function readFreshList(key) {
  if (backend !== "firestore") return ensureLoaded()[key] || [];
  const snap = await db.collection(FS_COLLECTION).doc(key).get();
  let arr = [];
  if (snap.exists) { try { arr = JSON.parse(snap.data().json) || []; } catch (e) { arr = []; } }
  return inlineImages(arr);
}

// ATOMIC insert-or-replace of ONE item (by id) in an id-keyed list. Reads the LIVE doc in a
// transaction, so adding/editing one expense/bill can never overwrite the rest. Any base64
// images in the item (e.g. an expense receipt) are offloaded to refs first.
async function upsertOne(key, item) {
  if (!item || item.id == null) throw new Error("upsertOne needs an item with an id");
  if (backend !== "firestore") {
    const arr = ensureLoaded()[key] || [];
    item.updatedAt = new Date().toISOString();
    const idx = arr.findIndex(x => String(x.id) === String(item.id));
    if (idx >= 0) arr[idx] = item; else arr.push(item);
    cache[key] = arr; filePersist(); return;
  }
  // offload any base64 images in the item first (so the stored doc holds only tiny refs)
  const { clean, images } = extractImages(item);
  const imgWrites = [];
  for (const id in images) {
    if (knownImageIds.has(id)) continue;
    const dataUrl = images[id];
    if (bucket) imgWrites.push(uploadImage(id, dataUrl).then(() => knownImageIds.add(id)));
    else {
      if (Buffer.byteLength(dataUrl) > IMG_MAX_BYTES) throw new Error(`image ${id} exceeds 1MB and no Storage bucket configured`);
      imgWrites.push(db.collection(IMG_COLLECTION).doc(id).set({ data: dataUrl }).then(() => knownImageIds.add(id)));
    }
  }
  if (imgWrites.length) await Promise.all(imgWrites);
  clean.updatedAt = new Date().toISOString();
  const ref = db.collection(FS_COLLECTION).doc(key);
  let merged = [];
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    let arr = [];
    if (snap.exists) { try { arr = JSON.parse(snap.data().json) || []; } catch (e) { arr = []; } }
    const idx = arr.findIndex(x => String(x.id) === String(clean.id));
    if (idx >= 0) arr[idx] = clean; else arr.push(clean);
    merged = arr;
    txn.set(ref, { json: JSON.stringify(arr) });
  });
  if (cache) cache[key] = inlineImages(merged);
}

/* ------------------------- Full daily backup ------------------------ */
// Philippine calendar day (UTC+8) as YYYY-MM-DD — matches how the rest of the app dates things.
function phDay() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// Read the RAW stored value of a shared key straight from Firestore, with image references
// (shphimg::<id>) left INTACT — so a backup round-trips loss-free (restore writes the exact
// refs back, and the images themselves already live durably in Cloud Storage). Falls back to
// the (image-inlined) cache when there is no Firestore backend.
async function readRawKey(key) {
  if (backend !== "firestore") return ensureLoaded()[key];
  try {
    const snap = await db.collection(FS_COLLECTION).doc(key).get();
    if (snap.exists) return JSON.parse(snap.data().json);
  } catch (e) { /* fall back to cache */ }
  return ensureLoaded()[key];
}

// FULL backup of EVERY shared key → one dated doc per key in shph_backups. Runs daily (Vercel
// cron) so a restore point exists even on a day nobody edited anything. Guards, per key:
//   • never back up an EMPTY list over an existing good one, and
//   • never let a list backup SHRINK within the same day.
// Then prunes restore points older than BACKUP_RETENTION_DAYS. Best-effort per key: one key
// failing never aborts the rest. Returns a summary.
async function backupAll() {
  if (backend !== "firestore") return { ok: false, error: "no-firestore-backend" };
  const day = phDay();
  const col = db.collection(BACKUP_COLLECTION);
  const result = { ok: true, day, keys: {}, pruned: 0 };
  for (const key of SHARED_KEYS) {
    try {
      const value = await readRawKey(key);
      const isList = Array.isArray(value);
      const count = isList ? value.length
        : (value && typeof value === "object" ? Object.keys(value).length : (value != null ? 1 : 0));
      if (isList && count === 0) { result.keys[key] = "skipped-empty"; continue; }   // don't clobber a good backup with []
      const ref = col.doc(key + "_" + day);
      const snap = await ref.get();
      if (isList && snap.exists && (snap.data().count || 0) > count) { result.keys[key] = "kept-larger"; continue; }
      await ref.set({ json: JSON.stringify(value), count, key, day, at: new Date().toISOString() });
      result.keys[key] = count;
    } catch (e) {
      result.keys[key] = "error:" + e.message;
    }
  }
  // prune restore points older than the retention window
  try {
    const cutoff = new Date(Date.now() + 8 * 3600 * 1000 - BACKUP_RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
    // .select() with no fields returns document REFS only. A plain col.get() would pull every
    // restore point's full `json` snapshot (~16 keys x 30 days of whole-database blobs) across the
    // wire just to read the ids — slow, billed per read, and a serverless timeout risk.
    const all = await col.select().get();
    const dels = [];
    all.forEach(doc => {
      const m = /_(\d{4}-\d{2}-\d{2})$/.exec(doc.id);
      if (m && m[1] < cutoff) dels.push(doc.ref.delete());
    });
    result.pruned = dels.length;
    if (dels.length) await Promise.all(dels);
  } catch (e) { result.pruneError = e.message; }
  return result;
}

// One self-contained, downloadable snapshot of ALL data — the off-site copy (email + download +
// local tools/backup.js). Raw image refs preserved so re-importing it is loss-free.
async function snapshot() {
  const data = {};
  for (const key of SHARED_KEYS) {
    try { data[key] = await readRawKey(key); } catch (e) { data[key] = null; }
  }
  return {
    meta: { app: "staycation-haven-ph", at: new Date().toISOString(), day: phDay(),
            backend, project: projectId, keys: SHARED_KEYS.length },
    data
  };
}

// List every available restore point (doc id → {key, day, count, at}) for the restore UI/CLI.
async function listBackups() {
  if (backend !== "firestore") return {};
  const out = {};
  // metadata only — never pull the `json` snapshot blobs just to list what's available
  const snap = await db.collection(BACKUP_COLLECTION).select("key", "day", "count", "at").get();
  snap.forEach(doc => {
    const d = doc.data() || {};
    out[doc.id] = { key: d.key || null, day: d.day || null, count: d.count || 0, at: d.at || null };
  });
  return out;
}

// Restore ONE key from a dated backup back into the live store. DESTRUCTIVE — replaces the live
// value for that key. Guarded at the route layer by the backup secret. Returns the count restored.
async function restoreKey(key, day) {
  if (backend !== "firestore") throw new Error("restore needs the Firestore backend");
  if (!SHARED_KEYS.includes(key)) throw new Error("unknown key: " + key);
  const snap = await db.collection(BACKUP_COLLECTION).doc(key + "_" + day).get();
  if (!snap.exists) throw new Error("no backup for " + key + " on " + day);
  const value = JSON.parse(snap.data().json);
  await db.collection(FS_COLLECTION).doc(key).set({ json: JSON.stringify(value) });
  if (cache) cache[key] = inlineImages(value);
  return Array.isArray(value) ? value.length : 1;
}

/* ----------------------------- Lifecycle ---------------------------- */
// Loads the active backend into the in-memory cache. Call once at startup
// and await it before serving requests. Safe to call multiple times.
function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const account = loadServiceAccount();
    if (account) {
      try {
        const { initializeApp, cert, getApps } = require("firebase-admin/app");
        const { getFirestore } = require("firebase-admin/firestore");
        if (!getApps().length) {
          initializeApp({ credential: cert(account) });
        }
        db = getFirestore();
        // resolve a Cloud Storage bucket for images (auto-detect the name).
        try {
          const { getStorage } = require("firebase-admin/storage");
          const pid = account.project_id;
          const candidates = [STORAGE_BUCKET_ENV, pid + ".firebasestorage.app", pid + ".appspot.com"].filter(Boolean);
          for (const name of candidates) {
            try {
              const b = getStorage().bucket(name);
              const [exists] = await b.exists();
              if (exists) { bucket = b; console.log(`[store] image storage: gs://${name}`); break; }
            } catch (e) { /* try next candidate */ }
          }
          if (!bucket) console.warn("[store] no Storage bucket found — images stored in Firestore, chunked across docs (up to ~2MB each). Set FIREBASE_STORAGE_BUCKET to use Cloud Storage (unlimited).");
        } catch (e) { console.warn("[store] Storage init skipped:", e.message); }
        cache = await firestoreHydrate();
        backend = "firestore";
        projectId = account.project_id || null;
        console.log(`[store] backend: Firestore (project ${account.project_id})`);
        return;
      } catch (e) {
        console.error("[store] Firestore init failed, falling back to JSON file:", e.message);
      }
    }
    // ---- File backend (default) ----
    backend = "file";
    cache = fileLoad() || defaults();
    const d = defaults();
    let changed = false;
    for (const k of SHARED_KEYS) {
      if (!(k in cache)) { cache[k] = d[k]; changed = true; }
    }
    if (!fileLoad() || changed) filePersist();
    console.log("[store] backend: local JSON file (data/store.json)");
  })().catch((err) => {
    // If init fails (e.g. a transient Firestore error, then the file fallback's filePersist()
    // throws on a read-only serverless filesystem), don't keep the REJECTED promise cached —
    // reset so the next init() call retries instead of the instance 500ing on every request.
    initPromise = null;
    throw err;
  });
  return initPromise;
}

// Lazy fallback so direct get()/all() still work if init() was never awaited
// (file backend only — Firestore must be initialised via init()).
function ensureLoaded() {
  if (cache) return cache;
  backend = "file";
  cache = fileLoad() || defaults();
  const d = defaults();
  for (const k of SHARED_KEYS) if (!(k in cache)) cache[k] = d[k];
  filePersist();
  return cache;
}

// Write one key through to the active backend. Returns a promise.
function persistKey(key) {
  if (backend === "firestore") {
    return firestorePersistKey(key).catch(e =>
      console.error(`[store] Firestore write failed for "${key}":`, e.message));
  }
  filePersist();
  return Promise.resolve();
}

module.exports = {
  SHARED_KEYS,
  FS_COLLECTION,
  IMG_COLLECTION,
  IMG_MAX_BYTES,
  extractImages,   // exported so the one-time migration reuses the exact same logic
  inlineImages,
  getImage,        // GET /img/:id streams the bytes (Storage, or legacy Firestore)
  putImage,        // POST /api/img stores one photo and returns its id (keeps saves small)
  init,
  backend: () => backend,
  imageStorage: () => !!bucket,   // true when Cloud Storage is active for images
  // A single health snapshot for /api/health: is persistence durable, where do images live,
  // and how many live records are in each shared list right now.
  status() {
    const c = ensureLoaded();
    const counts = {};
    for (const k of SHARED_KEYS) {
      const v = c[k];
      counts[k] = Array.isArray(v) ? v.filter(x => x && !x.deleted).length : (v && Object.keys(v).length ? 1 : 0);
    }
    return {
      ok: backend === "firestore",
      backend,                                                    // "firestore" (durable) | "file" (ephemeral!)
      durable: backend === "firestore",
      project: projectId,
      images: bucket ? "cloud-storage" : "firestore-fallback-1MB-cap",
      imageStorage: !!bucket,      // the dashboard reads this to lift the ID-photo size cap when Storage is on
      bucket: bucket ? bucket.name : null,
      counts,
      at: new Date().toISOString()
    };
  },
  isShared: (key) => SHARED_KEYS.includes(key),
  // return every shared key/value (used to seed each page)
  all() {
    const c = ensureLoaded();
    const out = {};
    for (const k of SHARED_KEYS) out[k] = c[k];
    return out;
  },
  get(key) {
    return ensureLoaded()[key];
  },
  // update the cache synchronously, then write through. Returns a promise
  // callers may await for durability.
  set(key, value) {
    ensureLoaded()[key] = value;
    return persistKey(key);
  },
  // Like set(), but DURABLE: it rejects if the backend write fails instead of
  // swallowing the error. Use for data that must never be silently lost (users),
  // so the API can return an error and the client can retry / warn the user.
  async setStrict(key, value) {
    ensureLoaded()[key] = value;
    if (backend === "firestore") {
      await firestorePersistKey(key);   // no .catch → a Firestore failure propagates
    } else {
      filePersist();
    }
  },
  mergeListWrite,   // atomic per-item merge write for id-keyed lists (multi-user safe)
  backupAll,        // full daily backup of every shared key → shph_backups (+ 30-day prune)
  snapshot,         // one downloadable object of all data (off-site copy: email/download/CLI)
  listBackups,      // list every restore point (for the restore endpoint / CLI)
  restoreKey,       // restore ONE key from a dated backup (destructive — token-guarded)
  updateOneFresh,   // atomic single-record change (cancel/reinstate/delete) — fresh, transactional
  setObjectProp,    // atomic single-property set on an object-shaped key (generic)
  // Housekeeping log — merge-only paths. setObjectProp is a RAW REPLACE and must NOT be used for
  // cleaning entries: it is what let a stale tab delete another device's photos and history.
  applyCleaningDelta,     // apply ONE action (start/done/undo/addPhoto/removePhoto) to an entry
  mergeCleaningEntry,     // merge a whole-entry payload from an old tab into the live entry
  updateCleaningEntry,    // transactional read-mutate-write of ONE booking's entry (returns merged)
  mergeCleaningMap,       // merge a whole bookingId→entry map (blocks a whole-map PUT from erasing it)
  readCleaningEntry,      // live read of ONE booking's entry (photo checks must not use a stale copy)
  deleteImageById,  // remove one stored image (ID-photo retention purge)
  readFreshKey,     // live Firestore read of ONE key (bypasses stale per-instance cache)
  readFreshList,    // live Firestore read of an id-keyed list (bypasses stale per-instance cache)
  upsertOne,        // atomic insert-or-replace of one item by id (expenses/bills per-record)
  remove(key) {
    delete ensureLoaded()[key];
    if (backend === "firestore") {
      return firestoreDeleteKey(key).catch(e =>
        console.error(`[store] Firestore delete failed for "${key}":`, e.message));
    }
    filePersist();
    return Promise.resolve();
  }
};
