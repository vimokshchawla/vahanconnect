// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const L = require("../logic.js");

const load = (n) => L.parseCSV(fs.readFileSync(path.join(__dirname, "..", "data", n + ".csv"), "utf8"));
const D = Object.fromEntries(["cities", "owners", "trucks", "listings", "bookings", "loads", "drivers"].map((n) => [n, load(n)]));
const geo = L.makeGeo(D.cities);
const idx = (arr, k) => Object.fromEntries(arr.map((x) => [x[k], x]));
const typeRate = {};
D.trucks.forEach((t) => (typeRate[t.truck_type] ||= []).push(t.rate_per_km));
Object.keys(typeRate).forEach((k) => (typeRate[k] = typeRate[k].reduce((a, b) => a + b, 0) / typeRate[k].length));
const ctx = { listings: D.listings, isBooked: () => false, truckIdx: idx(D.trucks, "truck_id"), ownerIdx: idx(D.owners, "owner_id"), typeRate, km: geo.km };
const q0 = { from: "Mumbai", to: "Indore", date: "2026-10-31", weight: 10, type: "Open body", verifiedOnly: true, sort: "score" };

test("parseCSV reads every table with typed values", () => {
  assert.equal(D.listings.length, 1200);
  assert.equal(D.drivers.length, D.trucks.length);
  assert.equal(typeof D.trucks[0].capacity_tonnes, "number");
  assert.equal(typeof D.listings[0].is_return_trip, "boolean");
});

test("km is symmetric, zero for same city and plausible", () => {
  assert.equal(geo.km("Delhi", "Delhi"), 0);
  assert.equal(geo.km("Delhi", "Mumbai"), geo.km("Mumbai", "Delhi"));
  const d = geo.km("Delhi", "Mumbai");
  assert.ok(d > 1300 && d < 1600, `Delhi–Mumbai ${d} km`);
  assert.equal(geo.km("Delhi", "Nowhere"), 9999);
});

test("matchTrucks applies every hard filter and scores 0–100", () => {
  const R = L.matchTrucks(ctx, q0);
  assert.ok(R.length > 0);
  for (const r of R) {
    assert.equal(r.T.truck_type, q0.type);
    assert.ok(r.T.capacity_tonnes >= q0.weight);
    assert.equal(r.O.verification_status, "Verified");
    assert.ok(r.deadhead <= L.CFG.MAX_DEADHEAD_KM);
    assert.ok(r.score >= 0 && r.score <= 100);
    const sum = Object.entries(L.CFG.WEIGHTS).reduce((s, [k, w]) => s + w * r.parts[k], 0);
    assert.equal(r.score, Math.round(sum), "score equals the sum of its parts");
  }
  assert.equal(new Set(R.map((r) => r.T.truck_id)).size, R.length, "one result per truck");
  for (let i = 1; i < R.length; i++) assert.ok(R[i - 1].score >= R[i].score, "sorted by score");
});

test("matchTrucks sort by price is ascending", () => {
  const R = L.matchTrucks(ctx, { ...q0, sort: "price", type: "" });
  for (let i = 1; i < R.length; i++) assert.ok(R[i - 1].price <= R[i].price);
});

test("booked listings are excluded", () => {
  const R = L.matchTrucks(ctx, q0), id = R[0].L.listing_id;
  const R2 = L.matchTrucks({ ...ctx, isBooked: (x) => x === id }, q0);
  assert.ok(!R2.some((r) => r.L.listing_id === id));
});

test("funnel counts shrink stage by stage and end at the result count", () => {
  const R = L.matchTrucks(ctx, q0), F = L.funnel(ctx, q0, R);
  assert.ok(F.near >= F.free && F.free >= F.fits && F.fits >= F.final);
  assert.equal(F.final, R.length);
});

test("laneStats uses the exact lane only with enough records, else labels the fallback", () => {
  const st = L.laneStats(D.bookings, "Mumbai", "Indore", "Open body");
  assert.ok(["lane", "type", "none"].includes(st.scope));
  if (st.scope === "lane") { assert.ok(st.n >= L.CFG.LANE_MIN_RECORDS); assert.ok(st.min <= st.median && st.median <= st.max); }
  if (st.scope === "type") assert.ok(st.laneN < L.CFG.LANE_MIN_RECORDS && st.perKm > 0);
  const none = L.laneStats([], "A", "B", "X");
  assert.equal(none.scope, "none");
  assert.equal(L.fairBadge(10000, 500, none), null);
});

test("fairBadge follows the documented rule", () => {
  const st = { scope: "lane", perKm: 40 };
  assert.equal(L.fairBadge(40 * 100, 100, st).level, "good");
  assert.equal(L.fairBadge(45 * 100, 100, st).level, "ok");
  assert.equal(L.fairBadge(60 * 100, 100, st).level, "high");
});

test("alternatives never change the weight and their counts are real", () => {
  const q = { from: "Guwahati", to: "Kochi", date: "2026-11-05", weight: 30, type: "Refrigerated", verifiedOnly: true, sort: "score" };
  assert.equal(L.matchTrucks(ctx, q).length, 0);
  for (const a of L.alternatives(ctx, q)) {
    assert.ok(!("weight" in a.patch));
    assert.equal(L.matchTrucks(ctx, { ...q, ...a.patch }).length, a.n);
    assert.ok(a.n > 0);
  }
});

test("median helper", () => {
  assert.equal(L.median([3, 1, 2]), 2);
  assert.equal(L.median([4, 1, 2, 3]), 2.5);
});
