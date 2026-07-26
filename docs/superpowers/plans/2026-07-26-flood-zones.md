# Flood Zones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the flood extents map layer and per-application flood zone lookup using static OPW open data, replacing the dead third-party ArcGIS service.

**Architecture:** Download OPW NIFM (fluvial) and NICM (coastal) national flood extent shapefiles from data.gov.ie, simplify into a single static GeoJSON file served from `web/public/`. The frontend loads it once and uses it for both the map overlay and client-side point-in-polygon lookups in the detail panel. All server-side flood code is removed.

**Tech Stack:** Node.js build script (shapefile parsing, mapshaper simplification), MapLibre GL JS (map overlay), @turf/boolean-point-in-polygon (detail panel lookup)

## Global Constraints

- Dual backend: every server-side change must be applied to BOTH `server/src/*.ts` (Fastify) and `api/index.mjs` (Vercel handler)
- npm, not yarn/bun
- npm registry is firewalled locally — `web/` has no node_modules; verify frontend via Vercel builds
- `search.test.ts` always fails locally (better-sqlite3 missing) — pre-existing, ignore
- The planning agent loses the `get_flood_risk` tool — flood data becomes map/UI only. The agent can still reference zoning, but cannot programmatically answer "is this in a flood zone?" This is an acceptable trade-off given the tool was already broken.

---

### Task 1: Discover and download OPW flood data

**Files:**
- Create: `scripts/flood/download.sh`
- Create: `scripts/flood/README.md`

**Interfaces:**
- Consumes: nothing
- Produces: Raw shapefiles in `scripts/flood/data/` (NIFM fluvial + NICM coastal .shp/.dbf/.prj files), and documented download URLs in README

This task is a prerequisite — the build script cannot be written without knowing the exact URLs, file format, and attribute schema.

- [ ] **Step 1: Search data.gov.ie for OPW flood datasets**

Open https://data.gov.ie and search for "NIFM" and "NICM" flood extents. The OPW publishes national indicative flood mapping under these names:
- NIFM = National Indicative Fluvial Mapping (river flooding)
- NICM = National Indicative Coastal Mapping (coastal flooding)

Also check https://catalogue.floodinfo.ie if data.gov.ie doesn't have direct shapefile downloads.

Look for downloadable shapefiles (`.shp` + `.dbf` + `.prj`) or GeoJSON. Record the exact download URLs.

- [ ] **Step 2: Download the shapefiles**

```bash
mkdir -p scripts/flood/data
cd scripts/flood/data

# Download NIFM (fluvial) — replace URLs with actual ones found in Step 1
curl -L -o nifm.zip "<NIFM_DOWNLOAD_URL>"
unzip nifm.zip -d nifm

# Download NICM (coastal)
curl -L -o nicm.zip "<NICM_DOWNLOAD_URL>"
unzip nicm.zip -d nicm
```

- [ ] **Step 3: Inspect the attribute schema**

```bash
# Use ogrinfo if available, or open the .dbf in a text editor
# Record which fields contain scenario/probability/flood-type info
# Expected fields (from the old code): Probability, Scenario, AEP, Flood_Zone, Flood_Type
```

Document the actual field names — the build script's label extraction depends on this.

- [ ] **Step 4: Write download.sh**

Create `scripts/flood/download.sh` that automates the download for reproducibility:

```bash
#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
DATA="$DIR/data"
mkdir -p "$DATA"

echo "Downloading NIFM (fluvial)..."
curl -L -o "$DATA/nifm.zip" "<NIFM_URL>"
unzip -o "$DATA/nifm.zip" -d "$DATA/nifm"

echo "Downloading NICM (coastal)..."
curl -L -o "$DATA/nicm.zip" "<NICM_URL>"
unzip -o "$DATA/nicm.zip" -d "$DATA/nicm"

echo "Done. Run build.mjs next."
```

- [ ] **Step 5: Write README.md documenting the sources**

Create `scripts/flood/README.md`:

```markdown
# Flood Zone Data

Source: OPW (Office of Public Works) national indicative flood mapping.

## Datasets
- **NIFM** (National Indicative Fluvial Mapping): river flood extents
  - URL: <actual URL>
  - Licence: <licence>
- **NICM** (National Indicative Coastal Mapping): coastal flood extents
  - URL: <actual URL>
  - Licence: <licence>

## Pipeline
1. `./download.sh` — fetches raw shapefiles to `data/`
2. `node build.mjs` — converts, simplifies, merges → `../../web/public/flood.geojson`

## Attribute schema
<document the actual fields found in Step 3>
```

- [ ] **Step 6: Add `scripts/flood/data/` to .gitignore**

```bash
echo "scripts/flood/data/" >> .gitignore
```

- [ ] **Step 7: Commit**

```bash
git add scripts/flood/download.sh scripts/flood/README.md .gitignore
git commit -m "feat(flood): download script and data source documentation"
```

---

### Task 2: Build script — shapefile to simplified GeoJSON

**Files:**
- Create: `scripts/flood/build.mjs`
- Create: `web/public/flood.geojson` (output)

**Interfaces:**
- Consumes: Raw shapefiles in `scripts/flood/data/` from Task 1
- Produces: `web/public/flood.geojson` — a FeatureCollection where each feature has properties `{ flood_type: "fluvial" | "coastal", scenario: string }`

**Dependencies:** Install `shapefile` and `mapshaper` as devDependencies in the root package.json (the build script runs at build time, not in the browser).

- [ ] **Step 1: Install build dependencies**

```bash
npm install --save-dev shapefile mapshaper
```

- [ ] **Step 2: Write the build script**

Create `scripts/flood/build.mjs`:

```js
import { open } from "shapefile";
import mapshaper from "mapshaper";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { globSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../../web/public/flood.geojson");

const SCENARIO_FIELDS = [
  "Probability", "PROBABILITY", "Scenario", "SCENARIO", "AEP",
  "Flood_Zone", "FLOOD_ZONE", "FloodZone", "Flood_Type", "FLOOD_TYPE",
  "Type", "TYPE", "Likelihood", "Event", "Class",
  "Descriptor", "DESCRIPT", "Description", "DESCRIPTION",
];

function extractScenario(props) {
  for (const f of SCENARIO_FIELDS) {
    const v = props[f];
    if (typeof v === "string" && v.trim() && v.trim().length <= 60) return v.trim();
  }
  return null;
}

async function readShapefile(path, floodType) {
  const source = await open(path);
  const features = [];
  let rec;
  while ((rec = await source.read()) && !rec.done) {
    const f = rec.value;
    f.properties = {
      flood_type: floodType,
      scenario: extractScenario(f.properties) ?? `${floodType} flood extent`,
    };
    features.push(f);
  }
  return features;
}

// Find .shp files in each dataset directory
import { readdirSync } from "fs";

function findShp(dir) {
  const files = readdirSync(dir, { recursive: true });
  const shp = files.find((f) => f.toString().endsWith(".shp"));
  if (!shp) throw new Error(`No .shp found in ${dir}`);
  return resolve(dir, shp.toString());
}

const DATA = resolve(__dirname, "data");

console.log("Reading NIFM (fluvial)...");
const fluvial = await readShapefile(findShp(resolve(DATA, "nifm")), "fluvial");
console.log(`  ${fluvial.length} features`);

console.log("Reading NICM (coastal)...");
const coastal = await readShapefile(findShp(resolve(DATA, "nicm")), "coastal");
console.log(`  ${coastal.length} features`);

const merged = {
  type: "FeatureCollection",
  features: [...fluvial, ...coastal],
};

console.log(`Total features before simplification: ${merged.features.length}`);

// Simplify with mapshaper — the percentage may need tuning based on output size
const simplified = await mapshaper.applyCommands(
  `-i input.geojson -simplify dp 10% keep-shapes -o output.geojson format=geojson precision=0.00001`,
  { "input.geojson": merged }
);

const output = JSON.parse(simplified["output.geojson"]);
const json = JSON.stringify(output);
writeFileSync(OUT, json);

const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
console.log(`Output: ${output.features.length} features, ${sizeMB} MB`);
console.log(`Written to ${OUT}`);

if (parseFloat(sizeMB) > 3) {
  console.warn("⚠ File exceeds 3 MB — consider increasing simplification or switching to vector tiles");
}
```

- [ ] **Step 3: Run the build script**

```bash
node scripts/flood/build.mjs
```

Check the output size. If over 3 MB, increase simplification (lower the percentage). If under ~500 KB, decrease simplification for better fidelity.

- [ ] **Step 4: Verify the output GeoJSON**

```bash
# Quick sanity check
node -e "const fc = JSON.parse(require('fs').readFileSync('web/public/flood.geojson','utf8')); console.log('features:', fc.features.length); console.log('types:', [...new Set(fc.features.map(f=>f.properties.flood_type))]); console.log('sample:', fc.features[0].properties);"
```

Expected: features count > 0, types includes both "fluvial" and "coastal", each feature has `flood_type` and `scenario` properties.

- [ ] **Step 5: Commit**

```bash
git add scripts/flood/build.mjs web/public/flood.geojson
git commit -m "feat(flood): build script and generated flood.geojson"
```

---

### Task 3: Frontend — add flood overlay to map

**Files:**
- Modify: `web/src/components/MapView.tsx`

**Interfaces:**
- Consumes: `web/public/flood.geojson` from Task 2 (fetched at runtime via `fetch("/flood.geojson")`)
- Produces: `floodDataRef` — a `useRef<GeoJSON.FeatureCollection | null>` that the detail panel (Task 4) will read for point-in-polygon lookups. Export a module-level cache so DetailPanel can import it.

Actually, since MapView and DetailPanel are sibling components, the flood data cache should be a shared module. Create a small shared module for this.

**Files (revised):**
- Create: `web/src/floodData.ts`
- Modify: `web/src/components/MapView.tsx`

- [ ] **Step 1: Create the shared flood data module**

Create `web/src/floodData.ts`:

```ts
let cache: GeoJSON.FeatureCollection | null = null;
let pending: Promise<GeoJSON.FeatureCollection | null> | null = null;

export function getFloodData(): Promise<GeoJSON.FeatureCollection | null> {
  if (cache) return Promise.resolve(cache);
  if (pending) return pending;
  pending = fetch("/flood.geojson")
    .then((res) => {
      if (!res.ok) return null;
      return res.json() as Promise<GeoJSON.FeatureCollection>;
    })
    .then((fc) => {
      cache = fc;
      return fc;
    })
    .catch(() => null);
  return pending;
}
```

- [ ] **Step 2: Add flood to OverlayKey and OVERLAY_STYLE**

In `web/src/components/MapView.tsx`, update the type and style config:

```ts
type OverlayKey = "zoning" | "conservation" | "archaeology" | "aca" | "flood";
const OVERLAY_STYLE: Record<OverlayKey, { fill: string; fillOpacity: number; line: string; label: string }> = {
  flood: { fill: "#3b82f6", fillOpacity: 0.25, line: "#1e40af", label: "Flood zones (indicative)" },
  aca: { fill: "#b45a2d", fillOpacity: 0.3, line: "#8a3f1d", label: "Architectural Conservation Areas" },
  conservation: { fill: "#2e8f5b", fillOpacity: 0.22, line: "#1d6b41", label: "Natural heritage (SAC · SPA · NHA)" },
  archaeology: { fill: "#8e6bbf", fillOpacity: 0.28, line: "#67479a", label: "Archaeological zones" },
  zoning: { fill: "#14b8a6", fillOpacity: 0.22, line: "#0f766e", label: "Zoning" },
};
```

- [ ] **Step 3: Add flood to overlay state and refs**

Update the `useState` and `useRef` initialisers to include `flood`:

```ts
const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>({
  zoning: false, conservation: false, archaeology: false, aca: false, flood: false,
});
const seqRef = useRef<Record<OverlayKey, number>>({
  zoning: 0, conservation: 0, archaeology: 0, aca: 0, flood: 0,
});
```

- [ ] **Step 4: Handle flood in applyOverlay like ACA (static, load-once)**

In the `applyOverlay` function, add a flood branch alongside the ACA branch. Both are static layers loaded once:

```ts
if (layer === "aca" || layer === "flood") {
  if (!enabled) return;
  const dataRef = layer === "aca" ? acaDataRef : floodDataRef;
  if (!dataRef.current) {
    const seq = ++seqRef.current[layer];
    try {
      const fc = layer === "aca"
        ? await fetch("/aca.geojson").then((r) => r.ok ? r.json() as Promise<GeoJSON.FeatureCollection> : null)
        : await getFloodData();
      if (!fc) return;
      dataRef.current = fc;
      if (seq !== seqRef.current[layer]) return;
    } catch {
      return;
    }
  }
  (mapRef.current?.getSource(`ov-${layer}`) as maplibregl.GeoJSONSource | undefined)?.setData(
    dataRef.current as never
  );
  return;
}
```

Add the ref:

```ts
const floodDataRef = useRef<GeoJSON.FeatureCollection | null>(null);
```

Also import `getFloodData` from `../floodData` and update `getFloodData` to write to `floodDataRef` (or vice versa — share the same cache).

- [ ] **Step 5: Add flood click popup**

In the click handler switch (the `map.on("click", ...)` block), add the flood case before the final `else` (zoning):

```ts
} else if (layer === "flood") {
  const type = String(pr.flood_type ?? "").trim();
  const scenario = String(pr.scenario ?? "").trim();
  const typeLabel = type === "coastal" ? "Coastal" : type === "fluvial" ? "Fluvial" : "Flood";
  html =
    `<div class="ov-popup"><div class="ov-pop-title"><strong>Flood zone</strong></div>` +
    `<span class="ov-pop-tag">${escapeHtml(typeLabel)}${scenario ? ` · ${escapeHtml(scenario)}` : ""}</span>` +
    `<span class="ov-pop-sub">Indicative — not a site-specific assessment</span>` +
    `<a class="ov-pop-sub" href="https://www.floodinfo.ie" target="_blank" rel="noopener">Details on floodinfo.ie</a>` +
    `</div>`;
}
```

- [ ] **Step 6: Update the zoom hint text**

The hint at line 463 says "Zoom in to load zoning and SAC layers" — flood doesn't need this hint since it's static (no zoom gate). Ensure the condition excludes flood:

```ts
{(overlays.zoning || overlays.conservation || overlays.archaeology) && mapZoom < MIN_OVERLAY_ZOOM && (
  <p className="overlay-hint">Zoom in to load zoning, heritage and archaeology layers</p>
)}
```

- [ ] **Step 7: Verify the map overlay works**

Run the dev server and:
1. Open the map
2. Click Layers → toggle "Flood zones (indicative)"
3. Verify blue polygons appear on the map
4. Click a flood polygon → verify popup shows "Flood zone" with type and scenario
5. Toggle off → polygons disappear
6. Toggle on again → polygons reappear instantly (cached)

- [ ] **Step 8: Commit**

```bash
git add web/src/floodData.ts web/src/components/MapView.tsx
git commit -m "feat(flood): add flood zones overlay to map"
```

---

### Task 4: Frontend — client-side flood zone lookup in detail panel

**Files:**
- Modify: `web/src/components/DetailPanel.tsx`

**Interfaces:**
- Consumes: `getFloodData()` from `web/src/floodData.ts` (Task 3), `@turf/boolean-point-in-polygon`
- Produces: Updated "Flood zone" row in the detail panel showing whether the application is within a flood zone

- [ ] **Step 1: Install turf dependency**

```bash
cd web && npm install @turf/boolean-point-in-polygon @turf/helpers
```

- [ ] **Step 2: Replace server call with client-side lookup**

In `DetailPanel.tsx`, replace the flood fetch block (lines ~1103-1110):

Old code:
```ts
api
  .flood(d.id)
  .then((res) => {
    if (!cancelled) setFlood(res.flood ?? "none");
  })
  .catch(() => {
    if (!cancelled) setFlood("none");
  });
```

New code:
```ts
import { getFloodData } from "../floodData";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point as turfPoint } from "@turf/helpers";

// ... inside the useEffect:
getFloodData()
  .then((fc) => {
    if (cancelled || !fc || d.lat == null || d.lng == null) {
      if (!cancelled) setFlood("none");
      return;
    }
    const pt = turfPoint([d.lng, d.lat]);
    const hits = fc.features.filter(
      (f) =>
        (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") &&
        booleanPointInPolygon(pt, f as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>)
    );
    if (hits.length === 0) {
      if (!cancelled) setFlood({ at_risk: false, scenarios: [] });
      return;
    }
    const scenarios = [
      ...new Set(
        hits
          .map((f) => String((f.properties as Record<string, unknown>)?.scenario ?? "").trim())
          .filter(Boolean)
      ),
    ];
    if (!cancelled) setFlood({ at_risk: true, scenarios });
  })
  .catch(() => {
    if (!cancelled) setFlood("none");
  });
```

- [ ] **Step 3: Update the label and display text**

Change the `<dt>` from "Flood risk" to "Flood zone" (line ~934):

```tsx
<dt>Flood zone</dt>
```

Update the display text (line ~941-943):

```tsx
flood.at_risk ? (
  <span className="flood-warn-inline">
    Within a mapped flood zone
    {flood.scenarios.length > 0 && ` — ${flood.scenarios.join("; ")}`}
  </span>
) : (
  "Not within a mapped flood zone"
)
```

- [ ] **Step 4: Verify the detail panel**

1. Click an application in a known flood area (e.g. near a river in Dublin)
2. Check the "Flood zone" row shows "Within a mapped flood zone" with scenario
3. Click an application far from any flood zone
4. Check it shows "Not within a mapped flood zone"
5. Verify the "Checking..." loading state appears briefly while the data loads

- [ ] **Step 5: Commit**

```bash
git add web/src/components/DetailPanel.tsx web/package.json
git commit -m "feat(flood): client-side flood zone lookup in detail panel"
```

---

### Task 5: Remove server-side flood code

**Files:**
- Delete: `server/src/flood.ts`
- Modify: `server/src/overlays.ts`
- Modify: `server/src/api.ts` (the Fastify routes file)
- Modify: `server/src/agent/execute.ts`
- Modify: `server/src/agent/tools.ts`
- Modify: `api/index.mjs`
- Modify: `web/src/api.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: Cleaned codebase with no server-side flood code

- [ ] **Step 1: Delete server/src/flood.ts**

```bash
rm server/src/flood.ts
```

- [ ] **Step 2: Remove flood from server/src/overlays.ts**

Remove the `FLOOD_URL` import (line 8):
```ts
// DELETE: import { FLOOD_URL } from "./flood.js";
```

Remove `"flood"` from the `OverlayLayer` type (line 35):
```ts
export type OverlayLayer = "zoning" | "conservation" | "archaeology";
```

Remove the `flood` entry from `OVERLAYS` (line 45):
```ts
const OVERLAYS: Record<Exclude<OverlayLayer, "conservation">, OverlayConfig> = {
  zoning: { url: GZT_URL, where: "CURRENT_PLAN=1", outFields: "ZONE_ORIG,ZONE_DESC,GZT_DESC,PLAN_NAME" },
  archaeology: { url: SMR_ZONE_URL, where: "1=1", outFields: "ZONE_ID" },
};
```

Remove `FLOOD_SCENARIO_FIELDS`, `floodLabel` function (lines 71-82).

Remove the `flood` branch from `transformFeatures` (the `else` at line 110-112 that sets `flood_label`). The remaining else should be the archaeology branch — but check the logic: zoning, conservation, archaeology are the three remaining cases. The final else should handle archaeology or be removed if archaeology already has its own branch.

Update `isOverlayLayer` (line 124-126):
```ts
export function isOverlayLayer(v: string): v is OverlayLayer {
  return v === "zoning" || v === "conservation" || v === "archaeology";
}
```

- [ ] **Step 3: Remove flood from server/src/api.ts (Fastify routes)**

Remove the `fetchFlood` import (line 37):
```ts
// DELETE: import { fetchFlood } from "./flood.js";
```

Remove the `/api/applications/:id/flood` route (lines ~565-577).

Update the overlays route comment (line ~579) to not mention flood.

- [ ] **Step 4: Remove flood from server/src/agent/execute.ts**

Remove the `fetchFlood` import (line 5):
```ts
// DELETE: import { fetchFlood } from "../flood.js";
```

Remove `fetchFlood` from the `ToolDeps` interface (line 15) and `REAL_DEPS` object (line 25).

Remove the `case "get_flood_risk"` block (lines ~135-139).

- [ ] **Step 5: Remove get_flood_risk from server/src/agent/tools.ts**

Remove the tool definition object (lines ~126-133):
```ts
// DELETE the entire { name: "get_flood_risk", ... } object from the tools array
```

- [ ] **Step 6: Remove flood from api/index.mjs**

This is the Vercel handler mirror. Remove:
- `FLOOD_CACHE`, `FLOOD_URL`, `FLOOD_SCENARIO_FIELDS`, `FLOOD_SCENARIO_KEY_RE` declarations (lines ~761-771)
- `floodScenarioLabel` function (lines ~772-783)
- `fetchFlood` function (lines ~784-828)
- `flood` entry from the overlays config object (line ~851)
- `OV_FLOOD_FIELDS` and `ovFloodLabel` function (lines ~871-882)
- The flood branch in the overlay transform (line ~905)
- `get_flood_risk` from the agent tools array (line ~1883-1885)
- `case "get_flood_risk"` from the agent execute switch (line ~2057)
- The `/api/applications/:id/flood` route handler (lines ~2437-2446)
- Update the `/api/overlays/` route regex to not match `flood` (line ~2449):
  ```js
  const om = route.match(/^\/api\/overlays\/(zoning|conservation|archaeology)$/);
  ```

- [ ] **Step 7: Remove api.flood() from web/src/api.ts**

Remove the `flood` method (lines 263-267):
```ts
// DELETE:
// flood: (id: number) =>
//   getJson<{ ... }>(`/api/applications/${id}/flood`),
```

Update the `overlay` method's type to remove `"flood"` from the layer union (line 308):
```ts
overlay: (layer: "zoning" | "conservation" | "archaeology", bbox: [number, number, number, number]) =>
```

- [ ] **Step 8: Run server tests**

```bash
cd server && npx vitest run
```

Expect `search.test.ts` to fail (pre-existing). All other tests should pass. If `agent-tools.test.ts` references `get_flood_risk`, update it to remove those test cases.

- [ ] **Step 9: Commit**

```bash
git add -u
git commit -m "refactor(flood): remove server-side flood code

Flood data is now served as static GeoJSON and queried client-side.
The planning agent's get_flood_risk tool is removed — flood info is
now visual-only (map layer + detail panel)."
```

---

### Task 6: Update backlog and verify end-to-end

**Files:**
- Modify: `docs/BACKLOG.md`

**Interfaces:**
- Consumes: All prior tasks
- Produces: Updated backlog, verified feature

- [ ] **Step 1: Update the backlog**

Replace the flood extents backlog item (lines ~223-234) with a completion note and a conditional follow-up:

```markdown
- **Flood zones layer rebuilt from OPW open data (2026-07).**
  Static GeoJSON baked from NIFM (fluvial) + NICM (coastal) shapefiles,
  client-side overlay and point-in-polygon lookup. If the file size
  impacts initial load, convert to PMTiles vector tiles.
```

- [ ] **Step 2: End-to-end verification**

Test the full flow:
1. Load the app — verify no errors in console related to flood
2. Open Layers → toggle "Flood zones (indicative)" → blue polygons appear
3. Click a flood polygon → popup shows flood zone type and scenario
4. Click an application near a river → detail panel "Flood zone" row shows "Within a mapped flood zone"
5. Click an application in a non-flood area → shows "Not within a mapped flood zone"
6. Toggle flood layer off and on → data reloads from cache instantly
7. Verify no remaining references to the old ArcGIS flood URL:
   ```bash
   grep -r "services7.arcgis.com" --include="*.ts" --include="*.tsx" --include="*.mjs"
   ```
   Should return no results.

- [ ] **Step 3: Commit**

```bash
git add docs/BACKLOG.md
git commit -m "docs: update backlog — flood zones complete, add tiling follow-up"
```
