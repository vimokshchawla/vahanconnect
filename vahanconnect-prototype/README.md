# VahanConnect – Prototype

A working prototype of **VahanConnect**, a marketplace that connects shippers with
verified independent truck owners and uses route-based matching to fill empty
return trips. Group G2.

It is a static web app (HTML + CSS + plain JavaScript, no build step) that runs
entirely on the CSV dataset in `/data`.

## What you can do in the prototype (v2)

| Tab | What it shows |
|---|---|
| **Home** | The problem in one line, headline numbers from the data, a **live activity feed** (bookings, deliveries, trucks posted) and the Value Proposition Canvas: each customer pain mapped to the feature that relieves it. |
| **Find trucks** (shipper) | Route, date and weight, plus one-tap example loads. A route map shows the matching trucks, with return-trip trucks in gold. Cards show the owner's price, the saving against a broker and a tappable Verified badge. Compare up to 3, then book. |
| **Booking flow** | 4 steps: **Request → Negotiate → Pay advance → Track**. The owner comes online, "types" and replies to your offers (accepts, counters or holds firm). The 20% advance is a simulated UPI payment. |
| **My trips** | **Live tracking.** The truck moves along the route on the map, with a status timeline (driver assigned → reached pickup → loaded → passed a city on the way → reached → delivered), % complete, km covered and time left. You get notifications at every stage and can rate the owner at the end. "Start a sample trip" starts one instantly. |
| **For owners** | Act as any owner in the dataset. See their verification checks, post where the truck is free, and see matching loads with an **earnings view** ("you earn ₹X vs ₹Y to drive home empty"). **Booking requests arrive live**: accept, counter or decline, and accepted jobs become live trips. Quotes you send get a reply from the shipper a few seconds later. |
| **Insights** | KPIs and charts computed from the data: bookings per month, freight value, platform revenue (assumed 3%), savings vs brokers, return trips filled, empty km avoided, busiest corridors, route network, supply vs demand, verification. |
| **Dataset** | Browse, filter and open every CSV the app runs on. |

### What is simulated
The prototype has no server, so the "live" parts are simulated in the browser: the activity
feed, the owner's chat replies, shipper requests and replies, the UPI payment, and trip
progress (a full trip takes about 2 minutes on Fast or 6 minutes on Slow; times shown in the
timeline use a simulated trip clock). Everything else (matching, prices, savings, insights)
is computed from the dataset.

Trips, requests and posted trucks are saved in the browser (localStorage), so a trip keeps
moving even if you refresh. **My trips → Reset demo** clears them before a presentation.

## How the matching works

For a load (from, to, date, weight, truck type) every open listing is checked:

1. **Hard filters:** truck type matches, capacity ≥ weight, truck free on the pickup
   date, truck within 150 km of the pickup city, and (optionally) owner verified.
2. **Score out of 100:**
   - location (30): same city scores highest; less as the empty drive to pickup grows
   - direction (30): full marks if the owner wants to go to the load's destination,
     e.g. a truck on its **return trip home**
   - date (15): how close the truck's free date is to the pickup date
   - capacity fit (10): how much of the truck the load fills
   - owner rating (10)
   - verification (5)
3. **Price:** owner's asking rate (₹/km) × road distance. The platform never sets the
   price; the shipper negotiates directly with the owner.

Road distance = great-circle distance × 1.25 road factor.

## Dataset (`/data`, synthetic)

| File | Rows | Contents |
|---|---|---|
| cities.csv | 34 | Freight hubs with state, RTO code and coordinates |
| owners.csv | 160 | Owners with licence, RC, ID, GST and background-check status |
| trucks.csv | 338 | RTO-style registration, type, capacity, base ₹/km |
| listings.csv | 1,200 | Open truck availability (about 68% are return trips) |
| shippers.csv | 90 | SMEs, manufacturers, traders, distributors |
| loads.csv | 340 | Open load requests |
| bookings.csv | 640 | Past bookings (Apr–Oct 2026) with agreed vs broker price |

Regenerate it (seeded, so the output is identical every time):

```bash
python3 scripts/generate_dataset.py
```

You can edit the generator (more cities, more trucks, different rates) and rerun it.
The app picks up the new CSVs automatically.

## Run locally

The app loads CSV files with `fetch`, so open it through a local server rather than
double-clicking `index.html`:

```bash
npx serve .
# or
python3 -m http.server 8000   # then open http://localhost:8000
```

## Deploy on Vercel

**Option A: Vercel website (no command line)**
1. Push this folder to a GitHub repository.
2. Go to vercel.com → **Add New… → Project** → import the repository.
3. Framework preset: **Other**. Leave the build command and output directory empty.
4. Click **Deploy**. You get a link like `https://vahanconnect-xyz.vercel.app`.

**Option B: Vercel CLI**
```bash
npm i -g vercel
cd vahanconnect-prototype
vercel          # first time: answer the prompts, accept the defaults
vercel --prod   # publish to the production URL
```

## Files

```
index.html          page structure
styles.css          styling (light and dark mode)
app.js              data loading, matching engine, negotiation, insights
data/*.csv          the dataset
scripts/generate_dataset.py   dataset generator
vercel.json         static hosting settings
```

All names, companies, phone numbers and GST numbers are randomly generated.
