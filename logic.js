/* VahanConnect — pure business logic (no DOM). Used by app.js in the browser and by tests in Node. */
(function (root) {
  "use strict";

  const CFG = {
    MAX_DEADHEAD_KM: 150,      // default pickup radius
    WIDE_DEADHEAD_KM: 250,     // radius offered by the "widen search" suggestion
    BROKER_MARKUP: 1.12,       // typical broker price vs owner's base rate
    LANE_MIN_RECORDS: 3,       // minimum completed bookings before a lane price guide is shown
    FAIR_BAND: 1.15,           // up to 15% above the median ₹/km is "near typical"
    WEIGHTS: { loc: 30, dir: 30, date: 15, cap: 10, rating: 10, ver: 5 },
  };

  function parseCSV(text) {
    const rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
      else if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const head = rows.shift() || [];
    return rows.filter((r) => r.length === head.length).map((r) => {
      const o = {};
      head.forEach((h, i) => {
        const v = r[i];
        if (v === "True") o[h] = true; else if (v === "False") o[h] = false;
        else if (/^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v)) o[h] = Number(v);
        else o[h] = v;
      });
      return o;
    });
  }

  /** Road-distance estimate: great-circle distance × 1.25, rounded to 5 km. */
  function makeGeo(cities) {
    const idx = {}; cities.forEach((c) => (idx[c.city] = c));
    const cache = new Map();
    function km(a, b) {
      if (a === b) return 0;
      const k = a < b ? a + "|" + b : b + "|" + a;
      if (cache.has(k)) return cache.get(k);
      const A = idx[a], B = idx[b];
      if (!A || !B) return 9999;
      const p1 = A.lat * Math.PI / 180, p2 = B.lat * Math.PI / 180, dl = (B.lon - A.lon) * Math.PI / 180;
      const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
      const d = Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * 1.25 / 5) * 5;
      cache.set(k, d); return d;
    }
    return { km, idx };
  }

  const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dayDiff = (a, b) => Math.round((new Date(a + "T00:00:00Z") - new Date(b + "T00:00:00Z")) / 864e5);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round100 = (n) => Math.round(n / 100) * 100;
  const median = (a) => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  /**
   * Rank open listings for a load. ctx = { listings, isBooked(id), truckIdx, ownerIdx, typeRate, km }.
   * q = { from, to, date, weight, type, verifiedOnly, sort, radius? }.
   * Returns one result per truck (its best listing) with the score broken into components.
   */
  function matchTrucks(ctx, q) {
    const W = CFG.WEIGHTS, radius = q.radius || CFG.MAX_DEADHEAD_KM, tripKm = ctx.km(q.from, q.to), out = [];
    for (const L of ctx.listings) {
      if (ctx.isBooked(L.listing_id)) continue;
      const T = ctx.truckIdx[L.truck_id], O = ctx.ownerIdx[L.owner_id];
      if (!T || !O) continue;
      if (q.type && T.truck_type !== q.type) continue;
      if (q.weight > T.capacity_tonnes) continue;
      if (q.verifiedOnly && O.verification_status !== "Verified") continue;
      if (L.available_from > addDays(q.date, 1) || L.available_until < q.date) continue;
      const deadhead = ctx.km(L.current_city, q.from);
      if (deadhead > radius) continue;
      const loc = L.current_city === q.from ? 1 : Math.max(0, 1 - 0.8 * (deadhead / CFG.MAX_DEADHEAD_KM));
      let dir, dirLabel;
      const pref = L.preferred_destination;
      if (pref !== "Any" && ctx.km(pref, q.to) <= 120) { dir = 1; dirLabel = L.is_return_trip ? "Going home" : "Heading your way"; }
      else if (pref === "Any") { dir = 0.6; dirLabel = "Open to any route"; }
      else { dir = Math.max(0.1, 0.6 * (1 - ctx.km(pref, q.to) / 900)); dirLabel = `Prefers ${pref}`; }
      const date = clamp(1 - Math.abs(dayDiff(L.available_from, q.date)) / 4, 0, 1);
      const fit = q.weight / T.capacity_tonnes, cap = 0.4 + 0.6 * fit;
      const rating = clamp((O.rating - 3) / 2, 0, 1), ver = O.verification_status === "Verified" ? 1 : 0;
      const parts = { loc, dir, date, cap, rating, ver };
      const score = Math.round(Object.keys(W).reduce((s, k) => s + W[k] * parts[k], 0));
      const price = round100(tripKm * L.asking_rate_per_km);
      const market = round100(tripKm * (ctx.typeRate[T.truck_type] || T.rate_per_km) * CFG.BROKER_MARKUP);
      out.push({ L, T, O, score, parts, dir, dirLabel, isRet: dir === 1 && L.is_return_trip, deadhead, price, market, tripKm, fit });
    }
    const sorters = {
      score: (a, b) => b.score - a.score || a.price - b.price,
      price: (a, b) => a.price - b.price,
      rating: (a, b) => b.O.rating - a.O.rating || b.score - a.score,
      date: (a, b) => a.L.available_from.localeCompare(b.L.available_from) || b.score - a.score,
    };
    const best = new Map();
    out.forEach((r) => { const b = best.get(r.T.truck_id); if (!b || r.score > b.score) best.set(r.T.truck_id, r); });
    return [...best.values()].sort(sorters[q.sort] || sorters.score);
  }

  /** Stage counts for the search animation: near → free on date → can carry → final (verified if filtered). */
  function funnel(ctx, q, results) {
    const radius = q.radius || CFG.MAX_DEADHEAD_KM, passIds = new Set(results.map((r) => r.T.truck_id)), best = new Map();
    for (const L of ctx.listings) {
      if (ctx.isBooked(L.listing_id)) continue;
      const T = ctx.truckIdx[L.truck_id], O = ctx.ownerIdx[L.owner_id];
      if (!T || !O) continue;
      const dh = ctx.km(L.current_city, q.from);
      if (dh > radius) continue;
      let stage = 0;
      if (!passIds.has(T.truck_id)) {
        const dateOk = !(L.available_from > addDays(q.date, 1) || L.available_until < q.date);
        const fitOk = !(q.type && T.truck_type !== q.type) && q.weight <= T.capacity_tonnes;
        stage = !dateOk ? 2 : !fitOk ? 3 : 4;
      }
      const prev = best.get(T.truck_id);
      if (!prev || (prev.stage !== 0 && (stage === 0 || stage > prev.stage))) best.set(T.truck_id, { L, T, O, dh, stage });
    }
    const all = [...best.values()], cnt = (f) => all.filter(f).length;
    return { all, near: all.length, free: cnt((c) => c.stage === 0 || c.stage > 2), fits: cnt((c) => c.stage === 0 || c.stage > 3), final: results.length };
  }

  /**
   * Price reference from completed bookings. Uses the exact lane (same origin, destination, truck type) when it has
   * at least LANE_MIN_RECORDS records; otherwise falls back to ₹/km across all bookings of that truck type, labelled as such.
   */
  function laneStats(bookings, from, to, type) {
    const done = bookings.filter((b) => b.status === "Completed" && (!type || b.truck_type === type));
    const lane = done.filter((b) => b.origin === from && b.destination === to);
    if (lane.length >= CFG.LANE_MIN_RECORDS) {
      const p = lane.map((b) => b.agreed_price_rs), perKm = lane.map((b) => b.agreed_price_rs / b.distance_km);
      return { scope: "lane", n: lane.length, min: Math.min(...p), median: median(p), max: Math.max(...p), perKm: median(perKm) };
    }
    if (done.length >= CFG.LANE_MIN_RECORDS) {
      const perKm = done.map((b) => b.agreed_price_rs / b.distance_km);
      return { scope: "type", n: done.length, laneN: lane.length, perKm: median(perKm), perKmMin: Math.min(...perKm), perKmMax: Math.max(...perKm) };
    }
    return { scope: "none", n: done.length };
  }

  /** Prototype heuristic: compare a quote's ₹/km with the reference median ₹/km. */
  function fairBadge(price, km, stats) {
    if (!stats || stats.scope === "none" || !km) return null;
    const r = price / km / stats.perKm;
    return r <= 1 ? { level: "good", label: "Fair price" } : r <= CFG.FAIR_BAND ? { level: "ok", label: "Near typical" } : { level: "high", label: "Above typical" };
  }

  /** Suggestions when a search finds nothing. Never changes the shipment's weight. */
  function alternatives(ctx, q) {
    const out = [], n = (patch) => matchTrucks(ctx, Object.assign({}, q, patch)).length;
    for (const d of [1, -1, 2, -2, 3, -3]) {
      const date = addDays(q.date, d), c = n({ date });
      if (c) { out.push({ kind: "date", label: `Pick up on ${date}`, patch: { date }, n: c }); if (out.length === 2) break; }
    }
    if (!q.radius || q.radius < CFG.WIDE_DEADHEAD_KM) { const c = n({ radius: CFG.WIDE_DEADHEAD_KM }); if (c) out.push({ kind: "radius", label: `Include trucks up to ${CFG.WIDE_DEADHEAD_KM} km from pickup`, patch: { radius: CFG.WIDE_DEADHEAD_KM }, n: c }); }
    if (q.verifiedOnly) { const c = n({ verifiedOnly: false }); if (c) out.push({ kind: "verified", label: "Include owners whose verification is pending", patch: { verifiedOnly: false }, n: c }); }
    if (q.type) { const c = n({ type: "" }); if (c) out.push({ kind: "type", label: "Show other truck types that can carry this weight", patch: { type: "" }, n: c }); }
    return out;
  }

  const api = { CFG, parseCSV, makeGeo, matchTrucks, funnel, laneStats, fairBadge, alternatives, addDays, dayDiff, median, round100 };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.VCLogic = api;
})(typeof window !== "undefined" ? window : globalThis);
