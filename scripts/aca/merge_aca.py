"""Merge the five council ACA sources into one WGS84 GeoJSON.

Kildare arrives as an ITM (IRENET95 / EPSG:2157) shapefile; everything else is
already WGS84 GeoJSON. The shapefile reader and the inverse transverse
Mercator are implemented inline (no GDAL/pyshp on this machine).
"""
import json, math, struct

# --- Inverse Transverse Mercator (GRS80, ITM parameters, EPSG:2157) ---------
A = 6378137.0
F = 1 / 298.257222101
K0 = 0.99982
LAT0 = math.radians(53.5)
LON0 = math.radians(-8.0)
FE, FN = 600000.0, 750000.0
E2 = F * (2 - F)
EP2 = E2 / (1 - E2)

def _m(lat):
    return A * (
        (1 - E2 / 4 - 3 * E2**2 / 64 - 5 * E2**3 / 256) * lat
        - (3 * E2 / 8 + 3 * E2**2 / 32 + 45 * E2**3 / 1024) * math.sin(2 * lat)
        + (15 * E2**2 / 256 + 45 * E2**3 / 1024) * math.sin(4 * lat)
        - (35 * E2**3 / 3072) * math.sin(6 * lat)
    )

M0 = _m(LAT0)
E1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))

def itm_to_wgs84(x, y):
    m = M0 + (y - FN) / K0
    mu = m / (A * (1 - E2 / 4 - 3 * E2**2 / 64 - 5 * E2**3 / 256))
    lat1 = (
        mu
        + (3 * E1 / 2 - 27 * E1**3 / 32) * math.sin(2 * mu)
        + (21 * E1**2 / 16 - 55 * E1**4 / 32) * math.sin(4 * mu)
        + (151 * E1**3 / 96) * math.sin(6 * mu)
        + (1097 * E1**4 / 512) * math.sin(8 * mu)
    )
    sin1, cos1 = math.sin(lat1), math.cos(lat1)
    c1 = EP2 * cos1**2
    t1 = math.tan(lat1) ** 2
    n1 = A / math.sqrt(1 - E2 * sin1**2)
    r1 = A * (1 - E2) / (1 - E2 * sin1**2) ** 1.5
    d = (x - FE) / (n1 * K0)
    lat = lat1 - (n1 * math.tan(lat1) / r1) * (
        d**2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * EP2) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * EP2 - 3 * c1**2) * d**6 / 720
    )
    lon = LON0 + (
        d
        - (1 + 2 * t1 + c1) * d**3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * EP2 + 24 * t1**2) * d**5 / 120
    ) / cos1
    return math.degrees(lon), math.degrees(lat)

# --- Minimal SHP (type 5 polygon) + DBF readers ------------------------------
def read_shp_polygons(path):
    with open(path, "rb") as fh:
        data = fh.read()
    pos, out = 100, []
    while pos < len(data):
        _, length = struct.unpack(">ii", data[pos : pos + 8])
        rec = data[pos + 8 : pos + 8 + length * 2]
        pos += 8 + length * 2
        shape_type = struct.unpack("<i", rec[:4])[0]
        # 5 = Polygon, 15 = PolygonZ, 25 = PolygonM — the XY part is identical;
        # the Z/M arrays trail after the points and are simply not read.
        if shape_type not in (5, 15, 25):
            out.append(None)
            continue
        num_parts, num_points = struct.unpack("<ii", rec[36:44])
        parts = struct.unpack(f"<{num_parts}i", rec[44 : 44 + 4 * num_parts])
        pts_off = 44 + 4 * num_parts
        pts = struct.unpack(f"<{num_points * 2}d", rec[pts_off : pts_off + 16 * num_points])
        rings = []
        for i, start in enumerate(parts):
            end = parts[i + 1] if i + 1 < num_parts else num_points
            ring = [itm_to_wgs84(pts[2 * j], pts[2 * j + 1]) for j in range(start, end)]
            rings.append([[round(x, 6), round(y, 6)] for x, y in ring])
        out.append(rings)
    return out

def read_dbf(path):
    with open(path, "rb") as fh:
        data = fh.read()
    n_records = struct.unpack("<I", data[4:8])[0]
    header_len, record_len = struct.unpack("<HH", data[8:12])
    fields = []
    p = 32
    while data[p] != 0x0D:
        name = data[p : p + 11].split(b"\0")[0].decode("latin-1")
        size = data[p + 16]
        fields.append((name, size))
        p += 32
    records = []
    for i in range(n_records):
        rp = header_len + i * record_len + 1
        rec = {}
        for name, size in fields:
            rec[name] = data[rp : rp + size].decode("latin-1").strip()
            rp += size
        records.append(rec)
    return records

# --- Normalise every source into common properties ---------------------------
def geom_rounded(geom):
    def rnd(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], 6), round(c[1], 6)]  # also strips z
        return [rnd(x) for x in c]
    return {"type": geom["type"], "coordinates": rnd(geom["coordinates"])}

features = []

def add(geom, name, council, council_label, ref="", designation="Architectural Conservation Area"):
    features.append({
        "type": "Feature",
        "geometry": geom,
        "properties": {
            "aca_name": name,
            "council": council,
            "council_label": council_label,
            "ref": ref,
            "designation": designation,
        },
    })

for f in json.load(open("dcc.geojson"))["features"]:
    p = f["properties"]
    add(geom_rounded(f["geometry"]), p.get("ACA") or "ACA", "dublin-city", "Dublin City Council", p.get("Apas_code") or "")

for f in json.load(open("fingal.geojson"))["features"]:
    p = f["properties"]
    add(geom_rounded(f["geometry"]), p.get("Obj_Desc") or p.get("Location") or "ACA", "fingal", "Fingal County Council")

for f in json.load(open("sdcc.geojson"))["features"]:
    p = f["properties"]
    add(geom_rounded(f["geometry"]), p.get("LOCATION") or "ACA", "south-dublin", "South Dublin County Council", p.get("REF") or "")

for f in json.load(open("dlr.geojson"))["features"]:
    p = f["properties"]
    add(
        geom_rounded(f["geometry"]),
        p.get("DESCRIPTION") or "Conservation area",
        "dlr",
        "Dún Laoghaire-Rathdown County Council",
        designation=p.get("CONSERVATION_TYPE") or "Architectural Conservation Area",
    )

shp = read_shp_polygons("kildare/ACA_Kildare_CDP_23-29.shp")
dbf = read_dbf("kildare/ACA_Kildare_CDP_23-29.dbf")
print("kildare dbf fields:", list(dbf[0].keys()) if dbf else [])
for rings, rec in zip(shp, dbf):
    if not rings:
        continue
    name = next((rec[k] for k in ("NAME", "Name", "ACA_NAME", "LOCATION", "Location", "SITE_NAME") if rec.get(k)), "")
    if not name:
        name = next((v for v in rec.values() if v and not v.replace(".", "").replace("-", "").isdigit()), "ACA")
    add({"type": "Polygon", "coordinates": rings}, name, "kildare", "Kildare County Council")

out = {"type": "FeatureCollection", "features": features}
with open("aca.geojson", "w") as fh:
    json.dump(out, fh, separators=(",", ":"))
from collections import Counter
print(Counter(f["properties"]["council"] for f in features))
print("kildare sample:", [f["properties"]["aca_name"] for f in features if f["properties"]["council"] == "kildare"][:6])
kf = [f for f in features if f["properties"]["council"] == "kildare"]
if kf:
    c = kf[0]["geometry"]["coordinates"]
    while isinstance(c[0], list):
        c = c[0]
    print("kildare first coord (should be ~ -6.6..-7.1 lon, 52.9..53.5 lat):", c)
import os
print("size:", round(os.path.getsize("aca.geojson") / 1024), "KB")
