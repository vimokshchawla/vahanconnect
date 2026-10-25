/* VahanConnect prototype v2 — runs fully in the browser on the CSV files in /data.
   "Live" activity (feed, owner replies, trip tracking) is simulated for demonstration. */
(() => {
  "use strict";

  // ================================================================ config
  const COMMISSION = 0.03;          // assumed platform commission
  const ADVANCE = 0.20;             // advance paid by UPI at booking
  const MAX_DEADHEAD_KM = 150;      // max empty drive to reach the pickup
  const BROKER_MARKUP = 1.12;       // typical broker price vs owner's base rate
  const EMPTY_RUN_COST_PER_KM = 22; // diesel + tolls for an empty truck (₹/km, approx.)
  const DEMO_TRIP_MS = { fast: 120000, slow: 360000 };
  const TABLES = ["cities", "owners", "trucks", "drivers", "listings", "shippers", "loads", "bookings"];
  const TABLE_DESC = {
    cities: "34 freight hubs with coordinates. Distance = great-circle distance × 1.25 road factor.",
    owners: "Truck owners with their verification documents: licence, RC, ID, GST and background check.",
    trucks: "Every truck with its RTO-style registration number, type, capacity and the owner's base rate per km.",
    listings: "Open truck availability. is_return_trip = the truck has delivered away from home and wants a load back.",
    shippers: "Businesses that need goods moved: SMEs, manufacturers, traders and distributors.",
    loads: "Open load requests posted by shippers (plus any you post in this browser).",
    drivers: "One driver per truck with licence and ID verification flags (synthetic demo data, not real checks).",
    bookings: "Past bookings (Apr–Oct 2026) with agreed price vs typical broker price and empty km avoided.",
  };
  const STORE_KEY = "vahanconnect-demo-v2";
  const DRIVERS = ["Balwinder", "Ramesh", "Sukhdev", "Raju", "Manoj", "Irfan", "Shankar", "Gurnam", "Pappu", "Selvam", "Bablu", "Kishan"];

  // ================================================================ state
  const D = {};
  const S = {
    extra: { listings: [], trips: [], booked: {}, requests: [], loads: [], ratings: {}, speed: "fast" },
    compare: new Set(), results: [], query: null, qExtra: {}, view: null, selTrip: null,
    ds: { table: "listings", page: 0, filter: "" }, lastPhase: {}, ownerSeeded: false,
    live: { onRoad: 0, today: 0, emptyKm: 0, feed: [] },
  };
  let cityIdx = {}, ownerIdx = {}, truckIdx = {}, shipperIdx = {}, typeRate = {}, cityDeg = {}, driverByTruck = {}, GEO = null;
  const L$ = window.VCLogic;
  const I18N = window.VC_I18N || { en: {} };
  let LANG = "en";
  const T_ = (k) => (I18N[LANG] && I18N[LANG][k]) || (I18N.en && I18N.en[k]) || k;

  // ================================================================ helpers
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
  const num = (n, d = 0) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const dayDiff = (a, b) => Math.round((new Date(a + "T00:00:00Z") - new Date(b + "T00:00:00Z")) / 864e5);
  const fmtDate = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  const round100 = (n) => Math.round(n / 100) * 100;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const initials = (n) => n.split(" ").map((p) => p[0]).slice(0, 2).join("");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const parseCSV = (t) => L$.parseCSV(t);
  const distCache = new Map();
  function km(a, b) { return GEO.km(a, b); }
  function toast(html, action) {
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `<span>${html}</span>`;
    if (action) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = action.label;
      b.addEventListener("click", () => { action.fn(); t.remove(); });
      t.appendChild(b);
    }
    $("#toasts").appendChild(t);
    while ($("#toasts").children.length > 3) $("#toasts").firstChild.remove();
    setTimeout(() => t.remove(), action ? 7000 : 3800);
  }

  // ================================================================ persistence (per browser)
  function loadStore() {
    try { const v = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); if (v && v.trips) S.extra = Object.assign(S.extra, v); } catch (e) { /* unavailable */ }
  }
  function saveStore() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S.extra)); } catch (e) { /* ignore */ } }
  const allListings = () => D.listings.concat(S.extra.listings);
  const isBooked = (id) => !!S.extra.booked[id];
  const allLoads = () => D.loads.concat(S.extra.loads || []);
  const ctx = () => ({ listings: allListings(), isBooked, truckIdx, ownerIdx, typeRate, km });

  // ================================================================ data
  async function loadData() {
    try {
      const texts = await Promise.all(TABLES.map((t) => fetch(`data/${t}.csv`).then((r) => { if (!r.ok) throw new Error(t); return r.text(); })));
      TABLES.forEach((t, i) => (D[t] = parseCSV(texts[i])));
    } catch (e) {
      $("#loading").hidden = true;
      const el = $("#load-error"); el.hidden = false;
      el.innerHTML = "Could not load the dataset (<code>data/*.csv</code>). If you opened <code>index.html</code> straight from your disk, run it through a local server instead (<code>npx serve .</code> or <code>python3 -m http.server</code>), or deploy the folder to Vercel.";
      return false;
    }
    D.cities.forEach((c) => (cityIdx[c.city] = c));
    D.owners.forEach((o) => (ownerIdx[o.owner_id] = o));
    D.trucks.forEach((t) => (truckIdx[t.truck_id] = t));
    D.shippers.forEach((s) => (shipperIdx[s.shipper_id] = s));
    const acc = {};
    D.trucks.forEach((t) => { (acc[t.truck_type] ||= []).push(t.rate_per_km); });
    Object.entries(acc).forEach(([k, v]) => (typeRate[k] = v.reduce((a, b) => a + b, 0) / v.length));
    D.bookings.forEach((b) => { cityDeg[b.origin] = (cityDeg[b.origin] || 0) + 1; cityDeg[b.destination] = (cityDeg[b.destination] || 0) + 1; });
    (D.drivers || []).forEach((d) => (driverByTruck[d.truck_id] = d));
    GEO = L$.makeGeo(D.cities);
    D.owners.forEach((o) => { o._r0 = o.rating; o._t0 = o.trips_completed; });
    applyRatings();
    return true;
  }
  function applyRatings() {
    Object.entries(S.extra.ratings || {}).forEach(([id, arr]) => {
      const o = ownerIdx[id]; if (!o || !arr.length) return;
      o.rating = Math.round(((o._r0 * o._t0) + arr.reduce((a, b) => a + b, 0)) / (o._t0 + arr.length) * 10) / 10;
      o.trips_completed = o._t0 + arr.length;
    });
  }

  // ================================================================ matching engine
  function matchTrucks(q) { return L$.matchTrucks(ctx(), q); }
  // ================================================================ map (schematic, SVG)
  function makeMap(points, W, H, padFrac = 0.18) {
    let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
    points.forEach((p) => { la0 = Math.min(la0, p.lat); la1 = Math.max(la1, p.lat); lo0 = Math.min(lo0, p.lon); lo1 = Math.max(lo1, p.lon); });
    const midLat = (la0 + la1) / 2, kx = Math.cos(midLat * Math.PI / 180);
    let w = Math.max((lo1 - lo0) * kx, 1.2), h = Math.max(la1 - la0, 1.2);
    const target = W / H;
    if (w / h < target) w = h * target; else h = w / target;
    w *= 1 + padFrac * 2; h *= 1 + padFrac * 2;
    const cx = ((lo0 + lo1) / 2) * kx, cy = (la0 + la1) / 2;
    const px = (lat, lon) => [((lon * kx) - (cx - w / 2)) / w * W, ((cy + h / 2) - lat) / h * H];
    const inside = (c) => { const [x, y] = px(c.lat, c.lon); return x > -10 && x < W + 10 && y > -10 && y < H + 10; };
    return { px, inside, W, H };
  }
  function cityLayer(M, strong = []) {
    strong = [...new Set(strong)];
    let s = "";
    const vis = D.cities.filter((c) => M.inside(c));
    vis.forEach((c) => { const [x, y] = M.px(c.lat, c.lon); s += `<circle class="m-city" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${strong.includes(c.city) ? 0 : 3}"/>`; });
    const placed = [];
    const tryLabel = (c, cls) => {
      const [x, y] = M.px(c.lat, c.lon), w = c.city.length * (cls ? 7.2 : 5.6);
      for (const [lx, anchor] of [[x + 7, "start"], [x - 7, "end"]]) {
        const box = anchor === "start" ? [lx, y - 9, lx + w, y + 4] : [lx - w, y - 9, lx, y + 4];
        if (box[0] < 2 || box[2] > M.W - 2 || box[1] < 2 || box[3] > M.H - 2) continue;
        if (placed.some((p) => !(box[2] < p[0] || box[0] > p[2] || box[3] < p[1] || box[1] > p[3]))) continue;
        placed.push(box);
        s += `<text class="m-label${cls ? " strong" : ""}" x="${lx.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${anchor}">${esc(c.city)}</text>`;
        return;
      }
    };
    strong.forEach((n) => cityIdx[n] && tryLabel(cityIdx[n], true));
    vis.filter((c) => !strong.includes(c.city)).sort((a, b) => (cityDeg[b.city] || 0) - (cityDeg[a.city] || 0)).slice(0, 10).forEach((c) => tryLabel(c, false));
    return s;
  }
  const truckIcon = (x, y, cls, title) => `<g class="tm" transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><title>${esc(title)}</title><circle r="8" class="m-truck ${cls}"/><path d="M-4.2-2.2h4.6v4.2h-4.6zM0.4-0.6h2.2l1.6 1.6v1h-3.8z" fill="#fff"/></g>`;

  // ================================================================ shared UI bits
  const plate = (r) => `<span class="plate">${esc(r)}</span>`;
  function verBadge(O, interactive = true) {
    const s = O.verification_status;
    const cls = s === "Verified" ? "ok" : s === "Pending" ? "pending" : "rejected";
    const txt = s === "Verified" ? "✓ Verified" : s === "Pending" ? "Verification pending" : "Not verified";
    return interactive ? `<button type="button" class="badge ${cls}" data-verify="${O.owner_id}" title="See the five verification checks">${txt}</button>` : `<span class="badge ${cls}">${txt}</span>`;
  }
  const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(label ?? v)}</option>`;
  const cityOptions = (sel) => D.cities.map((c) => c.city).sort().map((c) => opt(c, c, c === sel)).join("");
  function matchRing(score) {
    const r = 22, c = 2 * Math.PI * r, off = c * (1 - score / 100);
    return `<svg viewBox="0 0 54 54" aria-label="Match score ${score} of 100"><circle cx="27" cy="27" r="${r}" fill="none" stroke="var(--tint)" stroke-width="5"/><circle cx="27" cy="27" r="${r}" fill="none" stroke="var(--gold)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 27 27)"/><text x="27" y="32" text-anchor="middle">${score}</text></svg>`;
  }
  function showVerification(ownerId) {
    const O = ownerIdx[ownerId];
    const docs = [["Driving licence", O.licence_verified, "Checked against Sarathi records"], ["Vehicle RC", O.rc_verified, "Registration matches the truck"], ["Identity (Aadhaar / PAN)", O.id_verified, "Name and photo match"], ["GST number", O.gst_verified, O.gst_no ? `GSTIN ${O.gst_no}` : "Not provided"], ["Background check", O.background_check, "No adverse records found"]];
    openModal(`<h2 id="modal-title">${esc(O.name)}</h2><p class="muted">${verBadge(O, false)} · ${esc(O.home_city)}, ${esc(O.state)} · ★ ${O.rating.toFixed(1)} · ${O.trips_completed} trips · joined ${fmtDate(O.joined_on)}</p>
      <div class="bill" style="margin-top:14px">${docs.map(([d, ok, note]) => `<div><span><b style="color:var(${ok ? "--good" : "--bad"})">${ok ? "✓" : "✗"}</b> ${d}</span><span class="muted small">${ok ? esc(note) : "Not verified"}</span></div>`).join("")}</div>
      <p class="small muted" style="margin-top:12px">Only owners who pass all five checks get the Verified badge. Shippers can choose to see verified owners only.</p>`);
  }

  // ================================================================ HOME + live feed
  function initHome() {
    const done = D.bookings.filter((b) => b.status === "Completed");
    const ret = done.filter((b) => b.is_return_trip).length;
    const gmv = done.reduce((a, b) => a + b.agreed_price_rs, 0), broker = done.reduce((a, b) => a + b.typical_broker_price_rs, 0);
    const emptyKm = done.reduce((a, b) => a + b.empty_km_avoided, 0);
    $("#hero-stats").innerHTML = [
      [Math.round(ret / done.length * 100) + "%", "of booked trucks were on a return trip"],
      [num(emptyKm / 1000) + "k km", "of empty driving avoided"],
      [Math.round((1 - gmv / broker) * 100) + "%", "average saving vs brokers"],
    ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join("");

    const VPC = [
      ["Empty return trips and lost earnings", "Route-based matching with return trips first", "Trucks going home are ranked first and tagged “Going home”.", "find"],
      ["Unpredictable, opaque pricing", "Direct negotiation and a visible broker benchmark", "Every truck shows the owner's price and the saving against a typical broker.", "find"],
      ["No verification before booking", "Five-point owner verification", "Licence, RC, ID, GST and background check behind every Verified badge.", "find"],
      ["Hard to compare trucks", "Side-by-side comparison", "Compare up to three trucks on price, rating, distance and fit.", "find"],
      ["Dependence on brokers and WhatsApp groups", "Owners and shippers deal directly, and you can track the trip", "Book, pay an advance and follow the truck live, without a middleman.", "trips"],
    ];
    $("#vpc").innerHTML = VPC.map(([p, f, d, v]) => `<div class="vpc-row"><div class="vpc-pain"><small>Pain</small><b>${p}</b></div><div class="vpc-arrow" aria-hidden="true">→</div>
      <div class="vpc-fix"><small>Pain reliever</small><b>${f}</b><span>${d}</span></div><button class="btn ghost small" type="button" data-go="${v}">See it</button></div>`).join("");

    // live counters seeded from the dataset
    const hr = new Date().getHours();
    S.live.onRoad = 38 + Math.round(Math.random() * 12);
    S.live.today = 8 + Math.round(hr * 1.4);
    S.live.emptyKm = S.live.today * 410;
    renderCounters();
    for (let i = 0; i < 6; i++) pushFeed(makeEvent(), Date.now() - (i + 1) * (40 + Math.random() * 80) * 1000, false);
    scheduleFeed();
  }
  function renderCounters(bump) {
    $("#live-counters").innerHTML = [["onRoad", S.live.onRoad, "trucks on the road"], ["today", S.live.today, "bookings today"], ["emptyKm", num(S.live.emptyKm), "empty km avoided today"]]
      .map(([k, v, l]) => `<div class="lc${bump === k ? " bump" : ""}"><b>${v}</b><span>${l}</span></div>`).join("");
  }
  function makeEvent() {
    const r = Math.random();
    const b = pick(D.bookings);
    if (r < 0.58) {
      const price = round100(b.agreed_price_rs * (0.95 + Math.random() * 0.1));
      const save = Math.round((1 - b.agreed_price_rs / b.typical_broker_price_rs) * 100);
      return { kind: "book", ic: "₹", html: `<b>${esc(b.company)}</b> booked ${/^[AEIOU]/.test(b.truck_type) ? "an" : "a"} ${esc(b.truck_type.split(" (")[0])}, ${esc(b.origin)} → ${esc(b.destination)}`,
        sub: `${inr(price)}${b.is_return_trip ? " · return trip filled" : ""}${save > 0 ? ` · ${save}% below broker` : ""}`, km: b.is_return_trip ? b.distance_km : 0 };
    }
    if (r < 0.8) {
      const T = truckIdx[b.truck_id];
      return { kind: "done", ic: "✓", html: `${plate(T ? T.reg_no : "MH 04 AB 1234")} delivered ${esc(b.goods.toLowerCase())} in ${esc(b.destination)}`, sub: `${num(b.distance_km)} km trip completed` };
    }
    const O = pick(D.owners.filter((o) => o.verification_status === "Verified"));
    const L = pick(D.listings.filter((l) => l.owner_id === O.owner_id)) || pick(D.listings);
    return { kind: "post", ic: initials(O.name), html: `<b>${esc(O.name)}</b> posted a truck free in ${esc(L.current_city)}`, sub: L.is_return_trip ? `Looking for a load home to ${esc(L.home_city)}` : "Open to any route" };
  }
  function pushFeed(ev, ts, animate = true) {
    ev.ts = ts || Date.now();
    S.live.feed.unshift(ev);
    S.live.feed = S.live.feed.slice(0, 7);
    if (animate) {
      if (ev.kind === "book") { S.live.today++; S.live.onRoad++; S.live.emptyKm += ev.km || 0; renderCounters("today"); }
      if (ev.kind === "done") { S.live.onRoad = Math.max(10, S.live.onRoad - 1); renderCounters("onRoad"); }
    }
    renderFeed(animate);
  }
  function ago(ts) { const s = Math.round((Date.now() - ts) / 1000); return s < 10 ? "just now" : s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`; }
  function renderFeed(animate) {
    $("#feed").innerHTML = S.live.feed.map((e, i) => `<li class="${animate && i === 0 ? "new" : ""}"><span class="ic ${e.kind}">${e.ic}</span><span>${e.html}<span class="sub">${e.sub}</span></span><span class="t">${ago(e.ts)}</span></li>`).join("");
  }
  function scheduleFeed() { setTimeout(() => { pushFeed(makeEvent()); scheduleFeed(); }, 3500 + Math.random() * 4000); }

  // ================================================================ FIND
  let ranked = [];
  function initFind() {
    const types = [...new Set(D.trucks.map((t) => t.truck_type))].sort();
    $("#q-from").innerHTML = cityOptions(); $("#q-to").innerHTML = cityOptions();
    $("#q-type").innerHTML = opt("", "Any type") + types.map((t) => opt(t)).join("");
    $("#q-shipper").innerHTML = D.shippers.slice().sort((a, b) => a.company.localeCompare(b.company)).map((s) => opt(s.shipper_id, `${s.company} (${s.city})`)).join("");
    ranked = D.loads.map((l) => {
      const m = matchTrucks({ from: l.origin, to: l.destination, date: l.pickup_date, weight: l.weight_tonnes, type: l.truck_type, verifiedOnly: true, sort: "score" });
      return { l, n: m.length, ret: m.filter((x) => x.isRet).length };
    }).filter((x) => x.n >= 3 && x.ret > 0).sort((a, b) => b.n - a.n || b.ret - a.ret);
    // chips: distinct routes
    const seen = new Set(), chips = [];
    for (const r of ranked) { const k = r.l.origin + r.l.destination; if (!seen.has(k)) { seen.add(k); chips.push(r.l); } if (chips.length === 4) break; }
    $("#chips").innerHTML = chips.map((l) => `<button type="button" class="chip" data-load="${l.load_id}">${esc(l.origin)} → ${esc(l.destination)} · ${l.weight_tonnes} t</button>`).join("");
    $("#sample-load").innerHTML = opt("", "Choose a load…") + ranked.slice(0, 40).map(({ l, n }) => opt(l.load_id, `${l.company}: ${l.origin} → ${l.destination}, ${l.weight_tonnes} t, ${fmtDate(l.pickup_date)} (${n} trucks)`)).join("");

    $("#chips").addEventListener("click", (e) => { const b = e.target.closest("[data-load]"); if (b) applyLoad(D.loads.find((l) => l.load_id === b.dataset.load)); });
    $("#sample-load").addEventListener("change", (e) => { if (e.target.value) applyLoad(D.loads.find((l) => l.load_id === e.target.value)); });
    $("#swap").addEventListener("click", () => { const a = $("#q-from").value; $("#q-from").value = $("#q-to").value; $("#q-to").value = a; $$(".chip").forEach((c) => c.classList.remove("on")); runSearch({ animate: true }); });
    $("#search-form").addEventListener("submit", (e) => { e.preventDefault(); S.qExtra = {}; $$(".chip").forEach((c) => c.classList.remove("on")); runSearch({ animate: true }); });
    $("#results").addEventListener("keydown", (e) => { const o = e.target.closest(".opt"); if (o && (e.key === "Enter" || e.key === " ") && e.target === o) { e.preventDefault(); selectTruck(o.dataset.sel); } });
    $("#book-bar").addEventListener("click", onResultClick);
    $("#trip-summary").addEventListener("click", expandForm);
    $("#route-map").addEventListener("click", (e) => { const g = e.target.closest("[data-sel]"); if (g) selectTruck(g.dataset.sel, true); });
    let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (S.view === "find" && S.query && $("#scan").hidden) drawResultMap(); }, 200); });
    ["#q-sort", "#q-verified", "#q-type"].forEach((s) => $(s).addEventListener("change", () => S.query && runSearch()));
    $("#compare-clear").addEventListener("click", () => { S.compare.clear(); renderResults(); });
    $("#compare-open").addEventListener("click", openCompare);
    $("#results").addEventListener("click", onResultClick);
    $("#results").addEventListener("change", (e) => {
      if (!e.target.matches("[data-compare]")) return;
      const id = e.target.dataset.compare;
      if (e.target.checked) { if (S.compare.size >= 3) { e.target.checked = false; toast("Compare up to 3 trucks at a time"); return; } S.compare.add(id); }
      else S.compare.delete(id);
      renderCompareBar();
    });
    if (chips[0]) applyLoad(chips[0], false);
  }
  function applyLoad(l, animate = true) {
    $("#q-from").value = l.origin; $("#q-to").value = l.destination; $("#q-date").value = l.pickup_date;
    $("#q-weight").value = l.weight_tonnes; $("#q-type").value = l.truck_type; $("#q-shipper").value = l.shipper_id;
    $$(".chip").forEach((c) => c.classList.toggle("on", c.dataset.load === l.load_id));
    S.qExtra = {};
    runSearch({ animate });
  }
  function readQuery() {
    return Object.assign({ from: $("#q-from").value, to: $("#q-to").value, date: $("#q-date").value, weight: parseFloat($("#q-weight").value),
      type: $("#q-type").value, verifiedOnly: $("#q-verified").checked, sort: $("#q-sort").value, shipper: $("#q-shipper").value }, S.qExtra);
  }
  function runSearch(opts = {}) {
    const q = readQuery();
    if (q.from === q.to) { toast("Pickup and drop city are the same. Choose a different drop city."); return; }
    if (!q.date) { toast("Choose a pickup date"); $("#q-date").focus(); return; }
    if (!(q.weight > 0) || q.weight > 40) { toast("Enter a weight between 0.1 and 40 tonnes"); $("#q-weight").focus(); return; }
    S.query = q; S.results = matchTrucks(q); S.compare.clear();
    const token = (S.searchToken = (S.searchToken || 0) + 1);
    if (opts.animate && S.view === "find") return animateSearch(q, token);
    $("#scan").hidden = true;
    renderResults();
  }

  // --- the "finding trucks" sequence: every number is computed from the dataset
  function scanFunnel(q) { return L$.funnel(ctx(), q, S.results); }
  async function animateSearch(q, token) {
    const F = scanFunnel(q);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const STEP = reduce ? 150 : 620;
    const R = S.results, ret = R.filter((r) => r.isRet).length;
    const verifiedFinal = R.filter((r) => r.O.verification_status === "Verified").length;
    const steps = [
      { lbl: `Locating pickup in ${q.from}`, res: `${F.near} truck${F.near === 1 ? "" : "s"} within ${q.radius || MAX_DEADHEAD_KM} km`, out: null },
      { lbl: `Checking who is free on ${fmtDate(q.date)}`, res: `${F.free} available`, out: 2 },
      { lbl: `Matching ${q.type || "any truck"} that can carry ${q.weight} t`, res: `${F.fits} can carry it`, out: 3 },
      { lbl: q.verifiedOnly ? "Verifying owners: licence, RC, ID, GST, background" : "Checking owner verification", res: q.verifiedOnly ? `${F.final} fully verified` : `${verifiedFinal} of ${F.final} verified`, out: 4 },
      { lbl: `Looking for trucks heading to ${q.to}`, res: ret ? `${ret} going home your way` : "none heading home this way", out: "ret" },
      { lbl: "Ranking by route fit, price and rating", res: R.length ? `best match ${R[0].score}/100` : "no match", out: null },
    ];
    collapseForm(q);
    // panel: hide results, show scanner
    $("#results").innerHTML = ""; $("#results-head").hidden = true; $("#book-bar").hidden = true; $("#compare-bar").hidden = true;
    const scan = $("#scan");
    scan.hidden = false;
    scan.innerHTML = `<div class="scan-title"><span class="dot"></span>Finding trucks for you<button type="button" class="btn ghost small skip" id="scan-skip">Skip</button></div><div class="scan-bar"><i id="scan-prog"></i></div><ol id="scan-steps"></ol>`;
    drawScanMap(q, F);
    $("#scan-skip").addEventListener("click", () => { S.searchToken++; $("#scan").hidden = true; renderResults(true); });
    if (matchMedia("(max-width: 980px)").matches) $(".ride-map").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      $("#scan-steps").insertAdjacentHTML("beforeend", `<li id="sc${i}"><span class="st"></span><span class="lbl">${esc(s.lbl)}…</span><span class="res">checking</span></li>`);
      await wait(STEP);
      if (token !== S.searchToken) return;
      const li = $("#sc" + i); li.classList.add("ok"); li.querySelector(".lbl").textContent = s.lbl; li.querySelector(".res").textContent = s.res;
      $("#scan-prog").style.width = Math.round((i + 1) / steps.length * 100) + "%";
      if (typeof s.out === "number") $$(`#route-map .tm[data-stage="${s.out}"]`).forEach((g) => g.classList.add("out"));
      if (s.out === "ret") $$('#route-map .tm[data-ret="1"]').forEach((g) => g.querySelector(".m-truck").classList.add("ret"));
    }
    await wait(reduce ? 100 : 450);
    if (token !== S.searchToken) return;
    $(".scan-title").innerHTML = R.length ? `✓ ${R.length} truck${R.length === 1 ? "" : "s"} found` : "No trucks found";
    await wait(reduce ? 50 : 350);
    if (token !== S.searchToken) return;
    scan.hidden = true;
    renderResults(true);
  }

  function collapseForm(q) {
    const sum = $("#trip-summary");
    sum.innerHTML = `<span class="ts-route"><i class="pin-a"></i>${esc(q.from)}<span class="ts-arrow">→</span><i class="pin-b"></i>${esc(q.to)}</span><span class="ts-meta">${fmtDate(q.date)} · ${q.weight} t${q.type ? " · " + esc(q.type.replace(" (Tata 407 class)", "")) : ""}</span><span class="ts-edit">Edit</span>`;
    sum.hidden = false; $("#search-form").hidden = true;
  }
  function expandForm() { $("#trip-summary").hidden = true; $("#search-form").hidden = false; $("#q-from").focus(); }
  function mapSize() {
    const el = $("#route-map"), w = el.clientWidth || 640, h = el.clientHeight || 480;
    const W = clamp(Math.round(w), 320, 900);
    return { W, H: Math.max(240, Math.round(W * h / w)) };
  }
  function truckSlots(q, items, M) {
    // position each truck at its city; several trucks in one city fan out on an arc left of the city
    const per = {}, slot = {}, pos = new Map();
    items.forEach((it) => (per[it.city] = (per[it.city] || 0) + 1));
    items.forEach((it) => {
      const C = cityIdx[it.city]; let [x, y] = M.px(C.lat, C.lon);
      const cnt = per[it.city], n = (slot[it.city] = (slot[it.city] || 0) + 1) - 1;
      if (cnt > 1 || it.city === q.from) {
        // concentric rings around the city, leaving a gap on the right for its label
        let ring = 0, idx = n, cap;
        while (true) { const rad = 24 + ring * 19; cap = Math.max(1, Math.floor(((2 * Math.PI - 1.1) * rad) / 21)); if (idx < cap) break; idx -= cap; ring++; }
        const rad = 24 + ring * 19, inRing = Math.min(cap, cnt - (n - idx));
        const ang = 0.55 + (2 * Math.PI - 1.1) * ((idx + 0.5) / Math.max(inRing, 1));
        x += Math.cos(ang) * rad; y += Math.sin(ang) * rad;
      }
      pos.set(it.id, [x, y]);
    });
    return pos;
  }
  function baseMap(q, extraCities) {
    const A = cityIdx[q.from], B = cityIdx[q.to], { W, H } = mapSize();
    const M = makeMap([A, B, ...extraCities.map((c) => cityIdx[c])], W, H, 0.16);
    const [ax, ay] = M.px(A.lat, A.lon), [bx, by] = M.px(B.lat, B.lon);
    const head = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">` + cityLayer(M, [q.from, q.to]) + `<path class="m-route" d="M${ax},${ay} L${bx},${by}"/>`;
    const ends = `<circle class="m-end" cx="${ax}" cy="${ay}" r="7"/><rect class="m-end" x="${bx - 6}" y="${by - 6}" width="12" height="12"/>`;
    return { M, ax, ay, head, ends };
  }
  function drawScanMap(q, F) {
    const show = F.all.filter((c) => c.stage === 0).slice(0, 14).concat(F.all.filter((c) => c.stage !== 0).slice(0, 12));
    const items = show.map((c) => ({ id: c.T.truck_id, city: c.L.current_city, c }));
    const { M, ax, ay, head, ends } = baseMap(q, [...new Set(items.map((i) => i.city))]);
    const pos = truckSlots(q, items, M);
    let svg = head + `<g class="radar"><circle cx="${ax}" cy="${ay}" r="110"/><circle cx="${ax}" cy="${ay}" r="110"/><circle cx="${ax}" cy="${ay}" r="110"/></g>`;
    items.forEach((it, i) => {
      const [x, y] = pos.get(it.id), r = S.results.find((m) => m.T.truck_id === it.id);
      svg += `<g class="tm pop" data-stage="${it.c.stage}" data-ret="${r && r.isRet ? 1 : 0}" style="animation-delay:${i * 45}ms" transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><circle r="8" class="m-truck"/><path d="M-4.2-2.2h4.6v4.2h-4.6zM0.4-0.6h2.2l1.6 1.6v1h-3.8z" fill="#fff"/></g>`;
    });
    $("#route-map").innerHTML = svg + ends + "</svg>";
    $("#map-chip").innerHTML = `<span class="dot"></span>Searching near ${esc(q.from)} <span class="muted">· ${num(km(q.from, q.to))} km trip</span>`;
  }
  function drawResultMap() {
    const q = S.query, R = S.results.slice(0, 14);
    const items = R.map((r) => ({ id: r.L.listing_id, city: r.L.current_city, r }));
    const { M, ax, ay, head, ends } = baseMap(q, [...new Set(items.map((i) => i.city))]);
    const pos = truckSlots(q, items, M);
    let svg = head, selTag = "";
    items.slice().reverse().forEach((it) => {
      const [x, y] = pos.get(it.id), r = it.r, sel = it.id === S.sel;
      if (r.deadhead && sel) svg += `<path class="m-deadhead" d="M${x},${y} L${ax},${ay}"/>`;
      svg += `<g class="tm${sel ? " sel" : ""}" data-sel="${it.id}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><title>${esc(r.T.reg_no)} · ${esc(r.O.name)} · ${inr(r.price)}</title><circle r="${sel ? 11 : 8}" class="m-truck${r.isRet ? " ret" : ""}"/><path d="M-4.2-2.2h4.6v4.2h-4.6zM0.4-0.6h2.2l1.6 1.6v1h-3.8z" fill="#fff"/></g>`;
      if (sel) { const t = inr(r.price), w = t.length * 7.4 + 14; selTag = `<g class="price-tag" transform="translate(${(x - w / 2).toFixed(1)},${(y - 38).toFixed(1)})"><rect width="${w}" height="22" rx="11"/><text x="${w / 2}" y="15" text-anchor="middle">${t}</text></g>`; }
    });
    $("#route-map").innerHTML = svg + ends + selTag + "</svg>";
    $("#map-chip").innerHTML = `${esc(q.from)} → ${esc(q.to)} <span class="muted">· ${num(km(q.from, q.to))} km · ${R.length ? S.results.length + " trucks" : "no trucks"}</span>`;
  }

  const TRUCK_SVG = `<svg viewBox="0 0 40 28" aria-hidden="true"><rect x="1" y="5" width="23" height="15" rx="2" fill="currentColor"/><path d="M24 9h8l6 6v5H24z" fill="currentColor" opacity=".75"/><path d="M27 11h4l3.4 3.6H27z" fill="#fff" opacity=".85"/><circle cx="8" cy="22" r="3.6" fill="var(--fg)"/><circle cx="8" cy="22" r="1.4" fill="#fff"/><circle cx="31" cy="22" r="3.6" fill="var(--fg)"/><circle cx="31" cy="22" r="1.4" fill="#fff"/></svg>`;
  function etaText(r) {
    if (r.L.current_city === S.query.from) return `In ${esc(S.query.from)} now`;
    const h = r.deadhead / 40;
    return `${r.deadhead} km away · ~${h < 1 ? Math.max(15, Math.round(h * 60 / 5) * 5) + " min" : Math.round(h * 10) / 10 + " h"}`;
  }
  function renderResults(reveal) {
    const q = S.query, R = S.results;
    $("#scan").hidden = true;
    if (!R.some((r) => r.L.listing_id === S.sel)) S.sel = R[0] ? R[0].L.listing_id : null;
    S.lane = L$.laneStats(D.bookings, q.from, q.to, q.type);
    const head = $("#results-head"); head.hidden = false;
    const filters = [q.type || "Any truck type", q.verifiedOnly ? "Verified owners only" : "Incl. unverified", `${q.radius || MAX_DEADHEAD_KM} km pickup radius`];
    head.innerHTML = `<div><h2>${R.length ? T_("res.available").replace("{n}", R.length) : T_("res.none")}</h2>
      <p class="muted small">${esc(q.from)} → ${esc(q.to)} · ${fmtDate(q.date)} · ${q.weight} t</p><div class="filter-chips">${filters.map((f) => `<span class="tag">${esc(f)}</span>`).join("")}</div></div>
      <label class="sort-inline"><span class="sr-only">Sort by</span><select id="sort-inline" aria-label="Sort by">${["score:Best match", "price:Lowest price", "rating:Highest rating", "date:Earliest"].map((o) => { const [v, l] = o.split(":"); return `<option value="${v}"${q.sort === v ? " selected" : ""}>${l}</option>`; }).join("")}</select></label>`;
    $("#sort-inline").addEventListener("change", (e) => { $("#q-sort").value = e.target.value; runSearch(); });
    if (!R.length) {
      const alts = L$.alternatives(ctx(), q);
      $("#results").innerHTML = `<div class="empty-smart"><b>No open truck fits this load yet.</b><p class="muted small">Your load stays ${q.weight} t; these suggestions only change the search, and each count comes from the dataset.</p>
        ${alts.length ? `<div class="alts">${alts.map((a, i) => `<button type="button" class="alt-sug" data-alt="${i}"><span>${esc(a.label)}</span><b>${a.n} truck${a.n === 1 ? "" : "s"}</b></button>`).join("")}</div>` : `<p class="small">No nearby dates, wider radius or other truck types have matches either. Try another route or <a href="#post">post this load</a> so owners can find it.</p>`}</div>`;
      $("#results").onclick = (e) => { const b = e.target.closest("[data-alt]"); if (!b) return; applyAlt(alts[+b.dataset.alt]); };
      $("#book-bar").hidden = true; drawResultMap(); renderCompareBar(); return;
    }
    $("#results").onclick = null;
    const cards = R.slice(0, 24).map((r, i) => optHTML(r, i, reveal));
    if (cards.length >= 3) cards.splice(3, 0, sponsoredHTML());
    $("#results").innerHTML = laneHTML(q) + cards.join("") + (R.length > 24 ? `<div class="empty">Showing the top 24 of ${R.length} matches.</div>` : "");
    drawResultMap(); renderBookBar(); renderCompareBar();
  }
  function applyAlt(a) {
    if (a.patch.date) $("#q-date").value = a.patch.date;
    if ("verifiedOnly" in a.patch) $("#q-verified").checked = a.patch.verifiedOnly;
    if ("type" in a.patch) $("#q-type").value = a.patch.type;
    if (a.patch.radius) S.qExtra.radius = a.patch.radius;
    runSearch({ animate: true });
  }
  function laneHTML(q) {
    const st = S.lane, typeTxt = q.type ? esc(q.type.replace(" (Tata 407 class)", "")) : "all truck types";
    if (st.scope === "lane") return `<div class="lane"><div><b>Price guide · ${esc(q.from)} → ${esc(q.to)}</b><span class="muted small">${st.n} completed bookings, ${typeTxt}</span></div>
      <div class="lane-nums"><span>Low<b>${inr(st.min)}</b></span><span>Median<b>${inr(st.median)}</b></span><span>High<b>${inr(st.max)}</b></span></div>
      <p class="muted small">Past prices in the dataset are a reference, not a guaranteed market rate.</p></div>`;
    if (st.scope === "type") return `<div class="lane"><div><b>Price guide</b><span class="muted small">${st.laneN ? `Only ${st.laneN} past booking${st.laneN === 1 ? "" : "s"} on this exact lane` : "No past bookings on this exact lane"}, so this uses ${typeTxt} across ${st.n} bookings</span></div>
      <div class="lane-nums"><span>Typical rate<b>₹${Math.round(st.perKm)}/km</b></span><span>For ${num(km(q.from, q.to))} km<b>≈ ${inr(round100(st.perKm * km(q.from, q.to)))}</b></span></div>
      <p class="muted small">A reference from other routes, not a quote for this lane.</p></div>`;
    return "";
  }
  function sponsoredHTML() {
    return `<aside class="sponsored" aria-label="Sponsored"><span class="tag">Sponsored</span><div><b>TyreCare Highway Assist</b><span class="muted small">Puncture and tyre help along major corridors. (Fictional partner.)</span></div>
      <span class="muted small sp-note">Illustrative sponsored placement — not a real advertisement.</span></aside>`;
  }
  function optHTML(r, i, reveal) {
    const { L, T, O } = r, sel = L.listing_id === S.sel, fair = L$.fairBadge(r.price, r.tripKm, S.lane);
    return `<div class="opt${sel ? " sel" : ""}${r.isRet ? " ret" : ""}${reveal ? " reveal" : ""}" style="--i:${i}" data-sel="${L.listing_id}" role="button" tabindex="0" aria-pressed="${sel}">
      <div class="opt-icon">${TRUCK_SVG}</div>
      <div class="opt-main">
        <div class="opt-top">${esc(T.truck_type.replace(" (Tata 407 class)", ""))} · ${T.capacity_tonnes} t ${r.isRet ? `<span class="tag gold">Going home</span>` : ""}</div>
        <div class="opt-sub">${plate(T.reg_no)} <span class="opt-eta">${etaText(r)}</span> · free ${fmtDate(L.available_from)}</div>
        <div class="opt-sub">${esc(O.name)} ★ ${O.rating.toFixed(1)} ${verBadge(O)}</div>
        <div class="opt-links"><button type="button" class="linkbtn" data-why="${L.listing_id}">${T_("res.why")}</button><button type="button" class="linkbtn" data-details="${L.listing_id}">${T_("res.details")}</button><label class="check"><input type="checkbox" data-compare="${L.listing_id}"${S.compare.has(L.listing_id) ? " checked" : ""}> ${T_("res.compare")}</label></div>
      </div>
      <div class="opt-price"><b>${inr(r.price)}</b>${r.market > r.price ? `<s title="Typical broker price">${inr(r.market)}</s>` : ""}${fair ? `<span class="fair ${fair.level}">${fair.label}</span>` : ""}<span class="mm">${r.score}% match</span></div>
    </div>`;
  }
  function renderBookBar() {
    const r = S.results.find((x) => x.L.listing_id === S.sel), bb = $("#book-bar");
    if (!r) { bb.hidden = true; return; }
    bb.hidden = false;
    const save = Math.max(0, r.market - r.price);
    bb.innerHTML = `<div class="bb-sum"><span>${plate(r.T.reg_no)} <b>${esc(r.O.name)}</b> · ${esc(r.dirLabel)}</span><span>${save ? `Save <b style="color:var(--good)">${inr(save)}</b>` : ""}</span></div>
      <div class="bb-act"><button class="btn primary lg" type="button" data-book="${r.L.listing_id}">${T_("res.bookFor")} ${inr(r.price)}</button></div>`;
  }
  function selectTruck(id, scrollList) {
    if (!id || id === S.sel) return;
    S.sel = id;
    $$("#results .opt").forEach((o) => { const on = o.dataset.sel === id; o.classList.toggle("sel", on); o.classList.remove("reveal"); o.setAttribute("aria-pressed", on); });
    drawResultMap(); renderBookBar();
    if (scrollList) { const o = $(`#results .opt[data-sel="${id}"]`); if (o) o.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  }
  const q = () => S.query;
  function renderCompareBar() {
    const n = S.compare.size; $("#compare-bar").hidden = n === 0;
    $("#compare-text").textContent = `${n} truck${n === 1 ? "" : "s"} selected`;
    $("#compare-open").disabled = n < 2;
  }
  function openCompare() {
    const items = S.results.filter((r) => S.compare.has(r.L.listing_id));
    const best = Math.min(...items.map((r) => r.price));
    const rows = [
      ["Owner", (r) => `${esc(r.O.name)}<br>${verBadge(r.O)}`],
      ["Truck", (r) => `${plate(r.T.reg_no)}<br>${esc(r.T.truck_type)}, ${r.T.capacity_tonnes} t`],
      ["Match", (r) => `<b>${r.score}</b> / 100`],
      ["Return trip", (r) => (r.isRet ? `<span class="tag gold">Going home</span>` : "No")],
      ["Distance to pickup", (r) => (r.deadhead ? `${r.deadhead} km` : "Already there")],
      ["Available", (r) => `${fmtDate(r.L.available_from)} – ${fmtDate(r.L.available_until)}`],
      ["Rating", (r) => `★ ${r.O.rating.toFixed(1)} (${r.O.trips_completed} trips)`],
      ["Owner's price", (r) => `<b>${inr(r.price)}</b>${r.price === best ? ` <span class="tag good">Lowest</span>` : ""}`],
      ["Saving vs broker", (r) => inr(Math.max(0, r.market - r.price))],
      ["", (r) => `<button class="btn primary small" data-book="${r.L.listing_id}" type="button">Book</button> <button class="btn ghost small" data-uncompare="${r.L.listing_id}" type="button" aria-label="Remove ${esc(r.O.name)} from comparison">Remove</button>`],
    ];
    openModal(`<h2 id="modal-title">Compare trucks</h2><p class="muted small">${esc(q().from)} → ${esc(q().to)}, ${q().weight} t, ${fmtDate(q().date)}</p>
      <div class="table-wrap" style="margin-top:12px"><table class="data compare"><tbody>${rows.map(([h, f]) => `<tr><th>${h}</th>${items.map((r) => `<td>${f(r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    $("#modal-body").addEventListener("click", onResultClick);
  }
  function onResultClick(e) {
    const v = e.target.closest("[data-verify]");
    if (v) { e.preventDefault(); showVerification(v.dataset.verify); return; }
    const b = e.target.closest("[data-book]");
    if (b) { openBooking(S.results.find((r) => r.L.listing_id === b.dataset.book)); return; }
    const w = e.target.closest("[data-why]"); if (w) { showWhy(S.results.find((r) => r.L.listing_id === w.dataset.why)); return; }
    const d = e.target.closest("[data-details]"); if (d) { showDetails(S.results.find((r) => r.L.listing_id === d.dataset.details)); return; }
    const x = e.target.closest("[data-uncompare]"); if (x) { S.compare.delete(x.dataset.uncompare); renderResults(); S.compare.size >= 2 ? openCompare() : closeModal(); return; }
    if (e.target.closest("label.check, input")) return;
    const o = e.target.closest(".opt");
    if (o) selectTruck(o.dataset.sel);
  }
  function showWhy(r) {
    if (!r) return;
    const W = L$.CFG.WEIGHTS, P = r.parts, q = S.query;
    const rows = [
      ["loc", "Pickup proximity", r.deadhead ? `${r.deadhead} km from ${q.from}` : `Already in ${q.from}`],
      ["dir", "Direction / return trip", r.dirLabel],
      ["date", "Date closeness", `Free from ${fmtDate(r.L.available_from)} (pickup ${fmtDate(q.date)})`],
      ["cap", "Capacity fit", `${q.weight} t of ${r.T.capacity_tonnes} t (${Math.round(r.fit * 100)}%)`],
      ["rating", "Owner rating", `★ ${r.O.rating.toFixed(1)}`],
      ["ver", "Verification", r.O.verification_status],
    ];
    openModal(`<h2 id="modal-title">Why this match? ${r.score}/100</h2><p class="muted small">A simple weighted score, not AI. Each factor scores 0–1 and is multiplied by its weight.</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Factor</th><th>Details</th><th class="num">Weight</th><th class="num">Points</th></tr></thead><tbody>
      ${rows.map(([k, l, d]) => `<tr><td>${l}</td><td>${esc(d)}</td><td class="num">${W[k]}</td><td class="num"><b>${(W[k] * P[k]).toFixed(1)}</b></td></tr>`).join("")}
      </tbody></table></div><p class="small muted" style="margin-top:10px">Trucks must also pass hard filters: right type, enough capacity, free on the date, and within ${q.radius || MAX_DEADHEAD_KM} km of pickup.</p>`);
  }
  function showDetails(r) {
    if (!r) return;
    const D2 = driverByTruck[r.T.truck_id], O = r.O;
    openModal(`<h2 id="modal-title">${esc(r.T.truck_type)} · ${r.T.capacity_tonnes} t</h2><p class="muted small">${plate(r.T.reg_no)} · model ${r.T.model_year} · ${r.T.gps_enabled ? "GPS fitted" : "No GPS"}</p>
      <dl class="kv">
        <div><dt>Owner</dt><dd>${esc(O.name)} ★ ${O.rating.toFixed(1)} · ${O.trips_completed} trips</dd></div>
        <div><dt>Owner verification</dt><dd>${verBadge(O, false)}</dd></div>
        <div><dt>Driver</dt><dd>${D2 ? `${esc(D2.name)} · ${D2.experience_years} yrs` : "Not listed"}</dd></div>
        <div><dt>Driver checks</dt><dd>${D2 ? `Licence ${D2.licence_verified ? "✓" : "pending"} · ID ${D2.id_verified ? "✓" : "pending"}` : "–"}</dd></div>
        <div><dt>Now in</dt><dd>${esc(r.L.current_city)}${r.deadhead ? ` (${r.deadhead} km to pickup)` : ""}</dd></div>
        <div><dt>Available</dt><dd>${fmtDate(r.L.available_from)} – ${fmtDate(r.L.available_until)}</dd></div>
        <div><dt>Owner's price</dt><dd>${inr(r.price)} · ${r.L.asking_rate_per_km} ₹/km</dd></div>
        <div><dt>Route distance</dt><dd>${num(r.tripKm)} km (estimate)</dd></div>
      </dl><p class="small muted">Verification flags are synthetic demo data; no real documents were checked.</p>
      <button class="btn primary lg" type="button" data-book="${r.L.listing_id}">Request booking · ${inr(r.price)}</button>`);
    $("#modal-body").addEventListener("click", onResultClick);
  }
  // ================================================================ booking stepper
  function stepper(i) {
    return `<ol class="stepper">${["Request", "Negotiate", "Pay advance", "Track"].map((s, k) => `<li class="${k < i ? "done" : k === i ? "on" : ""}">${k + 1}. ${s}</li>`).join("")}</ol>`;
  }
  function openBooking(r) {
    if (!r) return;
    const sh = shipperIdx[q().shipper];
    const ctx = { r, q: { ...q() }, sh, ask: r.price, rounds: 0 };
    openModal(`<h2 id="modal-title">Book ${esc(r.O.name)}'s truck</h2>
      <p class="muted small">${verBadge(r.O, false)} · ${plate(r.T.reg_no)} · ${esc(r.T.truck_type)}, ${r.T.capacity_tonnes} t</p>
      <div id="stp">${stepper(0)}</div>
      <div id="step-body">
        <dl class="kv">
          <div><dt>Route</dt><dd>${esc(ctx.q.from)} → ${esc(ctx.q.to)} (${num(r.tripKm)} km)</dd></div>
          <div><dt>Pickup</dt><dd>${fmtDate(ctx.q.date)} · ${ctx.q.weight} t</dd></div>
          <div><dt>Booking as</dt><dd>${esc(sh ? sh.company : "Guest shipper")}</dd></div>
          <div><dt>Owner's price</dt><dd>${inr(r.price)} <span class="muted small">(broker ≈ ${inr(r.market)})</span></dd></div>
          <div><dt>Truck now in</dt><dd>${esc(r.L.current_city)}${r.deadhead ? ` (${r.deadhead} km away)` : ""}</dd></div>
          <div><dt>Owner contact</dt><dd class="muted">Shared after booking</dd></div>
        </dl>
        <button class="btn primary lg" id="send-req" type="button">Send booking request</button>
      </div>`);
    $("#send-req").addEventListener("click", () => startNegotiation(ctx));
  }
  async function startNegotiation(ctx) {
    const { r } = ctx;
    $("#stp").innerHTML = stepper(1);
    $("#step-body").innerHTML = `<p class="small muted">VahanConnect does not set the price. You and the owner agree it here. <span class="online" id="online" hidden>${esc(r.O.name.split(" ")[0])} is online</span></p>
      <div class="chat" id="chat" style="margin-top:10px"></div>
      <div class="nego-row" id="nego-row" hidden>
        <div class="field"><label for="offer">Your offer (₹)</label><input type="number" id="offer" step="100" min="1000" value="${round100(r.price * 0.92)}"></div>
        <button class="btn navy" id="send-offer" type="button">Send offer</button>
        <button class="btn primary" id="accept-ask" type="button">Accept ${inr(r.price)}</button>
      </div>`;
    sys(`Request sent to ${r.O.name}`);
    await wait(900); $("#online").hidden = false;
    await ownerSays(`Namaste! My truck is ${r.L.current_city === ctx.q.from ? "in " + esc(ctx.q.from) : r.deadhead + " km from " + esc(ctx.q.from)}${r.isRet ? ` and I'm heading back to ${esc(r.L.home_city)}, so this load suits me well` : ""}. For ${num(r.tripKm)} km my price is ${inr(r.price)}.`);
    $("#nego-row").hidden = false;
    $("#send-offer").addEventListener("click", async () => {
      const offer = round100(parseFloat($("#offer").value));
      if (!(offer > 0)) return;
      ctx.rounds++; say("me", `I can offer ${inr(offer)}.`); $("#nego-row").hidden = true;
      const ratio = offer / ctx.ask;
      if (ratio >= 0.97) { await ownerSays(`Theek hai, ${inr(offer)} works for me.`); return toPay(ctx, offer); }
      if (ratio >= 0.88 && ctx.rounds < 3) { ctx.ask = round100((offer + ctx.ask) / 2); await ownerSays(`Diesel and tolls are high on this route. Meet me at ${inr(ctx.ask)}?`); }
      else if (ctx.rounds >= 3) await ownerSays(`My final price is ${inr(ctx.ask)}.`);
      else { ctx.ask = round100(ctx.ask * 0.96); await ownerSays(`That's too low for ${num(r.tripKm)} km. Best I can do is ${inr(ctx.ask)}.`); }
      $("#accept-ask").textContent = `Accept ${inr(ctx.ask)}`; $("#offer").value = round100(ctx.ask * 0.97); $("#nego-row").hidden = false;
    });
    $("#accept-ask").addEventListener("click", () => { say("me", `Done, ${inr(ctx.ask)}. Let's book.`); toPay(ctx, ctx.ask); });
  }
  function say(who, text) { const c = $("#chat"); if (c) { c.insertAdjacentHTML("beforeend", `<div class="msg ${who}">${text}</div>`); c.lastElementChild.scrollIntoView({ block: "nearest" }); } }
  const sys = (t) => say("sys", esc(t));
  async function ownerSays(text) {
    const c = $("#chat"); if (!c) return;
    c.insertAdjacentHTML("beforeend", `<div class="msg them typing" id="typing"><span></span><span></span><span></span></div>`);
    await wait(900 + Math.min(1400, text.length * 12));
    const t = $("#typing"); if (t) t.remove();
    say("them", text);
  }
  function toPay(ctx, price) {
    ctx.price = price;
    const fee = Math.round(price * COMMISSION), adv = round100(price * ADVANCE);
    setTimeout(() => {
      if (!$("#stp")) return;
      $("#stp").innerHTML = stepper(2);
      $("#step-body").innerHTML = `<div class="bill">
          <div><span>Agreed freight (${esc(ctx.q.from)} → ${esc(ctx.q.to)})</span><span>${inr(price)}</span></div>
          <div><span>Platform fee (assumed ${COMMISSION * 100}%)</span><span>${inr(fee)}</span></div>
          <div class="total"><span>Total</span><span>${inr(price + fee)}</span></div>
          <div class="muted small"><span>You save ${inr(Math.max(0, ctx.r.market - price))} vs a typical broker${ctx.r.isRet ? ` · the owner avoids ${num(ctx.r.tripKm)} empty km` : ""}</span></div>
        </div>
        <div class="upi"><span class="upi-logo">UPI</span><div style="flex:1;min-width:160px"><b>Pay ${inr(adv)} advance now</b><div class="muted small">${ADVANCE * 100}% of freight. Balance ${inr(price + fee - adv)} on delivery. Simulated payment: no money moves.</div></div>
          <button class="btn primary" id="pay" type="button">Pay ${inr(adv)}</button></div>
        <div class="trust"><b>Proposed protections</b> <span class="tag">Not active in this prototype</span><ul><li>Payment held until delivery</li><li>Goods-in-transit cover</li><li>Benefits for completed on-platform bookings</li><li>Documented shipment history</li></ul></div>`;
      $("#pay").addEventListener("click", async () => {
        const b = $("#pay"); b.disabled = true; b.innerHTML = `<span class="spinner"></span> Processing`;
        await wait(1700);
        const ref = String(Math.floor(1e11 + Math.random() * 9e11));
        $(".upi").outerHTML = `<div class="success" style="margin-top:12px">✓ Advance of ${inr(adv)} paid · UPI ref ${ref}</div>
          <button class="btn primary lg" id="go-track" type="button" style="margin-top:12px">Confirm booking and track truck</button>`;
        $("#go-track").addEventListener("click", () => { const t = createShipperTrip(ctx, fee, adv, ref); closeModal(); openTrip(t.id); toast(`<b>Booking confirmed.</b> ${esc(t.reg_no)} is assigned to your load.`); });
      });
    }, 700);
  }

  // ================================================================ trips (simulated live tracking)
  function phasesFor(t) {
    const hrs = [0.5, Math.max(0.5, t.deadhead / 40), 2, t.distance_km / 45, 1.5];
    const total = hrs.reduce((a, b) => a + b, 0);
    let acc = 0; const cut = hrs.map((h) => (acc += h) / total);
    return { cut, total };
  }
  function midCity(a, b) {
    const A = cityIdx[a], B = cityIdx[b], m = { lat: (A.lat + B.lat) / 2, lon: (A.lon + B.lon) / 2 };
    let best = null, bd = Infinity;
    D.cities.forEach((c) => { if (c.city === a || c.city === b) return; const d = (c.lat - m.lat) ** 2 + (c.lon - m.lon) ** 2; if (d < bd) { bd = d; best = c.city; } });
    return bd < 6 ? best : null;
  }
  function newTrip(base) {
    const t = Object.assign({ id: "TRP" + String(S.extra.trips.length + 1).padStart(3, "0"), created: Date.now(), dur: DEMO_TRIP_MS[S.extra.speed] || DEMO_TRIP_MS.fast, rating: 0 }, base);
    if (!t.driver) { const d = driverByTruck[t.truck_id]; t.driver = d ? d.name : pick(DRIVERS) + " Singh"; t.driver_ok = d ? d.verification_status === "Verified" : false; }
    t.mid = midCity(t.origin, t.destination);
    S.extra.trips.unshift(t); saveStore(); refreshCounts(); renderTripList();
    return t;
  }
  function createShipperTrip(ctx, fee, adv, ref) {
    const { r } = ctx;
    S.extra.booked[r.L.listing_id] = true;
    const t = newTrip({ role: "shipper", company: ctx.sh ? ctx.sh.company : "Guest shipper", owner_id: r.O.owner_id, owner_name: r.O.name, phone: r.O.phone,
      truck_id: r.T.truck_id, reg_no: r.T.reg_no, truck_type: r.T.truck_type, start_city: r.L.current_city, deadhead: r.deadhead, origin: ctx.q.from, destination: ctx.q.to,
      distance_km: r.tripKm, weight: ctx.q.weight, pickup_date: ctx.q.date, is_return_trip: r.isRet, price: ctx.price, fee, advance: adv, upi: ref, broker: r.market, listing_id: r.L.listing_id });
    S.results = S.results.filter((x) => x.L.listing_id !== r.L.listing_id); S.compare.delete(r.L.listing_id);
    renderResults(); renderInsights();
    return t;
  }
  function progress(t) { return t.cancelled ? t.cancelled.p : clamp((Date.now() - t.created) / t.dur, 0, 1); }
  function tripState(t) {
    const p = progress(t), { cut, total } = phasesFor(t);
    const steps = [
      { at: 0, label: "Booking confirmed", note: t.role === "owner" ? `Accepted request from ${t.company}` : `Advance ${inr(t.advance || 0)} paid by UPI` },
      { at: cut[0], label: `Driver ${t.driver} assigned`, note: `${t.reg_no} · ${t.truck_type}` },
      { at: cut[1], label: `Reached pickup in ${t.origin}`, note: t.deadhead ? `Drove ${t.deadhead} km from ${t.start_city}` : "Truck was already in the city" },
      { at: cut[2], label: `Loaded and left ${t.origin}`, note: `${t.weight} t on board · e-way bill generated` },
    ];
    if (t.mid) steps.push({ at: cut[2] + (cut[3] - cut[2]) * 0.5, label: `Passed ${t.mid}`, note: "On schedule" });
    steps.push({ at: cut[3], label: `Reached ${t.destination}`, note: "Unloading" });
    steps.push({ at: 1, label: "Delivered", note: t.role === "owner" ? `Balance of ${inr(t.price - (t.advance || 0))} released to you` : "Proof of delivery uploaded" });
    let phase, label;
    if (t.cancelled) { phase = -1; label = `Cancelled · ${t.cancelled.reason}`; }
    else if (p >= 1) { phase = 5; label = "Delivered"; }
    else if (p >= cut[3]) { phase = 4; label = `Unloading in ${t.destination}`; }
    else if (p >= cut[2]) { phase = 3; label = `In transit · ${Math.round((p - cut[2]) / (cut[3] - cut[2]) * 100)}%`; }
    else if (p >= cut[1]) { phase = 2; label = `Loading in ${t.origin}`; }
    else if (p >= cut[0]) { phase = 1; label = t.deadhead ? `On the way to ${t.origin}` : `Reporting at ${t.origin}`; }
    else { phase = 0; label = "Assigning driver"; }
    // position
    const S0 = cityIdx[t.start_city], O = cityIdx[t.origin], De = cityIdx[t.destination];
    let pos, kmDone = 0;
    const lerp = (a, b, f) => ({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });
    if (p < cut[0]) pos = S0;
    else if (p < cut[1]) pos = lerp(S0, O, (p - cut[0]) / (cut[1] - cut[0]));
    else if (p < cut[2]) pos = O;
    else if (p < cut[3]) { const f = (p - cut[2]) / (cut[3] - cut[2]); pos = lerp(O, De, f); kmDone = Math.round(t.distance_km * f); }
    else { pos = De; kmDone = t.distance_km; }
    const clockStart = new Date(t.pickup_date + "T05:00:00Z").getTime() - (cut[1] * total) * 3600e3;
    const at = (f) => new Date(clockStart + f * total * 3600e3);
    const remainH = (1 - p) * total;
    return { p, phase, label, steps, pos, kmDone, at, remainH, eta: at(1), cut };
  }
  const fmtClock = (d) => d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  const fmtH = (h) => (h < 1 ? `${Math.round(h * 60)} min` : `${Math.floor(h)} h ${Math.round((h % 1) * 60)} min`);

  function initTrips() {
    $("#speed").value = S.extra.speed || "fast";
    $("#speed").addEventListener("change", (e) => { S.extra.speed = e.target.value; saveStore(); toast(`New trips will run at ${e.target.value === "fast" ? "fast" : "slow"} demo speed`); });
    $("#trip-list").addEventListener("click", (e) => {
      const b = e.target.closest("[data-trip]"); if (b) openTrip(b.dataset.trip);
      if (e.target.closest("#demo-trip")) startDemoTrip();
    });
    $("#trip-detail").addEventListener("click", onTripDetailClick);
    S.extra.trips.forEach((t) => (S.lastPhase[t.id] = tripState(t).phase));
    renderTripList(); renderTripDetail(); renderRecent();
  }
  function startDemoTrip() {
    const l = ranked[0] && ranked[0].l;
    if (!l) return;
    const R = matchTrucks({ from: l.origin, to: l.destination, date: l.pickup_date, weight: l.weight_tonnes, type: l.truck_type, verifiedOnly: true, sort: "score" });
    const r = R[0]; if (!r) return;
    const fee = Math.round(r.price * COMMISSION), adv = round100(r.price * ADVANCE);
    S.extra.booked[r.L.listing_id] = true;
    const t = newTrip({ role: "shipper", company: l.company, owner_id: r.O.owner_id, owner_name: r.O.name, phone: r.O.phone, truck_id: r.T.truck_id, reg_no: r.T.reg_no, truck_type: r.T.truck_type,
      start_city: r.L.current_city, deadhead: r.deadhead, origin: l.origin, destination: l.destination, distance_km: r.tripKm, weight: l.weight_tonnes, pickup_date: l.pickup_date,
      is_return_trip: r.isRet, price: r.price, fee, advance: adv, upi: "demo", broker: r.market, listing_id: r.L.listing_id });
    openTrip(t.id);
    if (S.query) runSearch();
  }
  function openTrip(id) { S.selTrip = id; show("trips"); renderTripList(); renderTripDetail(); }
  function renderTripList() {
    const T = S.extra.trips;
    if (!S.selTrip && T[0]) S.selTrip = T[0].id;
    $("#trip-list").innerHTML = T.length ? T.map((t) => {
      const st = tripState(t);
      return `<button type="button" class="trip-item${t.id === S.selTrip ? " on" : ""}" data-trip="${t.id}">
        <span class="ti-top"><span>${esc(t.origin)} → ${esc(t.destination)}</span><span class="status ${stCls(st)}" data-tstatus="${t.id}">${stTxt(st)}</span></span>
        <span class="ti-sub">${esc(t.reg_no)} · ${t.role === "owner" ? "for " + esc(t.company) : esc(t.owner_name)} · ${inr(t.price)}</span>
        <span class="bar"><i data-tbar="${t.id}" style="width:${Math.round(st.p * 100)}%"></i></span>
        <span class="ti-sub" data-tlabel="${t.id}">${esc(st.label)}</span></button>`;
    }).join("") : `<div class="empty">No trips yet. Book a truck to see it move here live.<div style="margin-top:12px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button class="btn primary small" type="button" data-go="find">Book a truck</button><button class="btn ghost small" id="demo-trip" type="button">Start a sample trip</button></div></div>`;
  }
  const stCls = (st) => (st.phase === -1 ? "bad" : st.phase === 5 ? "done" : "live");
  const stTxt = (st) => (st.phase === -1 ? "Cancelled" : st.phase === 5 ? "Delivered" : "Live");
  function renderTripDetail() {
    const t = S.extra.trips.find((x) => x.id === S.selTrip), el = $("#trip-detail");
    el.hidden = !S.extra.trips.length;
    if (!t) { el.innerHTML = `<div class="empty">Select a trip to track it.</div>`; return; }
    const st = tripState(t), W = 700, H = 320;
    const S0 = cityIdx[t.start_city], O = cityIdx[t.origin], De = cityIdx[t.destination];
    const M = makeMap([S0, O, De], W, H, 0.12);
    const [sx, sy] = M.px(S0.lat, S0.lon), [ox, oy] = M.px(O.lat, O.lon), [dx, dy] = M.px(De.lat, De.lon);
    el._map = M;
    el.innerHTML = `<div class="trip-top"><div><p class="eyebrow">${t.role === "owner" ? "Your truck · job for " + esc(t.company) : "Your shipment · " + esc(t.company)}</p>
        <h2 class="h2">${esc(t.origin)} → ${esc(t.destination)}</h2>
        <p class="muted small">${plate(t.reg_no)} ${esc(t.truck_type)} · driver ${esc(t.driver)}${t.driver_ok ? " ✓" : ""} · ${esc(t.phone || "")}${t.is_return_trip ? ` · <span class="tag gold">Return trip filled</span>` : ""}</p></div>
        <div style="display:flex;gap:8px;align-items:center"><span class="status live" id="d-status">${esc(st.label)}</span><button class="btn ghost small" id="share" type="button">Share tracking</button><button class="btn ghost small" id="cancel-trip" type="button"${st.p >= 1 || t.cancelled ? " hidden" : ""}>Cancel booking</button></div></div>
      <div class="trip-map"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Live position of truck ${esc(t.reg_no)}">${cityLayer(M, [t.origin, t.destination, t.start_city])}
        ${t.deadhead ? `<path class="m-deadhead" d="M${sx},${sy} L${ox},${oy}"/>` : ""}
        <path class="m-route" d="M${ox},${oy} L${dx},${dy}"/><path class="m-done" id="d-done" d="M${ox},${oy} L${ox},${oy}"/>
        <circle class="m-end" cx="${ox}" cy="${oy}" r="7"/><circle class="m-end" cx="${dx}" cy="${dy}" r="7"/>
        <g id="d-truck">${truckIcon(0, 0, "ret", t.reg_no)}</g></svg></div>
      <div class="trip-grid">
        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="trip-figs"><div><b id="d-pct">0%</b><span>trip complete</span></div><div><b id="d-km">0</b><span>of ${num(t.distance_km)} km</span></div><div><b id="d-eta">–</b><span>time left (trip time)</span></div></div>
          <div class="bill"><div><span>Agreed freight</span><span>${inr(t.price)}</span></div>${t.advance ? `<div><span>Advance paid${t.upi && t.upi !== "demo" ? " · UPI " + esc(t.upi) : ""}</span><span>${inr(t.advance)}</span></div>` : ""}
            <div><span>Saved vs broker</span><span style="color:var(--good)">${inr(Math.max(0, (t.broker || t.price) - t.price))}</span></div></div>
          <div id="d-rate"></div>
        </div>
        <ol class="timeline" id="d-timeline"></ol>
      </div>`;
    updateTripDetail(true);
  }
  function updateTripDetail(force) {
    const t = S.extra.trips.find((x) => x.id === S.selTrip), el = $("#trip-detail");
    if (!t || !$("#d-truck")) return;
    const st = tripState(t), M = el._map;
    const [x, y] = M.px(st.pos.lat, st.pos.lon), O = cityIdx[t.origin];
    const [ox, oy] = M.px(O.lat, O.lon);
    $("#d-truck").setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    $("#d-done").setAttribute("d", st.p >= st.cut[2] ? `M${ox},${oy} L${x.toFixed(1)},${y.toFixed(1)}` : `M${ox},${oy} L${ox},${oy}`);
    $("#d-pct").textContent = Math.round(st.p * 100) + "%";
    $("#d-km").textContent = num(st.kmDone);
    $("#d-eta").textContent = st.p >= 1 ? "Arrived" : fmtH(st.remainH);
    const ds = $("#d-status"); ds.textContent = st.label; ds.className = "status " + stCls(st);
    const cb = $("#cancel-trip"); if (cb) cb.hidden = st.p >= 1 || !!t.cancelled;
    const key = st.steps.filter((s) => st.p >= s.at).length;
    if (force || el._key !== key) {
      el._key = key;
      $("#d-timeline").innerHTML = st.steps.map((s, i) => `<li class="${st.p >= s.at ? (i === key - 1 && st.p < 1 ? "now" : "done") : ""}"><span><b>${esc(s.label)}</b><br><span class="small muted">${esc(s.note)}</span></span><time>${fmtClock(st.at(s.at))}</time></li>`).join("");
      renderRate(t, st);
    }
  }
  function renderRate(t, st) {
    const el = $("#d-rate"); if (!el) return;
    if (t.cancelled) { el.innerHTML = `<div class="notice error">Booking cancelled: ${esc(t.cancelled.reason)}. In the full product the advance would be refunded per the cancellation policy (proposed).</div>`; return; }
    if (st.p < 1) { el.innerHTML = `<p class="small muted">Simulated movement on a simulated clock, not GPS. ETA ${fmtClock(st.eta)}.</p>`; return; }
    if (t.role === "owner") { el.innerHTML = `<div class="success">✓ Delivered. ${inr(t.price - (t.advance || 0))} balance released to you.</div>`; return; }
    el.innerHTML = t.rating ? `<div class="success">✓ Delivered · you rated ${esc(t.owner_name)} ${"★".repeat(t.rating)}</div>`
      : `<div class="bill"><b>Rate ${esc(t.owner_name)}</b><div class="stars" role="group" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" aria-label="${n} star">★</button>`).join("")}</div></div>`;
  }
  function onTripDetailClick(e) {
    const s = e.target.closest("[data-star]");
    if (s) {
      const t = S.extra.trips.find((x) => x.id === S.selTrip); if (t.rating) return;
      t.rating = +s.dataset.star; (S.extra.ratings[t.owner_id] ||= []).push(t.rating); applyRatings(); saveStore();
      renderRate(t, tripState(t)); toast(`Thanks. ${esc(t.owner_name)}'s rating is now ★ ${ownerIdx[t.owner_id].rating.toFixed(1)}`); return;
    }
    if (e.target.closest("#cancel-trip")) { askCancel(S.extra.trips.find((x) => x.id === S.selTrip)); return; }
    if (e.target.closest("#share")) {
      const t = S.extra.trips.find((x) => x.id === S.selTrip);
      const text = `Track ${t.reg_no} (${t.origin} → ${t.destination}) on VahanConnect · trip ${t.id}`;
      const done = () => toast("Tracking details copied");
      try { navigator.clipboard.writeText(text).then(done, () => toast(esc(text))); } catch (err) { toast(esc(text)); }
    }
  }
  function askCancel(t) {
    const reasons = ["Plans changed", "Found another truck", "Pickup date changed", "Price issue", "Other"];
    openModal(`<h2 id="modal-title">Cancel this booking?</h2><p class="muted">${esc(t.origin)} → ${esc(t.destination)} · ${esc(t.reg_no)}</p>
      <div class="field" style="margin:12px 0"><label for="cx-reason">Reason</label><select id="cx-reason">${reasons.map((r) => `<option>${r}</option>`).join("")}</select></div>
      <div style="display:flex;gap:8px"><button class="btn danger" id="cx-yes" type="button">Cancel booking</button><button class="btn ghost" id="cx-no" type="button">Keep booking</button></div>`);
    $("#cx-no").addEventListener("click", closeModal);
    $("#cx-yes").addEventListener("click", () => {
      t.cancelled = { reason: $("#cx-reason").value, p: progress(t), at: Date.now() };
      if (t.listing_id) delete S.extra.booked[t.listing_id];
      saveStore(); closeModal(); renderTripList(); renderTripDetail(); refreshCounts(); renderInsights();
      if (S.query) runSearch();
      toast("Booking cancelled");
    });
  }
  function tick() {
    let changed = false;
    S.extra.trips.forEach((t) => {
      const st = tripState(t);
      const bar = $(`[data-tbar="${t.id}"]`); if (bar) bar.style.width = Math.round(st.p * 100) + "%";
      const lab = $(`[data-tlabel="${t.id}"]`); if (lab) lab.textContent = st.label;
      const sts = $(`[data-tstatus="${t.id}"]`); if (sts) { sts.textContent = st.phase === 5 ? "Delivered" : "Live"; sts.className = "status " + (st.phase === 5 ? "done" : "live"); }
      const prev = S.lastPhase[t.id];
      if (prev !== undefined && prev !== st.phase && st.phase > 0) {
        const msgs = { 1: `driver ${t.driver} assigned`, 2: `reached pickup in ${t.origin}`, 3: `loaded and left ${t.origin}`, 4: `reached ${t.destination}`, 5: `delivered in ${t.destination}` };
        toast(`<b>${esc(t.reg_no)}</b> ${esc(msgs[st.phase])}`, S.view !== "trips" || S.selTrip !== t.id ? { label: "Track", fn: () => openTrip(t.id) } : null);
        if (st.phase === 5) changed = true;
      }
      S.lastPhase[t.id] = st.phase;
    });
    if (S.view === "trips") updateTripDetail();
    if (changed) refreshCounts();
    if (S.view === "home") $$("#feed .t").forEach((el, i) => { const e = S.live.feed[i]; if (e) el.textContent = ago(e.ts); });
  }

  function renderRecent() {
    const recent = D.bookings.filter((b) => b.status === "Completed").slice(-12).reverse();
    $("#recent-table").innerHTML = `<thead><tr><th>ID</th><th>Date</th><th>Route</th><th>Goods</th><th>Truck</th><th class="num">Agreed</th><th class="num">Broker est.</th><th class="num">Saved</th><th>Return trip</th></tr></thead><tbody>${recent.map((b) => `<tr>
      <td>${b.booking_id}</td><td>${fmtDate(b.booking_date)}</td><td>${esc(b.origin)} → ${esc(b.destination)}</td><td>${esc(b.goods)}</td><td>${esc(b.truck_type)}</td>
      <td class="num">${inr(b.agreed_price_rs)}</td><td class="num">${inr(b.typical_broker_price_rs)}</td><td class="num">${Math.round((1 - b.agreed_price_rs / b.typical_broker_price_rs) * 100)}%</td><td>${b.is_return_trip ? "Yes" : "No"}</td></tr>`).join("")}</tbody>`;
  }

  // ================================================================ OWNER
  function initOwner() {
    const owners = D.owners.slice().sort((a, b) => a.name.localeCompare(b.name));
    $("#o-owner").innerHTML = owners.map((o) => opt(o.owner_id, `${o.name} · ${o.home_city} · ${o.verification_status}`)).join("");
    $("#o-city").innerHTML = cityOptions();
    let def = null, best = -1;
    for (const L of D.listings) {
      const O = ownerIdx[L.owner_id];
      if (!L.is_return_trip || O.verification_status !== "Verified") continue;
      const loads = loadsFor({ truck: truckIdx[L.truck_id], city: L.current_city, from: L.available_from, until: addDays(L.available_from, 3), home: O.home_city });
      const h = loads.filter((x) => x.home).length, sc = h ? h * 10 + loads.length : -1;
      if (sc > best) { best = sc; def = L; }
    }
    $("#o-owner").addEventListener("change", () => onOwnerChange());
    ["#o-truck", "#o-city", "#o-from", "#o-days", "#o-rate"].forEach((s) => $(s).addEventListener("change", renderOwnerLoads));
    $("#o-truck").addEventListener("change", setRateHint);
    $("#post-form").addEventListener("submit", (e) => { e.preventDefault(); postListing(); });
    $("#owner-loads").addEventListener("click", onQuote);
    $("#inbox").addEventListener("click", onInbox);
    $("#owner-card").addEventListener("click", (e) => { const v = e.target.closest("[data-verify]"); if (v) showVerification(v.dataset.verify); });
    if (def) { $("#o-owner").value = def.owner_id; onOwnerChange(def); } else onOwnerChange();
    renderInbox();
  }
  function curOwner() { return ownerIdx[$("#o-owner").value]; }
  function curTruck() { return truckIdx[$("#o-truck").value]; }
  function onOwnerChange(seed) {
    const O = curOwner();
    const trucks = D.trucks.filter((t) => t.owner_id === O.owner_id);
    $("#o-truck").innerHTML = trucks.map((t) => opt(t.truck_id, `${t.reg_no} · ${t.truck_type} · ${t.capacity_tonnes} t`)).join("");
    $("#o-pref").innerHTML = opt(O.home_city, `Back home to ${O.home_city}`) + opt("Any", "Any destination") + D.cities.map((c) => c.city).sort().filter((c) => c !== O.home_city).map((c) => opt(c)).join("");
    if (seed) { $("#o-truck").value = seed.truck_id; $("#o-city").value = seed.current_city; $("#o-from").value = seed.available_from; }
    else {
      const away = D.cities.map((c) => c.city).filter((c) => c !== O.home_city && cityIdx[c].state !== O.state);
      $("#o-city").value = away[(O.owner_id.charCodeAt(5) * 7) % away.length]; $("#o-from").value = minDate();
    }
    const docs = [["Driving licence", O.licence_verified], ["Vehicle RC", O.rc_verified], ["Identity", O.id_verified], ["GST number", O.gst_verified], ["Background check", O.background_check]];
    $("#owner-card").innerHTML = `<div class="who"><span class="avatar">${esc(initials(O.name))}</span><div><b>${esc(O.name)}</b><span>${esc(O.home_city)}, ${esc(O.state)} · ★ ${O.rating.toFixed(1)} · ${O.trips_completed} trips</span></div></div>
      <div>${verBadge(O)}</div>
      <div class="docs">${docs.map(([d, ok]) => `<div class="doc"><span class="${ok ? "ok" : "no"}">${ok ? "✓" : "✗"}</span>${d}</div>`).join("")}</div>
      ${O.verification_status !== "Verified" ? `<p class="small" style="color:var(--warn)">Shippers who filter for verified owners won't see this owner's trucks.</p>` : ""}`;
    setRateHint(); $("#post-msg").hidden = true; renderOwnerLoads(); renderInbox();
  }
  function setRateHint() {
    const T = curTruck(); if (!T) return;
    $("#o-rate").value = Math.round(T.rate_per_km * 0.8);
    $("#rate-hint").textContent = `Base rate ${T.rate_per_km} ₹/km · average for a ${T.truck_type}: ${Math.round(typeRate[T.truck_type])} ₹/km. On a return trip, asking 15–30% less still beats driving back empty.`;
  }
  function loadsFor({ truck, city, from, until, home }) {
    if (!truck) return [];
    return allLoads().map((l) => {
      if (l.truck_type !== truck.truck_type || l.weight_tonnes > truck.capacity_tonnes) return null;
      if (l.pickup_date < addDays(from, -1) || l.pickup_date > addDays(until, 1)) return null;
      const dh = km(city, l.origin);
      if (dh > MAX_DEADHEAD_KM) return null;
      const toHome = km(l.destination, home);
      return { l, dh, toHome, home: toHome <= 120 };
    }).filter(Boolean).sort((a, b) => (b.home - a.home) || a.toHome - b.toHome || a.dh - b.dh);
  }
  function renderOwnerLoads() {
    const O = curOwner(), T = curTruck();
    const from = $("#o-from").value || minDate(), days = parseInt($("#o-days").value || "3", 10), city = $("#o-city").value;
    const rate = parseInt($("#o-rate").value || (T && T.rate_per_km), 10);
    const list = loadsFor({ truck: T, city, from, until: addDays(from, days), home: O.home_city });
    const quoted = new Set(S.extra.requests.filter((r) => r.owner_id === O.owner_id).map((r) => r.load_id));
    const emptyHome = km(city, O.home_city);
    $("#loads-meta").textContent = `${list.length} near ${city}, ${fmtDate(from)} – ${fmtDate(addDays(from, days))}`;
    if (!list.length) { $("#owner-loads").innerHTML = `<div class="empty">No open loads for a ${esc(T ? T.truck_type : "truck")} within ${MAX_DEADHEAD_KM} km of ${esc(city)} on these dates. Post your truck anyway and shippers can request it.</div>`; return; }
    $("#owner-loads").innerHTML = list.slice(0, 10).map(({ l, dh, home }) => {
      const est = round100(l.distance_km * rate);
      const emptyCost = round100(emptyHome * EMPTY_RUN_COST_PER_KM);
      return `<div class="load${home ? " home" : ""}">
        <div><div class="l-route">${esc(l.origin)} → ${esc(l.destination)} ${home ? `<span class="tag gold">Takes you home</span>` : ""}${l.posted_here ? ` <span class="tag">Posted in this browser</span>` : ""}</div>
          <div class="l-meta">${esc(l.company)} · ${esc(l.goods)} · ${l.weight_tonnes} t · ${num(l.distance_km)} km · pickup ${fmtDate(l.pickup_date)}${dh ? ` · ${dh} km from you` : ""}</div>
          ${home ? `<div class="earn-box"><div class="pos"><b>${inr(est)}</b>you earn</div><div><b>${inr(emptyCost)}</b>cost of driving home empty</div><div class="pos"><b>${inr(est + emptyCost)}</b>better off</div></div>` : ""}</div>
        <div class="l-side"><span class="muted small">Quote at ${rate} ₹/km</span><b>${inr(est)}</b><span class="muted small">${l.budget_rs ? "Budget " + inr(l.budget_rs) : "No budget given"}</span>
          ${quoted.has(l.load_id) ? `<span class="tag good">Quote sent</span>` : `<button class="btn primary small" type="button" data-quote="${l.load_id}" data-est="${est}">Send quote</button>`}</div>
      </div>`;
    }).join("");
  }
  function onQuote(e) {
    const b = e.target.closest("[data-quote]"); if (!b) return;
    const l = allLoads().find((x) => x.load_id === b.dataset.quote), O = curOwner(), T = curTruck(), est = parseInt(b.dataset.est, 10);
    const rq = addRequest({ kind: "quote", status: "waiting", load: l, offer: est, owner: O, truck: T, city: $("#o-city").value, from: $("#o-from").value });
    renderOwnerLoads();
    toast(`Quote of ${inr(est)} sent to <b>${esc(l.company)}</b>`);
    setTimeout(() => {
      const r = S.extra.requests.find((x) => x.id === rq.id); if (!r || r.status !== "waiting") return;
      if (!l.budget_rs || est <= l.budget_rs) { r.status = "accepted-by-shipper"; r.note = `${l.company} accepted your quote`; }
      else { r.status = "new"; r.offer = l.budget_rs; r.note = `${l.company} countered at their budget of ${inr(l.budget_rs)}`; }
      saveStore(); renderInbox(); refreshCounts();
      toast(`<b>${esc(l.company)}</b> ${r.status === "new" ? "sent a counter-offer" : "accepted your quote"}`, S.view !== "owner" ? { label: "View", fn: () => show("owner") } : null);
    }, 4500 + Math.random() * 2500);
  }
  function addRequest({ kind, status, load, offer, owner, truck, city, from, note }) {
    const r = { id: "REQ" + Date.now().toString(36) + Math.floor(Math.random() * 99), kind, status, created: Date.now(), owner_id: owner.owner_id, truck_id: truck.truck_id,
      load_id: load.load_id, company: load.company, goods: load.goods, origin: load.origin, destination: load.destination, distance_km: load.distance_km || km(load.origin, load.destination),
      weight: load.weight_tonnes, pickup_date: load.pickup_date || from, start_city: city, offer, note: note || "" };
    S.extra.requests.unshift(r); saveStore(); renderInbox(); refreshCounts();
    return r;
  }
  function liveRequest(source) {
    // simulated shipper request for the current owner's truck
    const O = curOwner(), T = curTruck(); if (!O || !T) return;
    const city = $("#o-city").value, from = $("#o-from").value || minDate();
    const pool = loadsFor({ truck: T, city, from, until: addDays(from, parseInt($("#o-days").value || "3", 10)), home: O.home_city })
      .filter((x) => !S.extra.requests.some((r) => r.load_id === x.l.load_id));
    let load;
    if (pool.length) load = pool[0].l;
    else {
      const sh = pick(D.shippers), dest = $("#o-pref").value !== "Any" ? $("#o-pref").value : pick(D.cities.filter((c) => c.city !== city)).city;
      load = { load_id: "LDX" + Math.floor(Math.random() * 9999), company: sh.company, goods: "General cargo", origin: city, destination: dest, distance_km: km(city, dest), weight_tonnes: Math.max(1, Math.round(T.capacity_tonnes * 0.7)), pickup_date: from };
    }
    const rate = parseInt($("#o-rate").value || T.rate_per_km, 10);
    const offer = round100((load.distance_km || km(load.origin, load.destination)) * rate * (0.92 + Math.random() * 0.06));
    addRequest({ kind: "request", status: "new", load, offer, owner: O, truck: T, city, from, note: source === "post" ? "Saw your new listing" : "Found your truck in search" });
    toast(`<b>New booking request</b> from ${esc(load.company)}: ${esc(load.origin)} → ${esc(load.destination)}, ${inr(offer)}`, S.view !== "owner" ? { label: "View", fn: () => show("owner") } : null);
  }
  function renderInbox() {
    const O = curOwner(); if (!O) return;
    const mine = S.extra.requests.filter((r) => r.owner_id === O.owner_id && r.status !== "declined");
    $("#inbox-meta").textContent = mine.length ? `${mine.filter((r) => r.status === "new" || r.status === "accepted-by-shipper").length} waiting for you` : "";
    $("#inbox").innerHTML = mine.length ? mine.map((r) => {
      const T = truckIdx[r.truck_id];
      let act;
      if (r.status === "new") act = `<button class="btn primary small" data-acc="${r.id}" type="button">Accept ${inr(r.offer)}</button><button class="btn ghost small" data-ctr="${r.id}" type="button">Counter +5%</button><button class="btn ghost small" data-dec="${r.id}" type="button">Decline</button>`;
      else if (r.status === "accepted-by-shipper") act = `<button class="btn primary small" data-acc="${r.id}" type="button">Confirm job</button>`;
      else if (r.status === "waiting") act = `<span class="status wait">Waiting for shipper…</span>`;
      else if (r.status === "countering") act = `<span class="status wait">Shipper is replying…</span>`;
      else act = `<button class="btn ghost small" data-trackreq="${r.trip}" type="button">Track trip</button>`;
      return `<div class="req${Date.now() - r.created < 4000 ? " new" : ""}"><div><div class="r-route">${esc(r.origin)} → ${esc(r.destination)}</div>
        <div class="r-meta">${esc(r.company)} · ${esc(r.goods)} · ${r.weight} t · ${num(r.distance_km)} km · ${fmtDate(r.pickup_date)} · ${esc(T ? T.reg_no : "")}</div>
        <div class="r-meta">${r.note ? esc(r.note) + " · " : ""}<b style="color:var(--fg)">${inr(r.offer)}</b></div></div><div class="r-act">${act}</div></div>`;
    }).join("") : `<div class="empty">No requests yet. Post your truck or send a quote; shippers' requests appear here live.</div>`;
    if ($("#o-truck").value) renderOwnerLoads();
  }
  async function onInbox(e) {
    const b = e.target.closest("button"); if (!b) return;
    const id = b.dataset.acc || b.dataset.ctr || b.dataset.dec;
    if (b.dataset.trackreq) { openTrip(b.dataset.trackreq); return; }
    const r = S.extra.requests.find((x) => x.id === id); if (!r) return;
    if (b.dataset.dec) { r.status = "declined"; saveStore(); renderInbox(); refreshCounts(); return; }
    if (b.dataset.ctr) {
      r.status = "countering"; saveStore(); renderInbox(); refreshCounts();
      await wait(2200);
      const counter = round100(r.offer * 1.05);
      if (Math.random() < 0.65) { r.offer = counter; r.status = "accepted-by-shipper"; r.note = `${r.company} accepted your counter`; }
      else { r.offer = round100(r.offer * 1.025); r.status = "new"; r.note = `${r.company} met you halfway`; }
      saveStore(); renderInbox(); refreshCounts(); toast(`<b>${esc(r.company)}</b> replied to your counter-offer`);
      return;
    }
    if (b.dataset.acc) {
      const O = ownerIdx[r.owner_id], T = truckIdx[r.truck_id];
      const t = newTrip({ role: "owner", company: r.company, owner_id: O.owner_id, owner_name: O.name, phone: "Shipper: +91 98XXX XX" + Math.floor(10 + Math.random() * 89), truck_id: T.truck_id, reg_no: T.reg_no, truck_type: T.truck_type,
        start_city: r.start_city, deadhead: km(r.start_city, r.origin), origin: r.origin, destination: r.destination, distance_km: r.distance_km, weight: r.weight, pickup_date: r.pickup_date,
        is_return_trip: km(r.destination, O.home_city) <= 120, price: r.offer, fee: 0, advance: round100(r.offer * ADVANCE), broker: round100(r.distance_km * (typeRate[T.truck_type] || T.rate_per_km) * BROKER_MARKUP) });
      r.status = "booked"; r.trip = t.id; saveStore(); renderInbox(); refreshCounts(); renderInsights();
      toast(`<b>Job confirmed.</b> ${esc(r.company)} paid a ${inr(t.advance)} advance.`, { label: "Track", fn: () => openTrip(t.id) });
    }
  }
  function postListing() {
    const O = curOwner(), T = curTruck();
    const from = $("#o-from").value, days = parseInt($("#o-days").value, 10), city = $("#o-city").value, pref = $("#o-pref").value;
    const L = { listing_id: `LSTU${String(S.extra.listings.length + 1).padStart(3, "0")}`, truck_id: T.truck_id, owner_id: O.owner_id, current_city: city, preferred_destination: pref,
      home_city: O.home_city, is_return_trip: city !== O.home_city && pref === O.home_city, available_from: from, available_until: addDays(from, days), asking_rate_per_km: parseInt($("#o-rate").value, 10), status: "Open" };
    S.extra.listings.push(L); saveStore();
    const msg = $("#post-msg"); msg.hidden = false;
    msg.innerHTML = `Posted ${esc(T.reg_no)}: free in ${esc(city)} from ${fmtDate(from)}${L.is_return_trip ? `, heading home to ${esc(O.home_city)}` : ""}. Shippers can now find it. <a href="#find" id="try-it">See it as a shipper</a>`;
    $("#try-it").addEventListener("click", (e) => {
      e.preventDefault();
      $("#q-from").value = city; $("#q-to").value = pref === "Any" ? (city === "Delhi" ? "Mumbai" : "Delhi") : pref;
      $("#q-date").value = from; $("#q-type").value = T.truck_type; $("#q-weight").value = Math.max(1, Math.round(T.capacity_tonnes * 0.7));
      $("#q-verified").checked = O.verification_status === "Verified"; $$(".chip").forEach((c) => c.classList.remove("on"));
      show("find"); runSearch({ animate: true });
    });
    setTimeout(() => liveRequest("post"), 5000 + Math.random() * 3000);
    renderDataset();
  }
  function minDate() { return D.listings.reduce((m, l) => (l.available_from < m ? l.available_from : m), "9999"); }

  // ================================================================ INSIGHTS
  function renderInsights() {
    const mine = S.extra.trips.filter((t) => t.role === "shipper").map((t) => ({ booking_date: iso(new Date(t.created)), origin: t.origin, destination: t.destination, truck_type: t.truck_type, agreed_price_rs: t.price, typical_broker_price_rs: t.broker || t.price, is_return_trip: t.is_return_trip, empty_km_avoided: t.is_return_trip ? t.distance_km : 0 }));
    const done = D.bookings.filter((b) => b.status === "Completed").concat(mine);
    const gmv = done.reduce((a, b) => a + b.agreed_price_rs, 0), broker = done.reduce((a, b) => a + b.typical_broker_price_rs, 0);
    const ret = done.filter((b) => b.is_return_trip), emptyKm = done.reduce((a, b) => a + (b.empty_km_avoided || 0), 0);
    const verified = D.owners.filter((o) => o.verification_status === "Verified").length;
    const openListings = allListings().filter((l) => !isBooked(l.listing_id)).length;
    $("#insights-lede").textContent = `Computed live from ${num(D.bookings.length)} past bookings, ${num(openListings)} open truck listings and ${num(D.loads.length)} open loads${mine.length ? `, plus ${mine.length} booking${mine.length > 1 ? "s" : ""} made in this demo` : ""}.`;
    const k = [
      ["Completed bookings", num(done.length), "Apr – Oct 2026"], ["Freight value booked", "₹" + num(gmv / 1e5, 1) + " L", "Sum of agreed prices"],
      ["Platform revenue", "₹" + num(gmv * COMMISSION / 1e5, 2) + " L", `At an assumed ${COMMISSION * 100}% commission`], ["Saved vs brokers", Math.round((1 - gmv / broker) * 100) + "%", inr(broker - gmv) + " in total"],
      ["Return trips filled", Math.round(ret.length / done.length * 100) + "%", `${num(ret.length)} trucks didn't drive back empty`], ["Empty km avoided", num(emptyKm / 1000) + "k km", `≈ ${num(emptyKm / 4 / 1000)}k litres of diesel at 4 km/l`],
      ["Verified owners", `${verified} / ${D.owners.length}`, `${Math.round(verified / D.owners.length * 100)}% passed all five checks`], ["Open listings", num(openListings), `${num(D.trucks.length)} trucks in the network`],
    ];
    $("#kpis").innerHTML = k.map(([l, v, s]) => `<div class="kpi"><span class="k-label">${l}</span><span class="k-val">${v}</span><span class="k-sub">${s}</span></div>`).join("");

    const months = {};
    done.forEach((b) => { const m = b.booking_date.slice(0, 7); (months[m] ||= { all: 0, ret: 0 }); months[m].all++; if (b.is_return_trip) months[m].ret++; });
    const keys = Object.keys(months).sort();
    const W = 560, H = 230, pad = { l: 34, r: 8, t: 14, b: 26 }, max = Math.ceil(Math.max(...keys.map((x) => months[x].all)) / 20) * 20;
    const bw = (W - pad.l - pad.r) / keys.length, y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Completed bookings per month">`;
    for (let g = 0; g <= max; g += max / 4) svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(g)}" y2="${y(g)}" stroke="var(--line)"/><text x="${pad.l - 6}" y="${y(g) + 4}" text-anchor="end">${g}</text>`;
    keys.forEach((m, i) => {
      const x = pad.l + i * bw + bw * 0.18, w = bw * 0.64, v = months[m];
      svg += `<rect x="${x}" y="${y(v.all)}" width="${w}" height="${y(0) - y(v.all)}" fill="var(--navy)" rx="2"><title>${v.all} bookings</title></rect><rect x="${x}" y="${y(v.ret)}" width="${w}" height="${y(0) - y(v.ret)}" fill="var(--gold)" rx="2"><title>${v.ret} return trips</title></rect>`;
      svg += `<text x="${x + w / 2}" y="${y(v.all) - 4}" text-anchor="middle" style="fill:var(--fg);font-weight:600">${v.all}</text><text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${new Date(m + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" })}</text>`;
    });
    $("#chart-months").innerHTML = `<div class="chart-legend"><span><i style="background:var(--navy)"></i>All bookings</span><span><i style="background:var(--gold)"></i>Of which return trips</span></div>${svg}</svg>`;

    const corr = {};
    done.forEach((b) => { const k2 = [b.origin, b.destination].sort().join(" ⇄ "); corr[k2] = (corr[k2] || 0) + 1; });
    const topR = Object.entries(corr).sort((a, b) => b[1] - a[1]).slice(0, 8);
    $("#top-routes").innerHTML = hbars(topR.map(([k2, v]) => [k2, v, v + " trips"]), topR[0][1]);

    const pairs = {};
    done.forEach((b) => { const k2 = [b.origin, b.destination].sort().join("|"); pairs[k2] = (pairs[k2] || 0) + 1; });
    const NW = 420, NH = 470, M = makeMap(D.cities, NW, NH, 0.04), pmax = Math.max(...Object.values(pairs));
    let n = `<svg viewBox="0 0 ${NW} ${NH}" role="img" aria-label="Map of booked routes between cities">`;
    Object.entries(pairs).sort((a, b) => a[1] - b[1]).forEach(([k2, v]) => {
      const [a, b] = k2.split("|").map((c) => M.px(cityIdx[c].lat, cityIdx[c].lon));
      n += `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="var(--gold)" stroke-opacity="${(0.12 + 0.6 * v / pmax).toFixed(2)}" stroke-width="${(0.6 + 3 * v / pmax).toFixed(1)}"/>`;
    });
    const dmax = Math.max(...Object.values(cityDeg));
    D.cities.forEach((c) => { const [x, y2] = M.px(c.lat, c.lon); n += `<circle cx="${x.toFixed(1)}" cy="${y2.toFixed(1)}" r="${(2.5 + 5 * Math.sqrt((cityDeg[c.city] || 0) / dmax)).toFixed(1)}" fill="var(--navy)" stroke="var(--surface)" stroke-width="1.2"><title>${c.city}: ${cityDeg[c.city] || 0} bookings</title></circle>`; });
    n += cityLayer(M, []).replace(/<circle[^>]*\/>/g, "");
    $("#network").innerHTML = n + "</svg>";

    const sup = {}, dem = {};
    allListings().filter((l) => !isBooked(l.listing_id)).forEach((l) => (sup[l.current_city] = (sup[l.current_city] || 0) + 1));
    D.loads.forEach((l) => (dem[l.origin] = (dem[l.origin] || 0) + 1));
    const cities = Object.keys({ ...sup, ...dem }).sort((a, b) => (sup[b] || 0) + (dem[b] || 0) - (sup[a] || 0) - (dem[a] || 0)).slice(0, 9);
    const sdMax = Math.max(...cities.map((c) => Math.max(sup[c] || 0, dem[c] || 0)));
    $("#supply-demand").innerHTML = `<div class="chart-legend"><span><i style="background:var(--navy)"></i>Open trucks</span><span><i style="background:var(--gold)"></i>Open loads</span></div><div class="hbars">${cities.map((c) =>
      `<div class="hbar"><span class="lab">${c}</span><span style="display:flex;flex-direction:column;gap:3px"><span class="trk"><i style="width:${(sup[c] || 0) / sdMax * 100}%"></i></span><span class="trk"><i class="alt" style="width:${(dem[c] || 0) / sdMax * 100}%"></i></span></span><span class="val">${sup[c] || 0} / ${dem[c] || 0}</span></div>`).join("")}</div>`;

    const tm = {};
    done.forEach((b) => (tm[b.truck_type] = (tm[b.truck_type] || 0) + 1));
    const tms = Object.entries(tm).sort((a, b) => b[1] - a[1]);
    $("#type-mix").innerHTML = hbars(tms.map(([k2, v]) => [k2, v, Math.round(v / done.length * 100) + "%"]), tms[0][1]);

    const checks = [["Driving licence", "licence_verified"], ["Vehicle RC", "rc_verified"], ["Identity", "id_verified"], ["GST number", "gst_verified"], ["Background check", "background_check"]];
    const st = { Verified: 0, Pending: 0, Rejected: 0 };
    D.owners.forEach((o) => st[o.verification_status]++);
    $("#verification").innerHTML = `<div class="tags" style="margin-bottom:12px"><span class="tag good">${st.Verified} verified</span><span class="tag warn">${st.Pending} pending</span><span class="tag bad">${st.Rejected} rejected</span></div>` +
      hbars(checks.map(([l, f]) => { const v = D.owners.filter((o) => o[f]).length; return [l, v, Math.round(v / D.owners.length * 100) + "%"]; }), D.owners.length);
  }
  function hbars(rows, max) {
    return `<div class="hbars">${rows.map(([l, v, label]) => `<div class="hbar"><span class="lab" title="${esc(l)}">${esc(l)}</span><span class="trk"><i style="width:${v / max * 100}%"></i></span><span class="val">${label}</span></div>`).join("")}</div>`;
  }

  // ================================================================ DATASET
  function initDataset() {
    $("#ds-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-table]"); if (!b) return; S.ds = { table: b.dataset.table, page: 0, filter: "" }; $("#ds-search").value = ""; renderDataset(); });
    $("#ds-search").addEventListener("input", (e) => { S.ds.filter = e.target.value.toLowerCase(); S.ds.page = 0; renderDataset(); });
    $("#ds-prev").addEventListener("click", () => { S.ds.page = Math.max(0, S.ds.page - 1); renderDataset(); });
    $("#ds-next").addEventListener("click", () => { S.ds.page++; renderDataset(); });
    renderDataset();
  }
  function renderDataset() {
    const t = S.ds.table, PER = 15, data = t === "listings" ? allListings() : t === "loads" ? allLoads() : D[t];
    $("#ds-tabs").innerHTML = TABLES.map((n) => `<button role="tab" data-table="${n}" aria-selected="${n === t}">${n}.csv<span>${num((n === "listings" ? allListings() : n === "loads" ? allLoads() : D[n]).length)}</span></button>`).join("");
    const rows = S.ds.filter ? data.filter((r) => Object.values(r).join(" ").toLowerCase().includes(S.ds.filter)) : data;
    const pages = Math.max(1, Math.ceil(rows.length / PER)); S.ds.page = Math.min(S.ds.page, pages - 1);
    const cols = Object.keys(data[0]);
    $("#ds-title").textContent = `${t}.csv`;
    $("#ds-desc").textContent = `${TABLE_DESC[t]} ${num(data.length)} rows · ${cols.length} columns${t === "listings" && S.extra.listings.length ? ` (incl. ${S.extra.listings.length} you posted)` : ""}.`;
    $("#ds-open").href = `data/${t}.csv`;
    const slice = rows.slice(S.ds.page * PER, S.ds.page * PER + PER);
    $("#ds-table").innerHTML = `<thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${slice.map((r) => `<tr>${cols.map((c) => `<td${typeof r[c] === "number" ? ' class="num"' : ""}>${esc(r[c])}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${cols.length}">No rows match.</td></tr>`}</tbody>`;
    $("#ds-page").textContent = `Page ${S.ds.page + 1} of ${pages} · ${num(rows.length)} rows`;
    $("#ds-prev").disabled = S.ds.page === 0; $("#ds-next").disabled = S.ds.page >= pages - 1;
  }

  // ================================================================ HOME booking form
  function initHomeForm() {
    $("#h-from").innerHTML = cityOptions(); $("#h-to").innerHTML = cityOptions();
    $("#h-from").value = $("#q-from").value; $("#h-to").value = $("#q-to").value;
    $("#h-date").value = $("#q-date").value; $("#h-weight").value = $("#q-weight").value;
    $("#home-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const w = parseFloat($("#h-weight").value);
      if ($("#h-from").value === $("#h-to").value) { toast(T_("err.sameCity")); $("#h-to").focus(); return; }
      if (!$("#h-date").value) { toast(T_("err.date")); $("#h-date").focus(); return; }
      if (!(w > 0) || w > 40) { toast(T_("err.weight")); $("#h-weight").focus(); return; }
      $("#q-from").value = $("#h-from").value; $("#q-to").value = $("#h-to").value; $("#q-date").value = $("#h-date").value; $("#q-weight").value = w; $("#q-type").value = "";
      S.qExtra = {}; $$(".chip").forEach((c) => c.classList.remove("on"));
      show("find"); runSearch({ animate: true });
    });
    $("#u-sticky-btn").addEventListener("click", () => { const f = $("#home-form"); f.scrollIntoView({ behavior: "smooth", block: "center" }); setTimeout(() => f.requestSubmit(), 350); });
    // banner fact computed from the dataset: return-trip asking rate vs the truck's base rate
    const ret = D.listings.filter((l) => l.is_return_trip && truckIdx[l.truck_id]);
    S.retDiscount = Math.round((1 - ret.reduce((a, l) => a + l.asking_rate_per_km / truckIdx[l.truck_id].rate_per_km, 0) / ret.length) * 100);
    renderBanner();
    let hidden = false; try { hidden = sessionStorage.getItem("vc-banner") === "0"; } catch (e) { /* ignore */ }
    $("#u-banner").hidden = hidden;
    $("#u-banner-x").addEventListener("click", () => { $("#u-banner").hidden = true; try { sessionStorage.setItem("vc-banner", "0"); } catch (e) { /* ignore */ } });
    const io = "IntersectionObserver" in window ? new IntersectionObserver(([en]) => document.body.classList.toggle("form-visible", en.isIntersecting)) : null;
    if (io) io.observe($("#home-form"));
  }
  function renderBanner() { if (S.retDiscount != null) $("#u-banner-text").textContent = T_("home.banner").replace("{p}", S.retDiscount); }

  // ================================================================ POST A LOAD
  function initPost() {
    const types = [...new Set(D.trucks.map((t) => t.truck_type))].sort();
    $("#p-from").innerHTML = cityOptions(); $("#p-to").innerHTML = cityOptions("Delhi");
    $("#p-type").innerHTML = types.map((t) => opt(t)).join("");
    $("#p-shipper").innerHTML = D.shippers.slice().sort((a, b) => a.company.localeCompare(b.company)).map((s2) => opt(s2.shipper_id, `${s2.company} (${s2.city})`)).join("");
    const syncCity = () => { const sh = shipperIdx[$("#p-shipper").value]; if (sh) $("#p-from").value = sh.city; };
    $("#p-shipper").addEventListener("change", syncCity); syncCity();
    $("#p-date").value = minDate(); $("#p-date").min = iso(new Date());
    $("#load-form").addEventListener("submit", (e) => { e.preventDefault(); const l = validateLoad(); if (l) reviewLoad(l); });
  }
  function validateLoad() {
    const f = { from: $("#p-from").value, to: $("#p-to").value, date: $("#p-date").value, weight: parseFloat($("#p-weight").value), type: $("#p-type").value,
      goods: $("#p-goods").value.trim(), handling: $("#p-handling").value.trim(), budget: $("#p-budget").value ? parseFloat($("#p-budget").value) : 0, shipper: $("#p-shipper").value };
    const maxCap = Math.max(...D.trucks.filter((t) => t.truck_type === f.type).map((t) => t.capacity_tonnes));
    const errs = {};
    if (f.from === f.to) errs.to = T_("err.sameCity");
    if (!f.date) errs.date = T_("err.date"); else if (f.date < iso(new Date())) errs.date = T_("err.past");
    if (!(f.weight > 0)) errs.weight = T_("err.weight"); else if (f.weight > maxCap) errs.weight = T_("err.cap").replace("{n}", maxCap).replace("{t}", f.type);
    if (!f.goods) errs.goods = T_("err.goods");
    if (f.budget < 0) errs.budget = T_("err.budget");
    ["from", "to", "date", "weight", "goods", "budget"].forEach((k) => { const el = $("#e-" + k); if (el) el.textContent = errs[k] || ""; const inp = $("#p-" + k); if (inp) inp.setAttribute("aria-invalid", errs[k] ? "true" : "false"); });
    const first = Object.keys(errs)[0]; if (first) { ($("#p-" + first) || $("#p-to")).focus(); return null; }
    return f;
  }
  function reviewLoad(f) {
    const sh = shipperIdx[f.shipper], dist = km(f.from, f.to);
    $("#post-out").innerHTML = `<p class="eyebrow">${T_("post.reviewH")}</p><h2 class="h2">${esc(f.from)} → ${esc(f.to)}</h2>
      <dl class="kv"><div><dt>${T_("post.company")}</dt><dd>${esc(sh.company)}</dd></div><div><dt>${T_("f.date")}</dt><dd>${fmtDate(f.date)}</dd></div>
      <div><dt>${T_("f.weight")}</dt><dd>${f.weight} t · ${esc(f.type)}</dd></div><div><dt>Distance</dt><dd>${num(dist)} km (estimate)</dd></div>
      <div><dt>${T_("post.goods")}</dt><dd>${esc(f.goods)}</dd></div><div><dt>${T_("post.budget")}</dt><dd>${f.budget ? inr(f.budget) : "–"}</dd></div>
      ${f.handling ? `<div><dt>${T_("post.handling")}</dt><dd>${esc(f.handling)}</dd></div>` : ""}</dl>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary lg" id="post-confirm" type="button">${T_("post.publish")}</button><button class="btn ghost lg" id="post-edit" type="button">${T_("edit")}</button></div>`;
    $("#post-edit").addEventListener("click", () => $("#p-goods").focus());
    $("#post-confirm").addEventListener("click", () => publishLoad(f));
    $("#post-out").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function publishLoad(f) {
    const sh = shipperIdx[f.shipper], n = (S.extra.loads || []).length + 1;
    const l = { load_id: "LDU" + String(n).padStart(3, "0"), shipper_id: sh.shipper_id, company: sh.company, goods: f.goods, origin: f.from, destination: f.to,
      distance_km: km(f.from, f.to), weight_tonnes: f.weight, truck_type: f.type, pickup_date: f.date, budget_rs: f.budget || "", status: "Open", handling: f.handling, posted_here: true };
    (S.extra.loads ||= []).push(l); saveStore(); renderDataset();
    const R = matchTrucks({ from: l.origin, to: l.destination, date: l.pickup_date, weight: l.weight_tonnes, type: l.truck_type, verifiedOnly: true, sort: "score" });
    $("#post-out").innerHTML = `<div class="success">✓ ${T_("post.done")} · ${esc(l.load_id)}</div>
      <h2 class="h2" style="margin-top:12px">${esc(l.origin)} → ${esc(l.destination)}</h2><p class="muted">${fmtDate(l.pickup_date)} · ${l.weight_tonnes} t · ${esc(l.truck_type)} · ${esc(l.goods)}</p>
      <p style="margin:12px 0">${R.length ? `<b>${R.length}</b> ${T_("post.matches")}` : T_("post.none")}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${R.length ? `<button class="btn primary" id="post-see" type="button">${T_("post.see")}</button>` : ""}<button class="btn ghost" type="button" data-go="owner">${T_("post.asOwner")}</button></div>
      <p class="muted small" style="margin-top:12px">${T_("post.note")}</p>`;
    const see = $("#post-see");
    if (see) see.addEventListener("click", () => { applyLoad(l, false); show("find"); runSearch({ animate: true }); });
    toast(`${T_("post.done")}: ${esc(l.origin)} → ${esc(l.destination)}`);
  }

  // ================================================================ simulation transparency
  function initSim() {
    try { if (localStorage.getItem("vc-sim") === "1") document.body.classList.add("sim-on"); } catch (e) { /* ignore */ }
    document.addEventListener("click", (e) => { if (e.target.closest("[data-sim-open], #sim-pill")) openSim(); });
  }
  function openSim() {
    const items = [["Dataset and listings", "All owners, trucks, loads and bookings are synthetic (generated by scripts/generate_dataset.py)."], ["Activity feed", "Generated in your browser from the dataset."],
      ["Owner and shipper replies", "Negotiation messages, requests and counter-offers are scripted."], ["Advance payment", "The UPI step is simulated. No money moves."],
      ["Tracking", "Truck movement and times run on a simulated clock, not GPS."], ["Verification", "Owner and driver checks are flags in the data, not real document checks."],
      ["Sponsored slot", "A fictional partner, not a real advertisement."], ["Storage", "Bookings, posted loads and trucks are saved only in this browser."]];
    const on = document.body.classList.contains("sim-on");
    openModal(`<h2 id="modal-title">Simulation mode</h2><p class="muted">What works here is real front-end logic: matching, pricing, suggestions and insights are computed from the dataset. These parts are simulated:</p>
      <ul class="sim-list">${items.map(([a, b]) => `<li><b>${a}</b><span>${b}</span></li>`).join("")}</ul>
      <label class="check" style="margin-top:12px"><input type="checkbox" id="sim-toggle"${on ? " checked" : ""}> Highlight simulated areas on screen</label>`);
    $("#sim-toggle").addEventListener("change", (e) => { document.body.classList.toggle("sim-on", e.target.checked); try { localStorage.setItem("vc-sim", e.target.checked ? "1" : "0"); } catch (err) { /* ignore */ } });
  }
  function openMore() {
    openModal(`<h2 id="modal-title">${T_("nav.more")}</h2><div class="more-menu">
      <button type="button" class="service" data-go="owner"><b>${T_("nav.owner")}</b><i aria-hidden="true">→</i></button>
      <button type="button" class="service" data-go="insights"><b>${T_("nav.insights")}</b><i aria-hidden="true">→</i></button>
      <button type="button" class="service" data-go="dataset"><b>${T_("nav.dataset")}</b><i aria-hidden="true">→</i></button>
      <button type="button" class="service" data-sim-open><b>${T_("demo")}: what is simulated?</b><i aria-hidden="true">→</i></button></div>`);
  }

  // ================================================================ modal, counts, routing
  let lastFocus = null;
  function openModal(html) { if ($("#modal").hidden) lastFocus = document.activeElement; $("#modal-body").innerHTML = html; $("#modal").hidden = false; setTimeout(() => $("#modal-x").focus(), 0); }
  function closeModal() { if ($("#modal").hidden) return; $("#modal").hidden = true; const nb = $("#modal-body").cloneNode(false); $("#modal-body").replaceWith(nb); if (lastFocus && document.contains(lastFocus)) lastFocus.focus(); }
  function trapFocus(e) {
    if (e.key !== "Tab" || $("#modal").hidden) return;
    const f = $$("#modal button, #modal select, #modal input, #modal [href]").filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return; const a = f[0], z = f[f.length - 1];
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  }
  // ---------------- language + theme
  function applyLang(lang) {
    LANG = I18N[lang] ? lang : "en"; document.documentElement.lang = LANG === "hi" ? "hi" : "en";
    try { localStorage.setItem("vc-lang", LANG); } catch (e) { /* ignore */ }
    $$("[data-i18n]").forEach((el) => (el.textContent = T_(el.dataset.i18n)));
    renderBanner();
    $("#lang").value = LANG;
    if (S.query && $("#scan").hidden && $("#results-head") && !$("#results-head").hidden) renderResults();
  }
  const THEMES = ["system", "light", "dark"];
  function applyTheme(t) {
    if (t === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
    $("#theme-btn").setAttribute("aria-label", "Theme: " + t); $("#theme-btn").title = "Theme: " + t + " (click to change)";
    try { localStorage.setItem("vc-theme", t); } catch (e) { /* ignore */ }
    S.theme = t;
  }
  function refreshCounts() {
    const live = S.extra.trips.filter((t) => !t.cancelled && progress(t) < 1).length;
    const req = S.extra.requests.filter((r) => r.status === "new" || r.status === "accepted-by-shipper").length;
    [["#trip-count", live], ["#trip-count-m", live], ["#req-count", req], ["#req-count-m", req]].forEach(([s, n]) => { const el = $(s); el.hidden = !n; el.textContent = n; });
  }
  const VIEWS = ["home", "find", "post", "trips", "owner", "insights", "dataset"];
  function show(v) {
    if (!VIEWS.includes(v)) v = "home";
    S.view = v; closeModal();
    VIEWS.forEach((x) => { $("#view-" + x).hidden = x !== v; });
    $$("[data-view]").forEach((b) => (b.dataset.view === v ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
    try { if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v); } catch (e) { /* ignore */ }
    if (v === "trips") renderTripDetail();
    if (v === "find" && S.query && $("#scan").hidden) requestAnimationFrame(drawResultMap);
    if (v === "owner" && !S.ownerSeeded && !S.extra.requests.some((r) => r.owner_id === curOwner().owner_id)) { S.ownerSeeded = true; setTimeout(() => S.view === "owner" && liveRequest("search"), 6000); }
    window.scrollTo({ top: 0 });
  }
  function initReset() {
    $("#reset-demo").addEventListener("click", () => ($("#reset-confirm").hidden = false));
    $("#reset-no").addEventListener("click", () => ($("#reset-confirm").hidden = true));
    $("#reset-yes").addEventListener("click", () => {
      S.extra = { listings: [], trips: [], booked: {}, requests: [], loads: [], ratings: {}, speed: S.extra.speed };
      D.owners.forEach((o) => { o.rating = o._r0; o.trips_completed = o._t0; }); S.selTrip = null; S.lastPhase = {}; saveStore();
      $("#reset-confirm").hidden = true;
      renderTripList(); renderTripDetail(); renderInsights(); renderInbox(); renderOwnerLoads(); renderDataset(); refreshCounts();
      if (S.query) runSearch();
      toast("Demo data cleared");
    });
  }

  // ================================================================ boot
  async function boot() {
    loadStore();
    if (!(await loadData())) return;
    $("#loading").hidden = true;
    document.addEventListener("click", (e) => {
      const nav = e.target.closest("[data-view]"); if (nav && !nav.closest(".ds-tabs")) { show(nav.dataset.view); return; }
      const go = e.target.closest("[data-go]"); if (go) { closeModal(); show(go.dataset.go); return; }
      const a = e.target.closest('a[href^="#"]');
      if (a && a.id !== "try-it" && VIEWS.includes(a.getAttribute("href").slice(1))) { e.preventDefault(); show(a.getAttribute("href").slice(1)); return; }
    });
    $("#modal-x").addEventListener("click", closeModal);
    $("#more-btn").addEventListener("click", openMore);
    document.addEventListener("keydown", trapFocus);
    let savedLang = "en", savedTheme = "system";
    try { savedLang = localStorage.getItem("vc-lang") || "en"; savedTheme = localStorage.getItem("vc-theme") || "system"; } catch (e) { /* ignore */ }
    applyTheme(savedTheme);
    $("#theme-btn").addEventListener("click", () => applyTheme(THEMES[(THEMES.indexOf(S.theme) + 1) % 3]));
    $("#lang").addEventListener("change", (e) => applyLang(e.target.value));
    $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
    initHome(); initFind(); initHomeForm(); initPost(); initTrips(); initOwner(); initDataset(); initReset(); initSim();
    renderInsights(); refreshCounts();
    applyLang(savedLang);
    show((location.hash || "#home").slice(1));
    window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (VIEWS.includes(v) && v !== S.view) show(v); });
    setInterval(tick, 500);
  }
  boot();
})();
