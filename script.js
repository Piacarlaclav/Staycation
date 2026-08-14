let adults = 1;
let children = 0;

function changeCount(type, amount){

    if(type === "adults"){
        adults = Math.max(1, Math.min(4, adults + amount));
        document.getElementById("adults").textContent = adults;
    }

    if(type === "children"){
        children = Math.max(0, Math.min(2, children + amount));
        document.getElementById("children").textContent = children;
    }

    let summary = adults + " Adult";

    if(adults > 1){
        summary = adults + " Adults";
    }

    if(children > 0){
        summary += ", " + children + " Child";
        if(children > 1){
            summary += "ren";
        }
    }

    document.getElementById("guestSummary").textContent = summary;

    // keep the already-shown "Available Havens" cards in sync with the new
    // guest count, so the link each card carries reflects the current pax
    refreshResultsIfShown();
}

// re-run the availability search (without scrolling) if results are on screen
function refreshResultsIfShown(){
    const results = document.getElementById("results");
    if(results && results.querySelector(".cards")){
        checkAvailability({ scroll: false });
    }
}

function addDaysIso(iso, n){
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + n);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function loadBookings(){
    try { return JSON.parse(localStorage.getItem("shph_bookings_v3")) || []; }
    catch(e){ return []; }
}

function sameHaven(a, b){
    return SHB.sameHaven(a, b);
}

// the owner's currently-offered stay lengths (dashboard → Rates & Add-ons)
function searchPricing(){
    try { return (JSON.parse(localStorage.getItem("shph_settings")) || {}).pricing || {}; }
    catch(e){ return {}; }
}

// Is a haven free for the requested stay?
// This asks booking-rules.js the EXACT question havens.html's booking panel asks, so a
// haven listed here as "available" can never say "Fully booked for this date" one click
// later. It used to run its own whole-day overlap check: no cleaning gap, no check-in
// times, no Saturday overnight-only rule and no offer6/10/21 settings — which is why the
// listing and the panel disagreed (e.g. Haven 1 on Sat 01/08/2026).
function havenAvailable(havenName, startIso, endIso, hours){
    const list = loadBookings();
    // a multi-night range needs WHOLE days → any day-overlap blocks it
    if(endIso && endIso > addDaysIso(startIso, 1)){
        return !SHB.rangeHasBooking(list, havenName, startIso, endIso);
    }
    const lead = SHB.earliestLeadMin(startIso);
    if(!hours) return SHB.dayHasAnyFreeTime(list, havenName, startIso, searchPricing(), lead);
    // an explicit duration was chosen: it must be offered AND still fit somewhere that day
    if(SHB.offeredHours(searchPricing()).indexOf(hours) < 0) return false;
    // Saturday used to be overnight-only here. 10-hour day-use is sold on Saturdays now
    // (Pia, 2026-08-05) — booking-rules.js is the single place that decides what fits.
    return SHB.freeCheckinTimes(list, havenName, hours, startIso, 0, lead).length > 0;
}

function checkAvailability(opts){
    const scroll = !opts || opts.scroll !== false;
    const dates = (window.getStayDates && window.getStayDates()) || {};
    const start = dates.start, end = dates.end;
    const results = document.getElementById("results");

    if(!start){
        // only nag when the guest actively clicked the button (scroll = true)
        if(scroll){
            alert("Please select your check-in date first.");
            if(window.openCalendar) window.openCalendar();
        }
        return;
    }

    const hoursSel = document.getElementById("searchHours");
    const hours = hoursSel ? (Number(hoursSel.value) || 0) : 0;   // 0 = Any
    const havens = (typeof loadHavens === "function") ? loadHavens() : [];

    const available = havens.filter(h => havenAvailable(h.name, start, end, hours));

    const fmt = iso => new Date(iso + "T00:00:00").toLocaleDateString("en-GB");
    const dateRange = (end && end > start) ? `${fmt(start)} – ${fmt(end)}` : fmt(start);
    const range = dateRange + (hours ? ` · ${hours} hours` : "");

    let html = `<h2>Available Havens</h2><p style="color:#777;margin-bottom:20px;">${range}</p>`;
    if(available.length === 0){
        html += `<div class="available-card">😔 No havens are available for these dates. Please try different dates.</div>`;
    } else {
        // carry the search-bar details through to the haven page so guests
        // don't have to re-enter check-in / hours / guests
        const stay = new URLSearchParams({ checkin: start });
        if (end && end > start) stay.set("checkout", end);
        if (hours) stay.set("hours", hours);
        stay.set("adults", adults);
        stay.set("children", children);
        const query = stay.toString();

        html += `<div class="cards">` + available.map(h => `
            <a class="card" href="havens.html?id=${h.id}&${query}">
                <img src="${h.image}" alt="${h.name}">
                <h3>${h.name}</h3>
                <p>${h.description}</p>
            </a>`).join("") + `</div>`;
    }

    results.innerHTML = html;

    // hide the default "Our Havens" list once a search has been made
    const ourHavens = document.getElementById("our-havens");
    if(ourHavens) ourHavens.style.display = "none";

    if(scroll) results.scrollIntoView({ behavior: "smooth" });
}

function toggleGuests() {
    document
        .querySelector(".guest-popup")
        .classList.toggle("show");
}

// close the guest popup when clicking anywhere outside the guest selector
document.addEventListener("click", function(e){
    const popup = document.querySelector(".guest-popup");
    if(!popup || !popup.classList.contains("show")) return;
    if(e.target.closest(".guest-selector")) return;   // clicks on trigger / +/- stay open
    popup.classList.remove("show");
});

// keep the shown results in sync when the search-bar hours change
(function(){
    const hoursSel = document.getElementById("searchHours");
    if(hoursSel) hoursSel.addEventListener("change", refreshResultsIfShown);
})();