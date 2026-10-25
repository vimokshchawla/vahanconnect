# VahanConnect – Prototype (v3)

A marketplace that connects shippers with verified independent truck owners and uses route-based
matching to fill empty return trips. Group G2. Live: https://vahanconnect.vercel.app

It is a static web app (HTML, CSS and plain JavaScript, no build step) that runs on the CSV dataset in `/data`.

## What works
| Area | What it does |
|---|---|
| Home | Value proposition, service cards (Find trucks, Post a load, For owners), stats computed from the data, simulated activity feed, Value Proposition Canvas mapping, user journey |
| Find trucks | Pickup → drop search; animated matching funnel with real counts (skippable, reduced-motion aware); ranked results with **Why this match?** (score breakdown), **Details** (truck, owner, driver), **lane price guide**, **fair-price badge**, compare up to 3 (with remove), map selection, sort, one **Sponsored** slot (fictional) |
| No results | **Smart suggestions** (nearby dates, wider radius, pending-verification owners, other truck types), each with a real count and one tap to apply. The load weight is never changed |
| Post a load | Validated form → review → publish. Posted loads appear in owners' matching loads and in the dataset browser |
| Booking | Request → Negotiate (scripted owner replies) → Pay advance (simulated UPI) → Track. Shows proposed protections, clearly marked as not active |
| My trips | Simulated tracking with timeline, linked **driver**, **cancel with reason**, rating (updates the owner's rating once per trip) |
| For owners | Act as any owner, verification checks, post availability, matching loads with earnings view, live (simulated) requests: accept, counter or decline, quotes |
| Insights / Dataset | KPIs and charts from the data; browse all 8 CSVs |
| Everywhere | English / **हिंदी** toggle, theme toggle (system / light / dark), phone bottom nav with More menu, **Simulation mode** panel that can outline simulated areas |

## What is simulated
Dataset (synthetic), activity feed, owner/shipper replies, UPI payment, truck movement and times,
verification flags (owner and driver), the sponsored partner. Bookings, posted loads, trucks, ratings and
cancellations are stored in **this browser only** (localStorage), so two browsers do not share data.
**Reset demo** on My trips clears them.

## Matching and pricing (logic.js)
- Hard filters: truck type, capacity ≥ weight, free on the pickup date (±1 day), within 150 km of pickup
  (250 km if you accept that suggestion), optionally verified owner.
- Score = location 30 + direction/return trip 30 + date 15 + capacity fit 10 + rating 10 + verification 5.
  A weighted rule, not AI. **Why this match?** shows each part.
- Price = owner's ₹/km × road distance (great-circle × 1.25).
- Lane price guide: min / median / max of completed bookings on the exact route and truck type, shown only
  with ≥ 3 records; otherwise a clearly labelled ₹/km reference for that truck type.
- Fair-price badge (prototype heuristic): ₹/km ≤ reference median → "Fair price"; ≤ 15% above → "Near typical";
  higher → "Above typical".

## Dataset (`/data`, synthetic, seeded)
cities 34 · owners 160 · trucks 338 · **drivers 338** · listings 1,200 · shippers 90 · loads 340 · bookings 640.
Regenerate with `python3 scripts/generate_dataset.py` (identical output each run; drivers use a separate seed so
older tables are unchanged).

## Tests
```bash
node --test tests/logic.test.js
```
10 tests: CSV parsing, distances, filters and score arithmetic, sorting, booked listings, funnel counts,
lane statistics, fair-price rule, empty-state suggestions.

## Run locally / deploy
```bash
npx serve .          # or: python3 -m http.server 8000
```
Vercel: import the GitHub repo, framework preset **Other**, no build command.

## Files
```
index.html     page structure          logic.js   matching, funnel, pricing, suggestions (tested)
styles.css     styles, light/dark      i18n.js    English / Hindi strings
app.js         UI and simulated flows  tests/     node --test unit tests
data/*.csv     dataset                 scripts/   dataset generator
assets/        logo and icons          vercel.json
```

## Known limitations
No backend or accounts (a shared, real-time version would need e.g. Supabase with auth and row-level
security); schematic map, not real roads; Hindi covers the main screens, not every message; `app.js` is still
one large file (logic was split out into `logic.js`); no real payments, GPS or document verification.
