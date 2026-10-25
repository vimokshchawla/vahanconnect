"""
VahanConnect prototype - synthetic dataset generator.

Creates a realistic (but fully synthetic) Indian interstate freight dataset:
cities, truck owners (with verification documents), trucks, truck availability
listings (incl. empty return trips), shippers, load requests and past bookings.

Run:  python3 scripts/generate_dataset.py
Output: data/*.csv   (seeded, so every run produces the same data)
"""
import csv, math, os, random
from datetime import date, timedelta

random.seed(716)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
os.makedirs(OUT, exist_ok=True)

START = date(2026, 10, 26)          # first availability / pickup date
WINDOW = 21                         # days of future availability
HIST_START = date(2026, 4, 1)       # past bookings from here to START

# --------------------------------------------------------------------------
# Cities: name, state, state RTO code, lat, lon, freight weight (demand size)
CITIES = [
    ("Delhi", "Delhi", "DL", 28.61, 77.21, 10), ("Gurugram", "Haryana", "HR", 28.46, 77.03, 6),
    ("Panipat", "Haryana", "HR", 29.39, 76.97, 3), ("Ludhiana", "Punjab", "PB", 30.90, 75.86, 6),
    ("Amritsar", "Punjab", "PB", 31.63, 74.87, 3), ("Chandigarh", "Chandigarh", "CH", 30.73, 76.78, 3),
    ("Jaipur", "Rajasthan", "RJ", 26.91, 75.79, 6), ("Jodhpur", "Rajasthan", "RJ", 26.24, 73.02, 3),
    ("Kota", "Rajasthan", "RJ", 25.21, 75.86, 2), ("Ahmedabad", "Gujarat", "GJ", 23.02, 72.57, 8),
    ("Surat", "Gujarat", "GJ", 21.17, 72.83, 7), ("Vadodara", "Gujarat", "GJ", 22.31, 73.18, 4),
    ("Rajkot", "Gujarat", "GJ", 22.30, 70.80, 3), ("Mumbai", "Maharashtra", "MH", 19.08, 72.88, 10),
    ("Pune", "Maharashtra", "MH", 18.52, 73.86, 7), ("Nagpur", "Maharashtra", "MH", 21.15, 79.09, 5),
    ("Nashik", "Maharashtra", "MH", 20.00, 73.79, 3), ("Indore", "Madhya Pradesh", "MP", 22.72, 75.86, 5),
    ("Bhopal", "Madhya Pradesh", "MP", 23.26, 77.41, 3), ("Lucknow", "Uttar Pradesh", "UP", 26.85, 80.95, 5),
    ("Kanpur", "Uttar Pradesh", "UP", 26.45, 80.33, 5), ("Agra", "Uttar Pradesh", "UP", 27.18, 78.01, 3),
    ("Varanasi", "Uttar Pradesh", "UP", 25.32, 82.97, 2), ("Patna", "Bihar", "BR", 25.59, 85.14, 3),
    ("Kolkata", "West Bengal", "WB", 22.57, 88.36, 8), ("Bhubaneswar", "Odisha", "OD", 20.30, 85.82, 3),
    ("Raipur", "Chhattisgarh", "CG", 21.25, 81.63, 3), ("Hyderabad", "Telangana", "TS", 17.39, 78.49, 8),
    ("Visakhapatnam", "Andhra Pradesh", "AP", 17.69, 83.22, 3), ("Bengaluru", "Karnataka", "KA", 12.97, 77.59, 9),
    ("Chennai", "Tamil Nadu", "TN", 13.08, 80.27, 8), ("Coimbatore", "Tamil Nadu", "TN", 11.02, 76.96, 4),
    ("Kochi", "Kerala", "KL", 9.93, 76.27, 3), ("Guwahati", "Assam", "AS", 26.14, 91.74, 2),
]
CITY = {c[0]: c for c in CITIES}
WEIGHTS = [c[5] for c in CITIES]
NAMES = [c[0] for c in CITIES]

def road_km(a, b):
    """Great-circle distance x 1.25 road factor, rounded to 5 km."""
    _, _, _, la1, lo1, _ = CITY[a]; _, _, _, la2, lo2, _ = CITY[b]
    r = 6371
    p1, p2 = math.radians(la1), math.radians(la2)
    dp, dl = p2 - p1, math.radians(lo2 - lo1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return int(round(2 * r * math.asin(math.sqrt(h)) * 1.25 / 5) * 5)

def pick_city(exclude=None):
    while True:
        c = random.choices(NAMES, WEIGHTS)[0]
        if c != exclude:
            return c

def pick_partner_city(origin, min_km=250, max_km=2200):
    """Interstate destination at a realistic trucking distance."""
    for _ in range(200):
        d = pick_city(origin)
        if CITY[d][1] != CITY[origin][1] and min_km <= road_km(origin, d) <= max_km:
            return d
    return pick_city(origin)

# --------------------------------------------------------------------------
FIRST = ["Rajesh", "Suresh", "Harpreet", "Gurmeet", "Amit", "Vikram", "Ramesh", "Mahesh", "Sanjay", "Anil",
         "Manoj", "Deepak", "Baldev", "Kuldeep", "Imran", "Salim", "Prakash", "Ravi", "Murugan", "Senthil",
         "Venkatesh", "Srinivas", "Naresh", "Dinesh", "Arjun", "Karan", "Jaswinder", "Mohan", "Gopal", "Ashok",
         "Iqbal", "Farhan", "Joseph", "Thomas", "Biswajit", "Subhash", "Rakesh", "Yogesh", "Hitesh", "Bhavesh"]
LAST = ["Singh", "Sharma", "Yadav", "Patel", "Gill", "Sandhu", "Kumar", "Verma", "Chauhan", "Reddy",
        "Naidu", "Iyer", "Pillai", "Khan", "Ansari", "Das", "Ghosh", "Jadhav", "Patil", "Choudhary",
        "Rathore", "Meena", "Bhatia", "Malhotra", "Shinde", "Gowda", "Nair", "Mishra", "Tiwari", "Saini"]

TRUCK_TYPES = [  # type, capacity choices (t), base rate per km (Rs), share
    ("Open body", [9, 12, 16, 21], 38, 34),
    ("Container", [7, 9, 16, 20], 45, 24),
    ("Trailer", [25, 28, 32], 58, 12),
    ("Tipper", [16, 20, 25], 44, 10),
    ("Refrigerated", [5, 9, 12], 62, 8),
    ("LCV (Tata 407 class)", [2.5, 4], 26, 12),
]
TT = {t[0]: t for t in TRUCK_TYPES}

GOODS = {  # goods -> preferred truck types
    "Textiles & garments": ["Container", "Open body"], "Auto parts": ["Container", "Open body"],
    "FMCG cartons": ["Container", "Open body", "LCV (Tata 407 class)"], "Steel coils": ["Trailer"],
    "Cement bags": ["Open body", "Tipper"], "Agri produce (onion/potato)": ["Open body"],
    "Frozen food & dairy": ["Refrigerated"], "Pharmaceuticals": ["Refrigerated", "Container"],
    "Electronics": ["Container"], "Furniture": ["Container", "Open body"],
    "Machinery parts": ["Trailer", "Open body"], "Sand & aggregates": ["Tipper"],
    "Plastic granules": ["Open body", "Container"], "Paper rolls": ["Open body", "Container"],
}
INDUSTRY_GOODS = {
    "Textiles": ["Textiles & garments"], "Auto components": ["Auto parts", "Machinery parts"],
    "FMCG distribution": ["FMCG cartons"], "Steel trading": ["Steel coils"],
    "Construction supply": ["Cement bags", "Sand & aggregates"], "Agri trading": ["Agri produce (onion/potato)"],
    "Dairy & food processing": ["Frozen food & dairy"], "Pharma distribution": ["Pharmaceuticals"],
    "Electronics wholesale": ["Electronics"], "Furniture manufacturing": ["Furniture"],
    "Plastics & packaging": ["Plastic granules", "Paper rolls"],
}
CO_PREFIX = ["Shree", "Om", "Jai", "Sai", "New", "Balaji", "Ganpati", "Royal", "Sunrise", "Unity",
             "Prime", "Bharat", "Kaveri", "Narmada", "Shakti", "Lakshmi", "Pioneer", "Star", "Classic", "Global"]
CO_SUFFIX = {"Textiles": "Textiles", "Auto components": "Auto Components", "FMCG distribution": "Distributors",
             "Steel trading": "Steel Traders", "Construction supply": "Build Supplies", "Agri trading": "Agro Traders",
             "Dairy & food processing": "Foods", "Pharma distribution": "Pharma Distributors",
             "Electronics wholesale": "Electronics", "Furniture manufacturing": "Furnitures",
             "Plastics & packaging": "Polymers"}

def gstin(state_code_num):
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    pan = "".join(random.choices(letters, k=5)) + "".join(random.choices("0123456789", k=4)) + random.choice(letters)
    return f"{state_code_num:02d}{pan}1Z{random.choice('0123456789ABCDEFGHJK')}"

STATE_GST = {"Delhi": 7, "Haryana": 6, "Punjab": 3, "Chandigarh": 4, "Rajasthan": 8, "Gujarat": 24,
             "Maharashtra": 27, "Madhya Pradesh": 23, "Uttar Pradesh": 9, "Bihar": 10, "West Bengal": 19,
             "Odisha": 21, "Chhattisgarh": 22, "Telangana": 36, "Andhra Pradesh": 37, "Karnataka": 29,
             "Tamil Nadu": 33, "Kerala": 32, "Assam": 18}

def write(name, rows, fields):
    with open(os.path.join(OUT, name), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print(f"{name:16s} {len(rows):5d} rows")

# --------------------------------------------------------------------------
# Cities
write("cities.csv", [dict(city=c[0], state=c[1], rto_code=c[2], lat=c[3], lon=c[4]) for c in CITIES],
      ["city", "state", "rto_code", "lat", "lon"])

# Owners -------------------------------------------------------------------
owners = []
for i in range(1, 161):
    home = pick_city()
    state = CITY[home][1]
    lic = random.random() < 0.95
    rc = random.random() < 0.94
    idv = random.random() < 0.97
    gst_ok = random.random() < 0.90
    bg = random.random() < 0.88
    verified = lic and rc and idv and gst_ok and bg
    status = "Verified" if verified else ("Pending" if random.random() < 0.7 else "Rejected")
    owners.append(dict(
        owner_id=f"OWN{i:03d}", name=f"{random.choice(FIRST)} {random.choice(LAST)}",
        home_city=home, state=state, phone=f"+91 9{random.randint(100,999)}XX XX{random.randint(10,99)}",
        fleet_size=0, gst_no=gstin(STATE_GST[state]) if gst_ok else "",
        licence_verified=lic, rc_verified=rc, id_verified=idv, gst_verified=gst_ok,
        background_check=bg, verification_status=status,
        rating=round(random.uniform(3.6, 5.0), 1) if verified else round(random.uniform(3.0, 4.6), 1),
        trips_completed=random.randint(5, 240) if verified else random.randint(0, 25),
        joined_on=(HIST_START + timedelta(days=random.randint(-180, 150))).isoformat()))

# Trucks -------------------------------------------------------------------
trucks = []
tid = 0
for o in owners:
    n = random.choices([1, 2, 3, 4, 6], [45, 25, 15, 10, 5])[0]
    o["fleet_size"] = n
    for _ in range(n):
        tid += 1
        ttype = random.choices([t[0] for t in TRUCK_TYPES], [t[3] for t in TRUCK_TYPES])[0]
        _, caps, base, _ = TT[ttype]
        rto = CITY[o["home_city"]][2]
        trucks.append(dict(
            truck_id=f"TRK{tid:04d}", owner_id=o["owner_id"],
            reg_no=f"{rto} {random.randint(1,99):02d} {random.choice('ABCDEFGHJKLMNPRSTUVWXYZ')}{random.choice('ABCDEFGHJKLMNPRSTUVWXYZ')} {random.randint(1000,9999)}",
            truck_type=ttype, capacity_tonnes=random.choice(caps),
            rate_per_km=int(base * random.uniform(0.9, 1.15)),
            model_year=random.randint(2012, 2025), gps_enabled=random.random() < 0.55))
truck_by_id = {t["truck_id"]: t for t in trucks}
owner_by_id = {o["owner_id"]: o for o in owners}

# Availability listings ----------------------------------------------------
# Most listings are trucks that just delivered somewhere away from home and are
# looking for a load back (return trip). Others are at home looking for any load.
listings = []
for i in range(1, 1201):
    t = random.choice(trucks)
    o = owner_by_id[t["owner_id"]]
    home = o["home_city"]
    is_return = random.random() < 0.68
    if is_return:
        current = pick_partner_city(home)
        pref = home
    else:
        current = home
        pref = random.choice(["Any", "Any", pick_partner_city(home)])
    avail = START + timedelta(days=random.randint(0, WINDOW - 1))
    listings.append(dict(
        listing_id=f"LST{i:04d}", truck_id=t["truck_id"], owner_id=o["owner_id"],
        current_city=current, preferred_destination=pref, home_city=home,
        is_return_trip=is_return, available_from=avail.isoformat(),
        available_until=(avail + timedelta(days=random.randint(3, 8))).isoformat(),
        # return-trip trucks typically quote lower to avoid running empty
        asking_rate_per_km=int(t["rate_per_km"] * (random.uniform(0.70, 0.85) if is_return else random.uniform(0.95, 1.08))),
        status="Open"))

# Shippers -----------------------------------------------------------------
shippers, used = [], set()
for i in range(1, 91):
    ind = random.choice(list(INDUSTRY_GOODS))
    while True:
        nm = f"{random.choice(CO_PREFIX)} {random.choice(LAST)} {CO_SUFFIX[ind]}"
        if nm not in used:
            used.add(nm); break
    city = pick_city()
    shippers.append(dict(shipper_id=f"SHP{i:03d}", company=nm, industry=ind, city=city,
                         state=CITY[city][1], gst_no=gstin(STATE_GST[CITY[city][1]]),
                         monthly_shipments=random.choice([2, 4, 6, 8, 12, 20, 30])))

# Loads (open requests) ----------------------------------------------------
def make_load(lid, when, shipper=None):
    s = shipper or random.choice(shippers)
    goods = random.choice(INDUSTRY_GOODS[s["industry"]])
    ttype = random.choice(GOODS[goods])
    cap = max(TT[ttype][1])
    origin = s["city"] if random.random() < 0.75 else pick_city()
    dest = pick_partner_city(origin)
    return dict(load_id=lid, shipper_id=s["shipper_id"], company=s["company"], goods=goods,
                origin=origin, destination=dest, distance_km=road_km(origin, dest),
                weight_tonnes=round(random.uniform(0.35, 0.95) * cap, 1), truck_type=ttype,
                pickup_date=when.isoformat())

loads = []
for i in range(1, 341):
    l = make_load(f"LD{i:04d}", START + timedelta(days=random.randint(0, WINDOW - 1)))
    l["budget_rs"] = int(l["distance_km"] * TT[l["truck_type"]][2] * random.uniform(0.8, 1.05) / 100) * 100
    l["status"] = "Open"
    loads.append(l)

# Past bookings (history) --------------------------------------------------
bookings = []
verified_trucks = [t for t in trucks if owner_by_id[t["owner_id"]]["verification_status"] == "Verified"]
span = (START - HIST_START).days
for i in range(1, 641):
    d = HIST_START + timedelta(days=int(span * (random.random() ** 0.7)))  # more bookings recently (growth)
    l = make_load(f"HLD{i:04d}", d)
    cands = [t for t in verified_trucks if t["truck_type"] == l["truck_type"]] or verified_trucks
    t = random.choice(cands)
    o = owner_by_id[t["owner_id"]]
    backhaul = random.random() < 0.62
    quoted = int(l["distance_km"] * t["rate_per_km"] * (random.uniform(0.70, 0.85) if backhaul else random.uniform(0.95, 1.08)))
    agreed = int(quoted * random.uniform(0.90, 0.99) / 100) * 100   # negotiated down a little
    broker_est = int(l["distance_km"] * t["rate_per_km"] * random.uniform(1.08, 1.18) / 100) * 100
    status = random.choices(["Completed", "Cancelled"], [93, 7])[0]
    bookings.append(dict(
        booking_id=f"BK{i:04d}", booking_date=d.isoformat(), shipper_id=l["shipper_id"], company=l["company"],
        owner_id=o["owner_id"], truck_id=t["truck_id"], truck_type=t["truck_type"], goods=l["goods"],
        origin=l["origin"], destination=l["destination"], distance_km=l["distance_km"],
        weight_tonnes=l["weight_tonnes"], is_return_trip=backhaul, quoted_price_rs=quoted,
        agreed_price_rs=agreed, typical_broker_price_rs=broker_est,
        empty_km_avoided=l["distance_km"] if backhaul else 0, status=status,
        shipper_rating=round(random.uniform(3.8, 5.0), 1) if status == "Completed" else ""))
bookings.sort(key=lambda b: b["booking_date"])
for n, b in enumerate(bookings, 1):
    b["booking_id"] = f"BK{n:04d}"

write("owners.csv", owners, list(owners[0].keys()))
write("trucks.csv", trucks, list(trucks[0].keys()))
write("listings.csv", listings, list(listings[0].keys()))
write("shippers.csv", shippers, list(shippers[0].keys()))
write("loads.csv", loads, list(loads[0].keys()))
write("bookings.csv", bookings, list(bookings[0].keys()))

# Drivers (added later; uses its own seeded RNG so every table above stays identical)
drv_rng = random.Random(7161)
drivers = []
for n, t in enumerate(trucks, 1):
    o = owner_by_id[t["owner_id"]]
    owner_ok = o["verification_status"] == "Verified"
    lic = drv_rng.random() < (0.96 if owner_ok else 0.75)
    idv = drv_rng.random() < (0.97 if owner_ok else 0.8)
    drivers.append(dict(driver_id=f"DRV{n:04d}", name=f"{drv_rng.choice(FIRST)} {drv_rng.choice(LAST)}",
                        truck_id=t["truck_id"], owner_id=t["owner_id"], licence_verified=lic, id_verified=idv,
                        verification_status="Verified" if (lic and idv) else "Pending",
                        experience_years=drv_rng.randint(2, 25)))
write("drivers.csv", drivers, list(drivers[0].keys()))
