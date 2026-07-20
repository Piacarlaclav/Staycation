/* ============================================================================
   Assist — the in-house AI assistant ("ask anything about the business").

   Two halves, deliberately separated:

   1. WATCH  (getBrief)  — plain JavaScript. Computes the daily briefing and the
      alerts from live data. Costs nothing, never hallucinates, always runs.
   2. ASK    (ask)       — Claude, given read-only TOOLS over the same data.
      Costs money per question, so it only runs when the owner types something.

   The AI is never handed the whole database. It calls narrow tools, and every
   row those tools return is stripped of the things it has no business seeing:
   mobile numbers, ID photos, payment-proof images. Guest NAMES stay, because
   "who is in Haven 4 tonight" is the whole point.

   All date/time maths is anchored to Manila (UTC+8) on purpose: this runs on
   Vercel, where the server clock is UTC, and "today" must mean Pia's today.
   ========================================================================== */
const store = require("./store");

const SDK = require("@anthropic-ai/sdk");
const Anthropic = SDK.Anthropic || SDK.default || SDK;

const MODEL = process.env.ASSIST_MODEL || "claude-opus-4-8";
const MAX_TURNS = 8;          // hard stop on the tool loop, so one question can't run away
const HISTORY_LIMIT = 12;     // how many past messages we resend (cost control)

/* ---------------------------------------------------------------- time ---- */
/* Ported verbatim from dashboard.html so the assistant's answers match what the
   dashboard shows. If the booking rules change there, change them here too. */
// NOTE the spelling: bookings store "CasaBienca"/"CasaSiesta" with no space. The
// dashboard's copy of this table said "Casa Bienca", so it never matched and those
// havens silently fell back to 12:00 NN. Harmless today because every booking
// carries an explicit checkinTime — but it would bite the moment one didn't.
const HAVEN_TIMES = {
    "Haven 1": "12:00 NN", "Haven 2": "12:00 NN", "Haven 3": "12:00 NN",
    "Haven 4": "3:00 PM",  "Haven 5": "3:00 PM",  "Haven 7": "3:00 PM",
    "Haven 8": "6:00 PM",  "CasaBienca": "6:00 PM", "CasaSiesta": "6:00 PM"
};
const CLEANING_GAP_MIN = 60;   // turnaround between two stays in the same haven
const EARLIEST_CHECKIN_MIN = 480; // 8:00 AM — back-office floor
const DAY_END_MIN = 1380;      // 11:00 PM — past this we stop calling a gap "sellable"

function parseTimeMin(str) {
    const m = String(str).match(/^(\d{1,2}):(\d{2})\s*(AM|PM|NN|MN)$/i);
    if (!m) return null;
    let h = Number(m[1]); const min = Number(m[2]); const suf = m[3].toUpperCase();
    if (suf === "NN") h = 12; else if (suf === "MN") h = 0; else if (suf === "PM") h = (h % 12) + 12; else h = h % 12;
    return h * 60 + min;
}
function minToTime(min) {
    min = ((min % 1440) + 1440) % 1440;
    const h = Math.floor(min / 60), mm = String(min % 60).padStart(2, "0");
    if (h === 0) return `12:${mm} MN`;
    if (h === 12) return `12:${mm} NN`;
    return `${h > 12 ? h - 12 : h}:${mm} ${h < 12 ? "AM" : "PM"}`;
}
// Manila midnight of a YYYY-MM-DD, as absolute minutes since the epoch. Anchoring to
// +08:00 (instead of the server's local zone) is what keeps this correct on Vercel.
const midnightAbs = (d) => Math.round(Date.parse(d + "T00:00:00+08:00") / 60000);
const absToClock  = (abs) => minToTime(abs + 480);                       // → "9:00 AM"
const absToDate   = (abs) => new Date((abs + 480) * 60000).toISOString().slice(0, 10);
const phToday     = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const phNowAbs    = () => Math.round(Date.now() / 60000);
// The +8h shift before toISOString() is load-bearing. Manila midnight is 16:00 UTC
// the PREVIOUS day, so without it addDays(d, 1) reads back as the SAME date — which
// made "tomorrow" mean "today" and made endExcl() collapse every day-use stay to a
// zero-length window.
function addDays(dateStr, n) {
    return new Date(Date.parse(dateStr + "T00:00:00+08:00") + n * 864e5 + 8 * 3600e3).toISOString().slice(0, 10);
}

function bookingCheckinMin(b) {
    if (b.checkinTime) { const m = parseTimeMin(b.checkinTime); if (m != null) return m === 0 ? 1440 : m; }
    const h = Number(b.stayHours) || 21;
    if (h === 6) return parseTimeMin(b.slot === "evening" ? "7:00 PM" : "9:00 AM");
    if (h === 21) return parseTimeMin(HAVEN_TIMES[b.haven] || "12:00 NN");
    return parseTimeMin("8:00 AM");
}
const checkinTimeStr  = (b) => minToTime(bookingCheckinMin(b));
const checkoutTimeStr = (b) => minToTime(bookingCheckinMin(b) + ((Number(b.stayHours) || 21) + (Number(b.extend) || 0)) * 60);
// The time the guest ACTUALLY left when an admin recorded an early check-out — that is when
// the haven is really free and re-sellable, even though the bill never changes.
function actualCheckoutStr(b) {
    const m = Number(b.actualCheckoutMin) || 0;
    return m > 0 ? minToTime(bookingCheckinMin(b) + m) : "";
}
const effectiveCheckoutStr = (b) => actualCheckoutStr(b) || checkoutTimeStr(b);
const endExcl = (b) => (b.checkout > b.checkin ? b.checkout : addDays(b.checkin, 1));

function bookingInterval(b) {
    const start = midnightAbs(b.checkin) + bookingCheckinMin(b);
    const actual = Number(b.actualCheckoutMin) || 0;
    if (actual > 0) return { start, end: start + actual };
    if (Number(b.stayHours) === 21 && b.checkout && b.checkout > b.checkin) {
        const checkoutMin = (bookingCheckinMin(b) + (21 + (Number(b.extend) || 0)) * 60) % 1440;
        return { start, end: midnightAbs(b.checkout) + checkoutMin };
    }
    const dur = ((Number(b.stayHours) || 21) + (Number(b.extend) || 0)) * 60;
    return { start, end: start + dur };
}

/* ---------------------------------------------------------------- data ---- */
// Always LIVE reads. A warm serverless instance can hold a stale cache, and an
// assistant that answers from a stale copy is worse than no assistant at all.
async function loadData() {
    const safe = async (fn, fallback) => { try { return await fn(); } catch (e) { return fallback; } };
    const [bookings, havens] = await Promise.all([
        safe(() => store.readFreshList("shph_bookings_v3"), store.get("shph_bookings_v3") || []),
        safe(() => store.readFreshList("staycation_havens"), store.get("staycation_havens") || [])
    ]);
    return {
        bookings: (Array.isArray(bookings) ? bookings : []).filter(Boolean),
        havens:   (Array.isArray(havens) ? havens : []).filter(Boolean),
        settings: store.get("shph_settings") || {},
        cleaning: store.get("shph_cleaning_v1") || {},
        bills:    store.get("shph_bills_v1") || [],
        expenses: store.get("shph_expenses_v1") || []
    };
}

const live = (bookings) => bookings.filter(b => !b.cancelled && !b.deleted);
const havenNames = (d) => {
    const fromHavens = d.havens.map(h => h && h.name).filter(Boolean);
    const fromBookings = [...new Set(live(d.bookings).map(b => b.haven).filter(Boolean))];
    return [...new Set([...fromHavens, ...fromBookings])].sort();
};
const guestNames = (b) => (Array.isArray(b.guests) ? b.guests : []).map(g => g && g.name).filter(Boolean);
const primaryName = (b) => guestNames(b)[0] || b.fbName || "(no name)";
const paidTotal = (b) =>
    (Number(b.downpayment) || 0) + (Array.isArray(b.payments) ? b.payments : []).reduce((s, p) => s + (Number(p && p.amount) || 0), 0);
const balanceOf = (b) => Math.max(0, (Number(b.total) || 0) - paidTotal(b));

/* One booking, flattened for the model. NOTHING sensitive crosses this line:
   no contact numbers, no ID photos, no payment-proof image URLs. */
function slimBooking(b) {
    const paid = paidTotal(b);
    return {
        id: b.id,
        haven: b.haven,
        guest: primaryName(b),
        pax: guestNames(b).length || Number(b.pax) || null,
        checkin: b.checkin,
        checkout: b.checkout || endExcl(b),
        checkin_time: checkinTimeStr(b),
        checkout_time: checkoutTimeStr(b),
        left_early_at: actualCheckoutStr(b) || undefined,
        stay_hours: Number(b.stayHours) || 21,
        extra_hours: Number(b.extend) || 0,
        swim_passes: Number(b.swimpass) || 0,
        towels: Number(b.towels) || 0,
        total: Number(b.total) || 0,
        paid,
        balance: balanceOf(b),
        deposit_held: Number(b.deposit) || 0,
        discount: Number(b.discount) || 0,
        method: b.method || null,
        has_downpayment_proof: !!(b.downProof || b.downProof2),
        booked_by: b.bookedBy || null,
        partner: b.partner || b.commissionName || null,
        cancelled: !!b.cancelled,
        notes: b.notes ? String(b.notes).slice(0, 200) : undefined
    };
}

/* ------------------------------------------------------- availability ---- */
/* Which stay lengths are currently on sale. The 6-hour tier is switched off by
   default, which is why a 9-hour gap reads as "Not available" — nothing fits it. */
function offeredStays(d) {
    const p = (d.settings && d.settings.pricing) || {};
    const on = (v, dflt) => (v === undefined ? dflt : !!v);
    return [
        on(p.offer6, false) ? 6 : null,
        on(p.offer10, true) ? 10 : null,
        on(p.offer21, true) ? 21 : null
    ].filter(Boolean);
}

/* Openings for one haven on one date — the same answer the Availability tab gives.
   A window is only reported if an OFFERED stay length actually fits inside it:
   the earliest check-in is 8:00 AM, every stay needs a 1-hour cleaning gap either
   side, and a window that runs past midnight into a free next day is fine (that's
   how an evening 21-hour overnight gets sold). */
function openingsFor(d, haven, date) {
    const offered = offeredStays(d);
    const dayStart = midnightAbs(date) + EARLIEST_CHECKIN_MIN;
    const latestStart = midnightAbs(date) + DAY_END_MIN;   // latest a check-in still makes sense
    const busy = live(d.bookings).filter(b => b.haven === haven).map(bookingInterval).sort((a, b) => a.start - b.start);

    const raw = [];
    let cursor = dayStart;
    for (const iv of busy) {
        if (iv.end + CLEANING_GAP_MIN <= cursor) continue;              // already behind us
        if (iv.start - CLEANING_GAP_MIN > cursor) raw.push({ from: cursor, until: iv.start - CLEANING_GAP_MIN });
        cursor = Math.max(cursor, iv.end + CLEANING_GAP_MIN);
        if (cursor > latestStart) break;
    }
    if (cursor <= latestStart) raw.push({ from: cursor, until: Infinity });   // nothing booked after

    return raw
        .filter(w => w.from <= latestStart)
        .map(w => {
            const hours = w.until === Infinity ? 24 : (w.until - w.from) / 60;
            return {
                from: absToClock(w.from),
                from_abs: w.from,
                until: w.until === Infinity ? null : absToClock(w.until),
                next_booking: w.until === Infinity ? null : absToDate(w.until),
                hours_free: Math.round(Math.min(hours, 24) * 10) / 10,
                stays_that_fit: offered.filter(h => h <= hours)
            };
        })
        .filter(w => w.stays_that_fit.length);   // nothing sellable = not an opening
}

function availabilityFor(d, date) {
    return havenNames(d).map(haven => {
        const stays = live(d.bookings).filter(b => b.haven === haven && b.checkin <= date && date < endExcl(b));
        const open = openingsFor(d, haven, date);
        return {
            haven,
            booked: stays.map(b => ({
                guest: primaryName(b),
                from: checkinTimeStr(b),
                to: effectiveCheckoutStr(b),
                stay_hours: Number(b.stayHours) || 21
            })),
            openings: open.map(({ from_abs, ...rest }) => rest),
            available: open.length > 0,
            earliest_checkin: open.length ? open[0].from : null
        };
    });
}

/* ------------------------------------------------------------- money ----- */
// Money COLLECTED in a date range = downpayments dated in range + payment entries in range.
function collectionsBetween(d, from, to) {
    const rows = [];
    for (const b of live(d.bookings)) {
        const dp = Number(b.downpayment) || 0;
        const dpDay = (b.dpDate || b.bookedAt || "").slice(0, 10) || b.checkin;
        if (dp > 0 && dpDay >= from && dpDay <= to) {
            rows.push({ date: dpDay, amount: dp, method: b.method || "—", kind: "Downpayment", haven: b.haven, guest: primaryName(b), booking_id: b.id });
        }
        for (const p of (Array.isArray(b.payments) ? b.payments : [])) {
            const day = String(p && p.at || "").slice(0, 10);
            if (!day || day < from || day > to) continue;
            rows.push({ date: day, amount: Number(p.amount) || 0, method: p.mop || "—", kind: p.category || "Payment", haven: b.haven, guest: primaryName(b), booking_id: b.id });
        }
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function moneySummary(d, from, to) {
    const rows = collectionsBetween(d, from, to);
    const byMethod = {}, byKind = {};
    let total = 0;
    for (const r of rows) {
        total += r.amount;
        byMethod[r.method] = (byMethod[r.method] || 0) + r.amount;
        byKind[r.kind] = (byKind[r.kind] || 0) + r.amount;
    }
    const staying = live(d.bookings).filter(b => b.checkin >= from && b.checkin <= to);
    const outstanding = staying.filter(b => balanceOf(b) > 0);
    const spend = [...(Array.isArray(d.bills) ? d.bills : []), ...(Array.isArray(d.expenses) ? d.expenses : [])]
        .filter(x => x && !x.deleted && String(x.date || "").slice(0, 10) >= from && String(x.date || "").slice(0, 10) <= to);
    return {
        range: { from, to },
        collected: total,
        collected_by_method: byMethod,
        collected_by_kind: byKind,
        payment_count: rows.length,
        bookings_checking_in: staying.length,
        booked_value: staying.reduce((s, b) => s + (Number(b.total) || 0), 0),
        unpaid_balance_total: outstanding.reduce((s, b) => s + balanceOf(b), 0),
        unpaid_bookings: outstanding.map(b => ({ guest: primaryName(b), haven: b.haven, checkin: b.checkin, balance: balanceOf(b), booking_id: b.id })),
        deposits_held: staying.reduce((s, b) => s + (Number(b.deposit) || 0), 0),
        spending_recorded: spend.reduce((s, x) => s + (Number(x.amount) || 0), 0),
        spending_items: spend.slice(0, 40).map(x => ({ date: String(x.date).slice(0, 10), name: x.name || x.title || x.label || "—", amount: Number(x.amount) || 0 }))
    };
}

/* ================================ WATCH ==================================== */
/* The daily briefing. Pure JavaScript — no AI, no cost, no hallucination.
   Every item is something the owner would otherwise only find by scrolling. */
async function getBrief() {
    const d = await loadData();
    const today = phToday(), tomorrow = addDays(today, 1);
    const nowAbs = phNowAbs();
    const L = live(d.bookings);

    const arrivals = L.filter(b => b.checkin === today).sort((a, b) => bookingCheckinMin(a) - bookingCheckinMin(b));
    const departures = L.filter(b => (b.checkout || endExcl(b)) === today);
    const inHouse = L.filter(b => b.checkin <= today && today < endExcl(b));
    const tomorrowArrivals = L.filter(b => b.checkin === tomorrow);

    const alerts = [];
    const add = (level, title, detail, page) => alerts.push({ level, title, detail, page });

    /* 1. Unsold hours — the money that quietly walks away. Only counts windows a
       stay you actually SELL would fit into, so this never nags about a 9-hour gap
       while the 6-hour tier is switched off. */
    for (const date of [today, tomorrow]) {
        const when = date === today ? "today" : "tomorrow";
        for (const haven of havenNames(d)) {
            for (const w of openingsFor(d, haven, date)) {
                if (date === today && w.from_abs < nowAbs) continue;     // that window has already passed
                const best = Math.max(...w.stays_that_fit);
                // Spell out the date when the window runs past midnight, or "until 11:00 AM"
                // on an evening slot reads like a two-hour gap instead of overnight.
                const till = !w.until ? "with nothing booked after it"
                    : (w.next_booking === date ? `until ${w.until}` : `until ${w.until} on ${w.next_booking}`);
                add("money", `${haven} is empty from ${w.from} ${when}`,
                    `Free ${when} (${date}) from ${w.from} ${till}. A ${best}-hour stay fits`
                    + ` — that's ₱${best >= 21 ? "1,599–2,099" : "999"} sitting unsold.`,
                    "calendar");
            }
        }
    }

    /* 2. Money owed. Guests still in house get their own line — that balance can still
       be collected in person today. Everyone who already left is rolled into ONE line
       with the total: there are dozens of these going back months, and listing them
       individually buries every other alert (which is exactly what it did at first). */
    for (const b of inHouse) {
        const bal = balanceOf(b);
        if (bal > 0) add("today", `${primaryName(b)} still owes ₱${bal.toLocaleString()}`,
            `${b.haven}, checking out ${b.checkout || endExcl(b)} at ${effectiveCheckoutStr(b)}. Collect before they leave.`, "today");
    }
    const leftOwing = L.filter(b => (b.checkout || endExcl(b)) < today && balanceOf(b) > 0)
        .sort((a, b) => String(b.checkout || "").localeCompare(String(a.checkout || "")));
    if (leftOwing.length) {
        const sum = leftOwing.reduce((s, b) => s + balanceOf(b), 0);
        const recent = leftOwing.slice(0, 4).map(b => `${primaryName(b)} ₱${balanceOf(b).toLocaleString()} (${b.haven}, ${b.checkout || endExcl(b)})`);
        add("urgent", `₱${sum.toLocaleString()} uncollected from ${leftOwing.length} past stay${leftOwing.length > 1 ? "s" : ""}`,
            `Most recent: ${recent.join(" · ")}${leftOwing.length > 4 ? ` — and ${leftOwing.length - 4} more.` : "."} `
            + `Some of these were probably paid in cash and never recorded — worth a pass through Collection Reports.`, "collections");
    }

    /* 3. Downpayment taken but no proof uploaded — the audit-trail gap, next 7 days. */
    const noProof = L.filter(x => x.checkin >= today && x.checkin <= addDays(today, 7)
        && (Number(x.downpayment) || 0) > 0 && !x.downProof && !x.downProof2);
    if (noProof.length) {
        const sum = noProof.reduce((s, b) => s + (Number(b.downpayment) || 0), 0);
        add("check", `${noProof.length} downpayment${noProof.length > 1 ? "s" : ""} with no proof attached`,
            `₱${sum.toLocaleString()} recorded across: ` + noProof.slice(0, 5).map(b => `${primaryName(b)} (${b.haven}, ${b.checkin})`).join(" · ")
            + (noProof.length > 5 ? ` — and ${noProof.length - 5} more.` : "."), "calendar");
    }

    /* 4. Turnovers due — checked out, next guest coming, cleaning not finished.
       The housekeeping log is keyed by BOOKING ID (see shph_cleaning_v1). */
    for (const b of departures) {
        const rec = (d.cleaning || {})[String(b.id)];
        // A 10-hour stay checks in AND out on the same day, so it appears in both
        // lists — it must never be treated as its own incoming guest.
        const nextToday = arrivals.find(a => a.haven === b.haven && a.id !== b.id);
        if (!nextToday || (rec && rec.doneAt)) continue;
        add("today", `${b.haven} turnover due`,
            `${primaryName(b)} out ${effectiveCheckoutStr(b)}, ${primaryName(nextToday)} in ${checkinTimeStr(nextToday)}. `
            + (rec && rec.startedAt ? "Cleaning started but not marked done." : "No cleaning logged yet."), "cleaners");
    }

    /* 5. Deposits still held on stays that ended in the last 3 days and were never
       marked returned. Without the depositReturned check this listed every stay
       going back months. */
    const heldPast = L.filter(b => {
        const out = b.checkout || endExcl(b);
        return out < today && out >= addDays(today, -3) && (Number(b.deposit) || 0) > 0 && !b.depositReturned;
    });
    if (heldPast.length) {
        const sum = heldPast.reduce((s, b) => s + (Number(b.deposit) || 0), 0);
        add("check", `${heldPast.length} deposit${heldPast.length > 1 ? "s" : ""} still to return (₱${sum.toLocaleString()})`,
            heldPast.slice(0, 6).map(b => `${primaryName(b)} (${b.haven}, ₱${(Number(b.deposit) || 0).toLocaleString()})`).join(" · ")
            + (heldPast.length > 6 ? ` — and ${heldPast.length - 6} more.` : ""), "deposit");
    }

    /* Rank by urgency, but cap each level so one noisy category can't crowd the
       others off the list — an unsold-hours warning is worth more than the eighth
       copy of the same reminder. */
    const order = { urgent: 0, money: 1, today: 2, check: 3 };
    const CAP = { urgent: 3, money: 5, today: 5, check: 3 };
    const seen = {};
    const ranked = alerts
        .sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9))
        .filter(a => (seen[a.level] = (seen[a.level] || 0) + 1) <= (CAP[a.level] || 3));

    return {
        ok: true,
        date: today,
        generated_at: new Date().toISOString(),
        numbers: {
            arrivals_today: arrivals.length,
            departures_today: departures.length,
            in_house: inHouse.length,
            occupied_havens: [...new Set(inHouse.map(b => b.haven))].length,
            total_havens: havenNames(d).length,
            arrivals_tomorrow: tomorrowArrivals.length,
            collected_today: moneySummary(d, today, today).collected,
            owed_today: inHouse.reduce((s, b) => s + balanceOf(b), 0)
        },
        arrivals: arrivals.map(b => ({ guest: primaryName(b), haven: b.haven, time: checkinTimeStr(b), balance: balanceOf(b) })),
        departures: departures.map(b => ({ guest: primaryName(b), haven: b.haven, time: effectiveCheckoutStr(b), balance: balanceOf(b) })),
        alerts: ranked
    };
}

/* ================================= ASK ===================================== */
/* Read-only tools. The assistant can look at anything here and nothing else —
   it cannot write, cancel, delete, or change a single record. */
const TOOLS = [
    {
        name: "list_bookings",
        description: "List bookings whose stay overlaps a date range. Use this for 'who is checking in', 'who is staying', 'how many bookings', guest lookups, and anything about a specific stay. Returns money figures (total, paid, balance, deposit) per booking.",
        input_schema: {
            type: "object",
            properties: {
                from: { type: "string", description: "Start date YYYY-MM-DD (inclusive)." },
                to: { type: "string", description: "End date YYYY-MM-DD (inclusive). Same as 'from' for a single day." },
                haven: { type: "string", description: "Optional: only this haven, e.g. 'Haven 4'." },
                guest: { type: "string", description: "Optional: only bookings whose guest name contains this text." },
                arriving_only: { type: "boolean", description: "True = only bookings whose CHECK-IN date falls in the range, instead of any overlapping stay." },
                include_cancelled: { type: "boolean" }
            },
            required: ["from", "to"]
        }
    },
    {
        name: "check_availability",
        description: "Which havens are free on a date, and exactly which hours are still sellable (honouring the 1-hour cleaning gap and the 8:00 AM earliest check-in). Use for 'what's available', 'can I fit a booking', 'what's empty tonight'.",
        input_schema: {
            type: "object",
            properties: { date: { type: "string", description: "YYYY-MM-DD" } },
            required: ["date"]
        }
    },
    {
        name: "money_summary",
        description: "Money for a date range: collected (split by payment method and kind), unpaid balances, deposits held, and recorded bills/expenses. Use for revenue, sales, collections, 'how much did we make', 'who still owes'.",
        input_schema: {
            type: "object",
            properties: {
                from: { type: "string", description: "YYYY-MM-DD" },
                to: { type: "string", description: "YYYY-MM-DD" }
            },
            required: ["from", "to"]
        }
    },
    {
        name: "housekeeping_status",
        description: "Cleaning records for a date: which havens were logged as cleaned, by whom, and which check-outs still have no cleaning record.",
        input_schema: {
            type: "object",
            properties: { date: { type: "string", description: "YYYY-MM-DD" } },
            required: ["date"]
        }
    },
    {
        name: "havens_and_rates",
        description: "The haven list (with which are live on the website) and the CURRENT saved rates and add-on prices. Use before quoting any price — never quote from memory.",
        input_schema: { type: "object", properties: {} }
    },
    {
        name: "daily_briefing",
        description: "Today's computed briefing: arrivals, departures, occupancy, money collected, and the alert list (unsold hours, unpaid balances, missing proofs, turnovers due).",
        input_schema: { type: "object", properties: {} }
    }
];

async function runTool(name, input, d, opts) {
    const inp = input || {};
    switch (name) {
        case "list_bookings": {
            const from = inp.from, to = inp.to;
            let list = (inp.include_cancelled ? d.bookings : live(d.bookings)).filter(b => b && b.checkin);
            list = inp.arriving_only
                ? list.filter(b => b.checkin >= from && b.checkin <= to)
                : list.filter(b => b.checkin <= to && from < endExcl(b));
            if (inp.haven) list = list.filter(b => String(b.haven || "").toLowerCase() === String(inp.haven).toLowerCase());
            if (inp.guest) {
                const q = String(inp.guest).toLowerCase();
                list = list.filter(b => (guestNames(b).join(" ") + " " + (b.fbName || "")).toLowerCase().includes(q));
            }
            list.sort((a, b) => (a.checkin + String(bookingCheckinMin(a)).padStart(4, "0")).localeCompare(b.checkin + String(bookingCheckinMin(b)).padStart(4, "0")));
            return { count: list.length, truncated: list.length > 60, bookings: list.slice(0, 60).map(slimBooking) };
        }
        case "check_availability": {
            const date = inp.date || phToday();
            return { date, havens: availabilityFor(d, date) };
        }
        case "money_summary": {
            if (!opts.canSeeMoney) return { error: "This account doesn't have access to financial figures." };
            return moneySummary(d, inp.from, inp.to);
        }
        case "housekeeping_status": {
            // shph_cleaning_v1 is an object keyed by BOOKING ID:
            // { startedAt, doneAt, photos:{…}, history:[{user, action, at}] }
            const date = inp.date || phToday();
            const outs = live(d.bookings).filter(b => (b.checkout || endExcl(b)) === date);
            const rows = outs.map(b => {
                const rec = (d.cleaning || {})[String(b.id)] || null;
                const who = rec && Array.isArray(rec.history) && rec.history.length ? rec.history[rec.history.length - 1].user : null;
                return {
                    haven: b.haven, guest: primaryName(b), out_at: effectiveCheckoutStr(b),
                    status: !rec ? "not started" : (rec.doneAt ? "done" : "in progress"),
                    by: who, started_at: rec && rec.startedAt || null, done_at: rec && rec.doneAt || null,
                    photos: rec && rec.photos ? Object.keys(rec.photos).length : 0
                };
            });
            return {
                date,
                checkouts: rows,
                done: rows.filter(r => r.status === "done").length,
                outstanding: rows.filter(r => r.status !== "done").map(r => `${r.haven} (${r.status})`)
            };
        }
        case "havens_and_rates": {
            const p = (d.settings && d.settings.pricing) || {};
            return {
                havens: d.havens.map(h => ({ name: h.name, live_on_website: h.live !== false, website_price: h.price })),
                rates: p,
                addons: (d.settings && d.settings.customAddons) || [],
                notes: "These are the SAVED live rates. offer6/offer10/offer21 = whether that stay length is currently offered."
            };
        }
        case "daily_briefing":
            return await getBrief();
        default:
            return { error: "unknown tool" };
    }
}

function systemPrompt(brief, opts) {
    const n = brief.numbers || {};
    return [
        "You are the in-house assistant for Staycation Haven PH, a staycation rental business in the Philippines.",
        `You are speaking with ${opts.user || "the team"}${opts.admin ? " (the owner)" : ""}. Today is ${brief.date} (Manila time).`,
        "",
        "RIGHT NOW: " + [
            `${n.arrivals_today} arriving today`,
            `${n.departures_today} checking out`,
            `${n.in_house} stays in house`,
            `${n.occupied_havens}/${n.total_havens} havens occupied`,
            `${n.arrivals_tomorrow} arriving tomorrow`,
            opts.canSeeMoney ? `₱${(n.collected_today || 0).toLocaleString()} collected today` : null,
            opts.canSeeMoney && n.owed_today ? `₱${(n.owed_today || 0).toLocaleString()} still owed by guests in house` : null
        ].filter(Boolean).join(" · ") + ".",
        "",
        "HOW TO ANSWER",
        "- Always call a tool before stating a fact about bookings, availability, money, or cleaning. Never answer those from memory or from the snapshot above alone.",
        "- Never invent a booking, guest, amount, or date. If a tool returns nothing, say so plainly.",
        "- Money is Philippine pesos: write ₱1,599 with the peso sign and thousands separators.",
        "- Be short. Lead with the answer in one sentence, then the supporting detail. Use a compact list when there is more than one row; skip the table formatting.",
        "- The owner writes in Taglish. Reply in English.",
        "- When you spot something that costs money (an unsold window, an uncollected balance, a missing proof), say so even if it wasn't asked.",
        "- You can look but not touch: you have no ability to create, change, cancel, or delete anything. If asked to make a change, say what you would change and where in the dashboard to do it.",
        "",
        "BUSINESS RULES",
        "- Stay lengths: 10-hour day-use and 21-hour overnight (a legacy 6-hour tier exists but is switched off unless havens_and_rates says otherwise).",
        "- Check-in times differ per haven: Havens 1–3 at 12:00 NN, Havens 4/5/7 at 3:00 PM, Haven 8 and Casa Bienca at 6:00 PM.",
        "- Back office may check a guest in from 8:00 AM. A haven needs a 1-hour cleaning gap between stays.",
        "- An early check-out frees the haven early but never lowers the guest's bill.",
        "- Casa Bianca and Casa Siesta are partner properties: no rent or utilities are paid on them.",
        !opts.canSeeMoney ? "- This account may not see financial figures; the money tool will refuse. Don't speculate about numbers." : ""
    ].filter(Boolean).join("\n");
}

/* ============================ QUICK ANSWERS ================================
   The free half of the hybrid. Common questions are answered here from live
   data with plain JavaScript — no model call, ₱0. Only when NOTHING here
   matches does ask() fall through to Claude (which costs money). This is why
   the chat is useful even before an ANTHROPIC_API_KEY is added.

   Everything is best-effort keyword matching in English AND Taglish. When a
   question is ambiguous or unrecognised we return null and let the AI take it. */
const peso = (n) => "₱" + Number(n || 0).toLocaleString();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const _MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtNice = (iso) => _MON[+iso.slice(5, 7) - 1] + " " + (+iso.slice(8, 10));   // "2026-07-25" → "Jul 25"
function dowOf(dateStr) { return ((Math.floor(midnightAbs(dateStr) / 1440) + 4) % 7 + 7) % 7; } // 0=Sun
function nextDow(today, target) { return addDays(today, (target - dowOf(today) + 7) % 7); }
function monthStart(d) { return d.slice(0, 7) + "-01"; }
function monthEnd(d) {
    const y = +d.slice(0, 4), m = +d.slice(5, 7);
    return `${d.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

// Pull a date (or range) out of the question. Returns {from,to,label,single} or null.
function parseWhen(text, today) {
    const t = " " + text.toLowerCase() + " ";
    const one = (d, label) => ({ from: d, to: d, label, single: true });
    const rng = (from, to, label) => ({ from, to, label, single: false });

    if (/\b(today|ngayon|ngaun|ngayong araw|tonight|mamaya|mamayang gabi|this evening)\b/.test(t)) return one(today, "today");
    if (/\b(tomorrow|bukas)\b/.test(t)) return one(addDays(today, 1), "tomorrow");
    if (/\b(yesterday|kahapon)\b/.test(t)) return one(addDays(today, -1), "yesterday");
    if (/\b(next week|susunod na linggo|sunod na linggo)\b/.test(t)) return rng(addDays(today, 7), addDays(today, 13), "next week");
    if (/\b(this week|ngayong linggo|this wk|for the week)\b/.test(t)) return rng(today, addDays(today, 6), "this week");
    if (/\b(next month|susunod na buwan)\b/.test(t)) { const n = addDays(monthEnd(today), 1); return rng(monthStart(n), monthEnd(n), "next month"); }
    if (/\b(this month|ngayong buwan|buwan na (ito|to)|for the month|so far this month)\b/.test(t)) return rng(monthStart(today), monthEnd(today), "this month");

    // day of week → the coming one (today if it's that day)
    const dows = [["sunday", "linggo"], ["monday", "lunes"], ["tuesday", "martes"], ["wednesday", "miyerkoles", "miercoles"], ["thursday", "huwebes"], ["friday", "biyernes"], ["saturday", "sabado"]];
    for (let i = 0; i < 7; i++) for (const w of dows[i]) if (new RegExp("\\b" + w + "\\b").test(t)) { const dd = nextDow(today, i); return one(dd, `${cap(dows[i][0])} (${fmtNice(dd)})`); }

    // ISO date
    let m = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    if (m) return one(m[0], fmtNice(m[0]));

    // month name + day, or day + month
    const MO = { jan:1, january:1, feb:2, february:2, mar:3, march:3, apr:4, april:4, may:5, jun:6, june:6, jul:7, july:7, aug:8, august:8, sep:9, sept:9, september:9, oct:10, october:10, nov:11, november:11, dec:12, december:12 };
    m = t.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/) || t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\b/);
    if (m) {
        const mo = MO[m[1]] || MO[m[2]], day = +(MO[m[1]] ? m[2] : m[1]);
        if (mo && day >= 1 && day <= 31) {
            let y = +today.slice(0, 4);
            let iso = `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            if (iso < today) iso = `${y + 1}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`; // past date → next year
            return one(iso, fmtNice(iso));
        }
    }

    // "on the 25th" / "sa 25" → that day this month, or next month if already past
    m = t.match(/\b(?:on|sa|the|ika-?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (m) {
        const day = +m[1];
        if (day >= 1 && day <= 31) {
            let iso = `${today.slice(0, 7)}-${String(day).padStart(2, "0")}`;
            if (iso < today) { const n = addDays(monthEnd(today), 1); iso = `${n.slice(0, 7)}-${String(day).padStart(2, "0")}`; }
            return one(iso, fmtNice(iso));
        }
    }
    return null;
}

const _has = (t, ...words) => words.some(w => new RegExp("(^|[^a-z])" + w + "([^a-z]|$)", "i").test(t));

// A one-line description of a booking, for arrivals/departures/lists.
function _line(b, opts, kind) {
    const t = kind === "out" ? effectiveCheckoutStr(b) : checkinTimeStr(b);
    const bal = balanceOf(b);
    const money = (opts.canSeeMoney && bal > 0) ? ` — still owes ${peso(bal)}` : "";
    return `• ${primaryName(b)} — ${b.haven}, ${t}${money}`;
}

function quickHelp(opts) {
    return "Here's what I can answer instantly (free):\n"
        + "• Who's checking in / out (today, tomorrow, a date)\n"
        + "• Which havens are free on a date\n"
        + "• What's unsold this week\n"
        + (opts.canSeeMoney ? "• How much we collected (today / this month)\n• Who still owes money\n" : "")
        + "• Housekeeping / turnover status\n"
        + "• Who's in house right now\n"
        + "Just ask in your own words — Taglish is fine.";
}

// Returns a free answer object, or null to let the AI handle it.
function quickAnswer(text, d, opts, today) {
    if (!text || !text.trim()) return null;
    const t = text.toLowerCase();
    const when = parseWhen(text, today);
    const L = live(d.bookings);

    // capabilities / greeting
    if (_has(t, "help", "what can you do", "ano ang kaya mo", "ano pwede", "ano matutulong", "commands")
        && !_has(t, "check", "book", "haven", "money", "collect"))
        return { reply: quickHelp(opts), tools: ["help"] };

    // MONEY — collected / sales / revenue (owner only)
    if (_has(t, "collect", "collected", "kita", "kinita", "nakolekta", "sales", "revenue", "income", "takings", "benta", "earnings")
        && (_has(t, "how much", "magkano", "total", "much", "gaano", "ilan") || _has(t, "collect", "collected", "nakolekta", "kita"))) {
        if (!opts.canSeeMoney) return { reply: "Money figures are for the owner's account only.", tools: ["money_summary"] };
        const w = when || { from: today, to: today, label: "today", single: true };
        const s = moneySummary(d, w.from, w.to);
        const methods = Object.entries(s.collected_by_method).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${peso(v)}`).join(", ");
        let r = `Collected ${w.label}: ${peso(s.collected)} across ${s.payment_count} payment${s.payment_count === 1 ? "" : "s"}.`;
        if (methods) r += `\nBy method: ${methods}.`;
        if (s.unpaid_balance_total > 0) r += `\nStill outstanding from stays ${w.label}: ${peso(s.unpaid_balance_total)}.`;
        return { reply: r, tools: ["money_summary"] };
    }

    // UNPAID — who owes
    if (_has(t, "owe", "owes", "owing", "utang", "balance", "unpaid", "bayad pa", "hindi pa bayad", "may babayaran", "walang bayad")) {
        if (!opts.canSeeMoney) return { reply: "Balance figures are for the owner's account only.", tools: ["list_bookings"] };
        const owing = L.filter(b => balanceOf(b) > 0).sort((a, b) => String(b.checkout || endExcl(b)).localeCompare(String(a.checkout || endExcl(a))));
        if (!owing.length) return { reply: "No outstanding balances — everyone's paid up. 🎉", tools: ["list_bookings"] };
        const sum = owing.reduce((s, b) => s + balanceOf(b), 0);
        const inHouse = owing.filter(b => b.checkin <= today && today < endExcl(b));
        const lines = owing.slice(0, 12).map(b => {
            const out = b.checkout || endExcl(b);
            const tag = out < today ? `left ${out}` : (b.checkin <= today && today < endExcl(b) ? "in house" : `arrives ${b.checkin}`);
            return `• ${primaryName(b)} — ${b.haven}, ${peso(balanceOf(b))} (${tag})`;
        });
        let r = `${owing.length} booking${owing.length === 1 ? "" : "s"} still owe you ${peso(sum)} total`
            + (inHouse.length ? ` — ${inHouse.length} still in house (collect before they leave).` : ".") + "\n" + lines.join("\n");
        if (owing.length > 12) r += `\n…and ${owing.length - 12} more. Full list is in Collection Reports.`;
        return { reply: r, tools: ["list_bookings"] };
    }

    // AVAILABILITY — what's free / available
    if (_has(t, "available", "availability", "free", "bakante", "libre", "empty", "vacant", "open", "walang booking", "pwede pa", "may bakante", "openings", "walang laman")
        && !_has(t, "unsold", "sayang", "this week", "ngayong linggo")) {
        const w = when || { from: today, to: today, label: "today", single: true };
        const date = w.from;
        const rows = availabilityFor(d, date);
        const freeRows = rows.filter(r => r.available);
        if (!freeRows.length) return { reply: `Nothing available ${w.label} — every haven is booked.`, tools: ["check_availability"] };
        const lines = freeRows.map(r => {
            const best = r.openings[0];
            return `• ${r.haven} — from ${r.earliest_checkin}` + (best && best.until ? ` until ${best.until}` : "") + ` (${best ? best.stays_that_fit.map(h => h + "h").join(" or ") : ""})`;
        });
        return { reply: `${freeRows.length} haven${freeRows.length === 1 ? "" : "s"} free ${w.label}:\n${lines.join("\n")}`, tools: ["check_availability"] };
    }

    // UNSOLD — sellable gaps across a range (defaults to this week)
    if (_has(t, "unsold", "sayang", "gaps", "hindi nabenta", "walang laman", "not booked", "empty week")) {
        const w = when || { from: today, to: addDays(today, 6), label: "this week" };
        const hits = [];
        for (let dt = w.from; dt <= w.to; dt = addDays(dt, 1))
            for (const haven of havenNames(d))
                for (const o of openingsFor(d, haven, dt))
                    hits.push({ dt, haven, from: o.from, until: o.until, best: Math.max(...o.stays_that_fit) });
        if (!hits.length) return { reply: `Nothing sitting unsold ${w.label} — the calendar's tight. 👍`, tools: ["check_availability"] };
        const lines = hits.slice(0, 10).map(h => `• ${h.haven} ${h.dt} — free from ${h.from}${h.until ? ` to ${h.until}` : ""} (fits a ${h.best}h stay)`);
        let r = `${hits.length} unsold opening${hits.length === 1 ? "" : "s"} ${w.label}:\n${lines.join("\n")}`;
        if (hits.length > 10) r += `\n…and ${hits.length - 10} more.`;
        return { reply: r, tools: ["check_availability"] };
    }

    // DEPARTURES — checking out (test before arrivals so "checking out" wins over "checking in")
    if (_has(t, "check out", "checkout", "check-out", "checking out", "aalis", "lalabas", "umaalis", "paalis", "departure", "departing", "leaving", "labas")) {
        const w = when || { from: today, to: today, label: "today", single: true };
        const outs = L.filter(b => { const o = b.checkout || endExcl(b); return o >= w.from && o <= w.to; })
            .sort((a, b) => parseTimeMin(effectiveCheckoutStr(a)) - parseTimeMin(effectiveCheckoutStr(b)));
        if (!outs.length) return { reply: `No check-outs ${w.label}.`, tools: ["list_bookings"] };
        return { reply: `${outs.length} checking out ${w.label}:\n${outs.map(b => _line(b, opts, "out")).join("\n")}`, tools: ["list_bookings"] };
    }

    // OCCUPANCY — who's in house right now. Checked BEFORE arrivals so a "right now"
    // question isn't grabbed by the "staying" keyword below.
    if (_has(t, "in house", "in-house", "occupied", "occupancy", "nasa loob", "naka check in ngayon")
        || (_has(t, "staying", "stay", "how many", "ilan", "guests", "bisita") && _has(t, "right now", "now", "currently", "present", "ngayon", "sa loob"))) {
        const inH = L.filter(b => b.checkin <= today && today < endExcl(b)).sort((a, b) => a.haven.localeCompare(b.haven));
        if (!inH.length) return { reply: "No one's in house right now.", tools: ["list_bookings"] };
        const havens = [...new Set(inH.map(b => b.haven))].length;
        return { reply: `${inH.length} stay${inH.length === 1 ? "" : "s"} in house right now (${havens} haven${havens === 1 ? "" : "s"} occupied):\n${inH.map(b => `• ${b.haven} — ${primaryName(b)}, out ${effectiveCheckoutStr(b)}`).join("\n")}`, tools: ["list_bookings"] };
    }

    // ARRIVALS — checking in / who's coming / who's staying
    if (_has(t, "check in", "checkin", "check-in", "checking in", "chechin", "arriving", "arrival", "coming", "papasok", "pumasok", "darating", "dating", "pasok", "guest", "bisita", "booking", "staying", "naka book")) {
        const w = when || { from: today, to: today, label: "today", single: true };
        const arr = L.filter(b => b.checkin >= w.from && b.checkin <= w.to)
            .sort((a, b) => (a.checkin + String(bookingCheckinMin(a)).padStart(4, "0")).localeCompare(b.checkin + String(bookingCheckinMin(b)).padStart(4, "0")));
        if (!arr.length) return { reply: `No one checking in ${w.label}.`, tools: ["list_bookings"] };
        return { reply: `${arr.length} checking in ${w.label}:\n${arr.map(b => _line(b, opts, "in")).join("\n")}`, tools: ["list_bookings"] };
    }

    // HOUSEKEEPING — cleaning / turnover
    if (_has(t, "clean", "cleaning", "housekeeping", "linis", "naglinis", "turnover", "hugas", "nalinis")) {
        const w = when || { from: today, to: today, label: "today", single: true };
        const outs = L.filter(b => (b.checkout || endExcl(b)) === w.from);
        if (!outs.length) return { reply: `No check-outs to clean ${w.label}.`, tools: ["housekeeping_status"] };
        const lines = outs.map(b => {
            const rec = (d.cleaning || {})[String(b.id)];
            const st = !rec ? "not started" : (rec.doneAt ? "✓ done" : "in progress");
            return `• ${b.haven} (${primaryName(b)}, out ${effectiveCheckoutStr(b)}) — ${st}`;
        });
        const pending = outs.filter(b => { const r = (d.cleaning || {})[String(b.id)]; return !r || !r.doneAt; }).length;
        return { reply: `Housekeeping ${w.label} — ${outs.length - pending}/${outs.length} done:\n${lines.join("\n")}`, tools: ["housekeeping_status"] };
    }

    return null;   // nothing matched → let the AI take it (if a key is configured)
}

async function ask({ messages, user, admin }) {
    const opts = { user, admin: !!admin, canSeeMoney: !!admin };
    const d = await loadData();
    const today = phToday();

    // The LAST user message is the question. Try the FREE engine first — a hit
    // means ₱0 and no key needed.
    const convoIn = (Array.isArray(messages) ? messages : [])
        .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim());
    const lastUser = [...convoIn].reverse().find(m => m.role === "user");
    if (lastUser) {
        const quick = quickAnswer(lastUser.content, d, opts, today);
        if (quick) return { ok: true, reply: quick.reply, source: "quick", free: true, tools: quick.tools || [], cost_php: 0 };
    }

    // Not a common question → the AI handles it (costs money). Needs a key.
    if (!process.env.ANTHROPIC_API_KEY) {
        return {
            ok: false, error: "no_key", source: "none",
            reply: "That one's a bit open-ended, and Havi's AI (for free-form questions) isn't switched on yet — it needs an ANTHROPIC_API_KEY on Vercel.\n\n" + quickHelp(opts)
        };
    }
    const client = new Anthropic();
    const brief = await getBrief();

    const convo = (Array.isArray(messages) ? messages : [])
        .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .slice(-HISTORY_LIMIT)
        .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!convo.length) return { ok: false, error: "empty", reply: "Ask me something about the business." };
    if (convo[0].role !== "user") convo.shift();

    // The system prompt + tool list is the stable prefix — cache it so follow-up
    // questions in the same conversation only pay for the new turn.
    const system = [{ type: "text", text: systemPrompt(brief, opts), cache_control: { type: "ephemeral" } }];

    const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    const toolsUsed = [];
    let reply = "";

    for (let turn = 0; turn < MAX_TURNS; turn++) {
        const res = await client.messages.create({
            model: MODEL,
            max_tokens: 2000,
            system,
            tools: TOOLS,
            messages: convo
        });
        usage.input       += res.usage?.input_tokens || 0;
        usage.output      += res.usage?.output_tokens || 0;
        usage.cache_read  += res.usage?.cache_read_input_tokens || 0;
        usage.cache_write += res.usage?.cache_creation_input_tokens || 0;

        if (res.stop_reason === "refusal") {
            return { ok: false, error: "refused", reply: "I can't help with that one.", usage };
        }

        const calls = res.content.filter(b => b.type === "tool_use");
        reply = res.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();

        if (!calls.length) break;

        convo.push({ role: "assistant", content: res.content });
        const results = [];
        for (const c of calls) {
            toolsUsed.push(c.name);
            let out;
            try { out = await runTool(c.name, c.input, d, opts); }
            catch (e) {
                console.error("[assist] tool", c.name, "failed:", e.message);
                out = { error: "That lookup failed: " + e.message };
            }
            results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out) });
        }
        convo.push({ role: "user", content: results });
    }

    return {
        ok: true,
        source: "ai",
        reply: reply || "I couldn't put an answer together for that — try rephrasing?",
        tools: [...new Set(toolsUsed)],
        usage,
        // Rough peso cost of this one question, so nothing is a surprise on the bill.
        cost_php: Math.round(((usage.input * 5 + usage.cache_write * 6.25 + usage.cache_read * 0.5 + usage.output * 25) / 1e6) * 58 * 100) / 100
    };
}

// Exposed so the Availability answer can be checked against the dashboard's own tab
// without spending a single token on the model.
async function checkAvailability(date) {
    const d = await loadData();
    return { date, offered: offeredStays(d), havens: availabilityFor(d, date) };
}

module.exports = { ask, getBrief, checkAvailability, enabled: () => !!process.env.ANTHROPIC_API_KEY };
