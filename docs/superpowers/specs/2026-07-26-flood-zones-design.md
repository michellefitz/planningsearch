# Flood Zones — Design Spec

## Summary

Rebuild the flood extents layer using OPW open data (NIFM fluvial + NICM coastal shapefiles from data.gov.ie), served as a static GeoJSON file. Replaces the dead third-party ArcGIS service. All flood logic moves client-side — both the map overlay and per-application flood zone lookups.

## Data Pipeline

A build script at `scripts/flood/build.mjs`:

1. Downloads NIFM (fluvial) and NICM (coastal) shapefiles from data.gov.ie
2. Converts shapefile → GeoJSON via the `shapefile` npm package
3. Simplifies geometry with `mapshaper` (tolerance tuned to keep output under ~3MB)
4. Tags each feature with `flood_type: "fluvial" | "coastal"` and a `scenario` label extracted from source attributes
5. Merges both datasets into one FeatureCollection
6. Writes to `web/public/flood.geojson`
7. Logs feature count and file size

Follows the same pattern as the existing `scripts/aca/` pipeline.

## Frontend — Map Overlay

Add `"flood"` back to the `OverlayKey` type in `MapView.tsx`.

**Style:**
- Fill: `#3b82f6`, opacity 0.25
- Line: `#1e40af`
- Label in Layers box: "Flood zones (indicative)"

**Load pattern:** Identical to ACA — fetch `flood.geojson` once on first toggle, cache the response, reuse on subsequent toggles. No viewport queries, no zoom gate.

**Click popup:** Shows "Flood zone" heading with flood type (Fluvial/Coastal) and scenario label if present.

## Frontend — Detail Panel

Replace the server-side `/api/applications/:id/flood` call with a client-side point-in-polygon lookup:

- When the detail panel opens, check the application's lat/lng against the loaded `flood.geojson` using `@turf/boolean-point-in-polygon`
- If the flood GeoJSON hasn't loaded yet, fetch it on demand and cache it
- Point inside flood polygon(s): "Within a mapped flood zone" with scenario labels
- Point outside: "Not within a mapped flood zone"
- Retain the existing caveat and link to floodinfo.ie

**Naming:** "Flood zone" replaces "Flood risk" in the detail panel row label.

## Cleanup — Server-Side Removal

Remove all server-side flood code:

- Delete `server/src/flood.ts`
- Remove flood from `server/src/overlays.ts`: the `OVERLAYS.flood` config entry, `floodLabel` function, flood branch in `transformFeatures`, and `"flood"` from `OverlayLayer` type
- Remove flood from `api/index.mjs`: `fetchFlood` function, `FLOOD_CACHE`, flood overlay config, and the `/api/applications/:id/flood` route handler
- Remove `api.flood()` from `web/src/api.ts`
- Update agent tools if `get_flood_risk` references the old server endpoint
- Remove `PLANVIEW_FLOOD_URL` env var references

## Dependencies

New npm packages (dev, for the build script):
- `shapefile` — parse .shp/.dbf
- `mapshaper` — simplify geometry

New npm package (web):
- `@turf/boolean-point-in-polygon` — client-side flood zone lookup

## Risks

- **File size:** If the simplified national flood GeoJSON exceeds ~3MB, initial load could be impacted. Mitigation: aggressive simplification in the build script; add a tiling backlog item if needed.
- **data.gov.ie availability:** The shapefiles need to be downloadable. If the download URLs change, the build script breaks — but the last-built `flood.geojson` remains in the repo.
