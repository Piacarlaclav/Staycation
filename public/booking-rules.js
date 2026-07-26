/* ============================================================
   SHARED BOOKING RULES  (the ONE copy)
   ------------------------------------------------------------
   When a haven is occupied, and which check-in times are still
   sellable. Loaded as a <script> by index.html / havens.html /
   payment.html AND require()d by server.js, so the listing, the
   detail panel and the final server-side guard can never disagree.

   WHY this file exists: the occupied-window maths used to be copied
   into every page, and havens.html/payment.html both computed an
   existing booking's window as `checkin + stayHours`. stayHours is 21
   for ANY overnight — including a 5-night stay — so a multi-night
   booking only blocked ~21 hours and every later night read as free.
   That sold Haven 7 twice (Jul 23-28 + Jul 27). Change the rules HERE,
   never in a page. (dashboard.html + lib/assist.js keep their own copies
   for the back office; this file is ported from them verbatim.)
   ============================================================ */
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;   // server.js
    root.SHB = api;                                                           // public pages
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
"use strict";

/* ------------------------------------------------------------------ times -- */
// standard 21-hour check-in / check-out times, by haven. Keys MUST match the
// strings stored on bookings exactly: "CasaBienca"/"CasaSiesta", no space.
const HAVEN_TIMES = {
    "Haven 1":    { in: "12:00 NN", out: "9:00 AM" },
    "Haven 2":    { in: "12:00 NN", out: "9:00 AM" },
    "Haven 3":    { in: "12:00 NN", out: "9:00 AM" },
    "Haven 4":    { in: "3:00 PM",  out: "12:00 NN" },
    "Haven 5":    { in: "3:00 PM",  out: "12:00 NN" },
    "Haven 7":    { in: "3:00 PM",  out: "12:00 NN" },
    "Haven 8":    { in: "6:00 PM",  out: "3:00 PM" },
    "CasaBienca": { in: "6:00 PM",  out: "3:00 PM" },
    "CasaSiesta": { in: "6:00 PM",  out: "3:00 PM" }
};
// Tolerant lookup: bookings saved before the spelling fix carry "Casa Bienca"
// (with a space) and must still resolve to the right times.
function havenTimes(name) {
    const t = HAVEN_TIMES[name];
    if (t) return t;
    const k = String(name || "").replace(/\s+/g, "");
    const hit = Object.keys(HAVEN_TIMES).find(h => h.replace(/\s+/g, "") === k);
    return hit ? HAVEN_TIMES[hit] : null;
}
// ALL whitespace is stripped, not just the ends — "Casa Bienca" must block "CasaBienca".
function sameHaven(a, b) {
    const norm = s => String(s || "").replace(/\s+/g, "").toLowerCase();
    return norm(a) === norm(b);
}

// "8:00 AM" / "12:00 NN" / "12:00 MN" → minutes after midnight
function parseTimeMin(str) {
    const m = String(str).match(/^(\d{1,2}):(\d{2})\s*(AM|PM|NN|MN)$/i);
    if (!m) return null;
    let h = Number(m[1]); const min = Number(m[2]); const suf = m[3].toUpperCase();
    if (suf === "NN") h = 12; else if (suf === "MN") h = 0; else if (suf === "PM") h = (h % 12) + 12; else h = h % 12;
    return h * 60 + min;
}
// a CHECK-IN of "12:00 MN" means midnight at the END of the day (24:00), not 00:00
function checkinMin(timeStr) {
    const m = parseTimeMin(timeStr);
    if (m == null) return null;
    return m === 0 ? 1440 : m;
}
// Manila midnight of a YYYY-MM-DD as absolute minutes since the epoch. Anchoring to
// +08:00 (not the local zone) is what keeps this identical on Vercel's UTC clock and
// in a guest's browser wherever they are.
const midnightAbs = (iso) => Math.round(Date.parse(iso + "T00:00:00+08:00") / 60000);
// A date is only usable if it is a real YYYY-MM-DD that actually parses. Dates arrive from an
// anonymous POST body, and `b.checkout > b.checkin` is a STRING compare: "9999/99/99" sorts
// above any real date, so garbage used to slip into the multi-night branch and make
// midnightAbs() return NaN. NaN compares false against everything, so the conflict check
// reported "free" for an occupied haven — the guard failing open on the one endpoint it exists
// to protect. Every date is shape-checked before it is trusted.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (d) => typeof d === "string" && ISO_DATE_RE.test(d) && Number.isFinite(midnightAbs(d));
// a { start, end } is only meaningful if both ends are real numbers
const intervalIsValid = (iv) => !!iv && Number.isFinite(iv.start) && Number.isFinite(iv.end);
function addDaysIso(iso, n) {
    return new Date(Date.parse(iso + "T00:00:00+08:00") + n * 864e5 + 8 * 3600e3).toISOString().slice(0, 10);
}
// the day-of-week of an ISO date in Manila (0 Sun … 6 Sat)
const isoWeekday = (iso) => new Date(Date.parse(iso + "T00:00:00+08:00") + 8 * 3600e3).getUTCDay();
// occupied DAY range as a half-open interval [checkin, endExcl); a day-use stay = 1 day
const endExcl = (b) => (b.checkout > b.checkin ? b.checkout : addDaysIso(b.checkin, 1));

/* -------------------------------------------------------- booking window -- */
// an existing booking's check-in minute-of-day (stored time, else derived from the tier)
function bookingCheckinMin(b) {
    if (b.checkinTime) { const m = checkinMin(b.checkinTime); if (m != null) return m; }
    const h = Number(b.stayHours) || 21;
    if (h === 6) return parseTimeMin(b.slot === "evening" ? "7:00 PM" : "8:00 AM");
    if (h === 21) { const t = havenTimes(b.haven); return parseTimeMin(t ? t.in : "12:00 NN"); }
    return parseTimeMin("8:00 AM");   // 10h fallback
}

// The occupied window { start, end } in ABSOLUTE minutes. Ported verbatim from
// dashboard.html bookingInterval() / lib/assist.js — keep all three in step.
function bookingInterval(b) {
    const start = midnightAbs(b.checkin) + bookingCheckinMin(b);
    // An admin-recorded EARLY check-out ends the occupancy the moment the guest actually
    // left, so the freed hours are sellable again. Pricing never reads this.
    const actual = Number(b.actualCheckoutMin) || 0;
    if (actual > 0) return { start, end: start + actual };
    // Overnight stays (incl. MULTI-night) are occupied until the CHECK-OUT DATE's morning.
    // Reading b.checkout here is the whole point: stayHours is 21 for a 5-night stay too,
    // so `start + stayHours` would free nights 2-5 for anyone to book. It sold Haven 7 twice.
    // Both dates must be REAL dates before the string compare below is allowed to mean
    // anything — otherwise malformed input takes this branch and yields a NaN window.
    if (Number(b.stayHours) === 21 && isIsoDate(b.checkin) && isIsoDate(b.checkout) && b.checkout > b.checkin) {
        const checkoutMin = (bookingCheckinMin(b) + (21 + (Number(b.extend) || 0)) * 60) % 1440;
        return { start, end: midnightAbs(b.checkout) + checkoutMin };
    }
    const dur = ((Number(b.stayHours) || 21) + (Number(b.extend) || 0)) * 60;
    return { start, end: start + dur };
}

// a booking is only "live" if it isn't soft-deleted or cancelled — both free the haven
const isLive = (b) => !!b && !b.deleted && !b.cancelled;

/* ---------------------------------------------------------- availability -- */
// ── PIA'S CALL — flip this ONE number, nothing else depends on it ──────────────────────
// Turnaround/cleaning gap required between two stays in the same haven, in minutes.
//   60  = align the website with the back office. dashboard.html (CLEANING_GAP_MIN),
//         todaysbooking.html, nicole-dashboard.html and lib/assist.js ALL use 60; the
//         website's 120 was the lone outlier, so the admin timeline and the public site
//         could disagree about the same haven on the same day.
//   120 = the website's historical value. Keeps a 2-hour margin for housekeeping.
// Measured against the live calendar (9 havens x 60 days from 2026-07-26): 60 opens 67 extra
// check-in slots and 8 whole days that 120 refuses, each leaving housekeeping 60-119 minutes
// instead of >=120. (12,628 vs 12,561 sellable slots; 505 vs 497 sellable days.)
// That is an operations decision about Jedd's team, NOT a correctness one — the standard
// published turnover is 180 min (e.g. CasaBienca out 3:00 PM, in 6:00 PM), so 120 never
// blocked a normal back-to-back overnight. It only bit non-standard check-in times.
// NOTE: this is NOT what caused the "available on the list, fully booked on click" bug —
// that was script.js doing a whole-day overlap check with no cleaning gap, no check-in
// times and no Saturday rule, and it is fixed independently of this number.
const CLEAN_BUFFER_MIN = 60;

// Returns the first live booking whose window clashes with [candStart, candEnd] on the
// same haven, or null. `excludeId` skips the record being re-saved (retry / edit).
function findClash(list, havenName, candStart, candEnd, opts) {
    opts = opts || {};
    const buffer = opts.buffer == null ? CLEAN_BUFFER_MIN : opts.buffer;
    const skip = opts.excludeId == null ? null : String(opts.excludeId);
    return (list || []).find(b => {
        if (!isLive(b)) return false;
        if (skip != null && String(b.id) === skip) return false;
        if (!sameHaven(b.haven, havenName)) return false;
        const iv = bookingInterval(b);
        // FAIL CLOSED. A stored record whose dates don't parse has an unknown window, and a
        // NaN comparison is false against everything — so treating it as "no clash" would hand
        // out a haven that may well be occupied. An unreadable booking blocks its own haven
        // (and only its own) until someone fixes it. Losing a booking is recoverable; selling
        // an occupied room to a guest who has already paid is not.
        if (!intervalIsValid(iv)) return true;
        return candStart < iv.end + buffer && iv.start - buffer < candEnd;
    }) || null;
}

// candidate check-in times for a duration: 6h = AM/PM slots, 10h/21h = flexible window
const FLEX_TIMES = [
    "8:00 AM", "9:00 AM", "10:00 AM", "11:00 AM", "12:00 NN",
    "1:00 PM", "2:00 PM", "3:00 PM", "4:00 PM", "5:00 PM", "6:00 PM",
    "7:00 PM", "8:00 PM", "9:00 PM", "10:00 PM"
];
const SIX_HOUR_MORNING = ["8:00 AM", "9:00 AM", "10:00 AM", "11:00 AM", "12:00 NN"];
const SIX_HOUR_EVENING = ["7:00 PM", "8:00 PM", "9:00 PM", "10:00 PM", "11:00 PM", "12:00 MN"];
const SIX_HOUR_TIMES = SIX_HOUR_MORNING.concat(SIX_HOUR_EVENING);

function rawTimesForHours(hours, checkinIso, havenName) {
    if (hours === 6) return SIX_HOUR_TIMES;
    if (hours === 21 && isoWeekday(checkinIso) === 6) {
        // Saturday overnight → the haven's single standard check-in time
        const t = havenTimes(havenName);
        return [t ? t.in : "3:00 PM"];
    }
    return FLEX_TIMES;   // 10h, and non-Saturday 21h
}

// The check-in times that actually fit on `checkinIso` for this haven: no clash with a
// live booking, cleaning gap respected, and never earlier than `minStartMin` (the caller's
// same-day lead-time floor, in minutes past midnight; null = no floor).
function freeCheckinTimes(list, havenName, hours, checkinIso, extend, minStartMin) {
    extend = Number(extend) || 0;
    const base = midnightAbs(checkinIso);
    return rawTimesForHours(hours, checkinIso, havenName).filter(tStr => {
        const sMin = checkinMin(tStr);
        if (sMin == null) return false;
        if (minStartMin != null && sMin < minStartMin) return false;
        const s = base + sMin;
        return !findClash(list, havenName, s, s + (hours + extend) * 60);
    });
}

// For a SAME-DAY booking the guest needs at least 2 hours' lead time so staff can process
// the guest form and clean the room. Returns the earliest allowed check-in minute-of-day for
// `checkinIso`, or null when that date isn't today (a FUTURE date never gets this floor).
const BOOKING_LEAD_MIN = 120;
function earliestLeadMin(checkinIso) {
    const now = new Date();
    const todayIso = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
    if (checkinIso !== todayIso) return null;
    return now.getHours() * 60 + now.getMinutes() + BOOKING_LEAD_MIN;
}

// Which stay lengths the owner is currently selling (dashboard → Rates & Add-ons).
function offeredHours(pricing) {
    const p = pricing || {};
    return [[6, p.offer6 !== false], [10, p.offer10 !== false], [21, p.offer21 !== false]]
        .filter(([, on]) => on).map(([h]) => h);
}

// Is ANY stay length still bookable on this date? This is the single gate behind BOTH the
// homepage "Available Havens" list and the haven page's calendar/hours dropdown — they said
// different things (listing "available", panel "Fully booked") precisely because they used
// to answer this question with two different implementations.
function dayHasAnyFreeTime(list, havenName, iso, pricing, minStartMin) {
    let hours = offeredHours(pricing);
    // Saturday check-ins are 21-hour (overnight) only — no 6h or 10h day-use
    if (isoWeekday(iso) === 6) hours = hours.filter(h => h === 21);
    return hours.some(h => freeCheckinTimes(list, havenName, h, iso, 0, minStartMin).length > 0);
}

// Multi-night stays need WHOLE days, so any day-range overlap blocks them.
function rangeHasBooking(list, havenName, startIso, endExclIso) {
    return (list || []).some(b => {
        if (!isLive(b)) return false;
        if (!sameHaven(b.haven, havenName)) return false;
        return startIso < endExcl(b) && b.checkin < endExclIso;
    });
}

return {
    HAVEN_TIMES, havenTimes, sameHaven,
    parseTimeMin, checkinMin, midnightAbs, addDaysIso, isoWeekday, endExcl,
    isIsoDate, intervalIsValid,
    bookingCheckinMin, bookingInterval, isLive,
    CLEAN_BUFFER_MIN, findClash, BOOKING_LEAD_MIN, earliestLeadMin,
    FLEX_TIMES, SIX_HOUR_MORNING, SIX_HOUR_EVENING, SIX_HOUR_TIMES,
    rawTimesForHours, freeCheckinTimes, offeredHours, dayHasAnyFreeTime, rangeHasBooking
};
});
