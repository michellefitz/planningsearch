import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { STATUS_STYLE } from "../statusStyle";
import "maplibre-gl/dist/maplibre-gl.css";
import { api, type PointFeatureCollection } from "../api";
import { getFloodData } from "../floodData";
import { sheetFocusOffset } from "../sheetMetrics";

/** Constraint overlays sourced from ArcGIS as GeoJSON for the viewport.
    Flood zones rebuilt from OPW CFRAM shapefiles and served as a static file. */
type OverlayKey = "zoning" | "conservation" | "archaeology" | "aca" | "flood" | "rzlt" | "derelict";
const OVERLAY_STYLE: Record<OverlayKey, { fill: string; fillOpacity: number; line: string; label: string }> = {
  flood: { fill: "#3b82f6", fillOpacity: 0.25, line: "#1e40af", label: "Flood zones (indicative)" },
  aca: { fill: "#b45a2d", fillOpacity: 0.3, line: "#8a3f1d", label: "Architectural Conservation Areas" },
  // SAC + SPA + NHA + pNHA merged server-side; designations overlap, so the
  // fill is lighter than the single-designation layers.
  conservation: { fill: "#2e8f5b", fillOpacity: 0.22, line: "#1d6b41", label: "Natural heritage (SAC · SPA · NHA)" },
  archaeology: { fill: "#8e6bbf", fillOpacity: 0.28, line: "#67479a", label: "Archaeological zones" },
  zoning: { fill: "#14b8a6", fillOpacity: 0.22, line: "#0f766e", label: "Zoning" },
  rzlt: { fill: "#e11d48", fillOpacity: 0.25, line: "#be123c", label: "RZLT (vacant/idle land)" },
  derelict: { fill: "#991b1b", fillOpacity: 0.35, line: "#7f1d1d", label: "Derelict sites" },
};
// Overlays are only meaningful (and light enough to fetch) when zoomed in.
const MIN_OVERLAY_ZOOM = 12;
const EMPTY_FC = { type: "FeatureCollection", features: [] } as const;

/** Generalised zoning groups (server-classified) → colour + label. */
const ZONE_GROUPS: Record<string, { color: string; label: string }> = {
  residential: { color: "#f59e0b", label: "Residential" },
  commercial: { color: "#ef4444", label: "Commercial / retail" },
  mixed: { color: "#f97316", label: "Mixed use" },
  industrial: { color: "#a855f7", label: "Industrial / employment" },
  community: { color: "#38bdf8", label: "Community / institutional" },
  open_space: { color: "#22c55e", label: "Open space / amenity" },
  agriculture: { color: "#84cc16", label: "Agricultural / rural" },
  infrastructure: { color: "#94a3b8", label: "Transport / utilities" },
  water: { color: "#06b6d4", label: "Water / marine" },
  other: { color: "#cbd5e1", label: "Other / unzoned" },
};
const escapeHtml = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Re-exported so existing map-side imports keep working; the definition
 *  lives outside this module so importing it doesn't pull in maplibre-gl. */
export { STATUS_STYLE };

const IRELAND_EAST_BOUNDS: [number, number, number, number] = [-7.2, 52.9, -5.9, 53.7];

/** Geodesic circle as a GeoJSON polygon — the alert-area preview. */
export function circlePolygon(lat: number, lng: number, radiusM: number, steps = 64): GeoJSON.Feature {
  const ring: [number, number][] = [];
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} };
}

export interface WatchCircle {
  lat: number;
  lng: number;
  radius_m: number;
  /** Draft mode: the centre pin can be dragged (and the map clicked) to move it. */
  draggable?: boolean;
}

interface Props {
  data: PointFeatureCollection | null;
  /** Site boundaries (id/status properties) shown on pin hover/selection. */
  polygons: GeoJSON.FeatureCollection | null;
  /** Alert-area preview: a circle plus (in draft mode) a draggable centre pin. */
  watchCircle?: WatchCircle | null;
  onWatchMove?: (lat: number, lng: number) => void;
  /** Watch-creation mode: hide the application pins so the circle is the map's
      only subject. */
  hideApps?: boolean;
  selectedId: number | null;
  hoveredId: number | null;
  onSelect: (id: number) => void;
  onBoundsChange: (bbox: [number, number, number, number]) => void;
  /** Fired only on a user-driven pan/zoom (not programmatic flyTo). */
  onUserMove?: () => void;
  /** `avoidSheet` centres the point in the map area the detail sheet does
   *  not cover, rather than in the middle of the canvas. */
  flyTo?: { lat: number; lng: number; zoom?: number; avoidSheet?: boolean } | null;
}

export default function MapView({
  data,
  polygons,
  watchCircle,
  onWatchMove,
  hideApps,
  selectedId,
  hoveredId,
  onSelect,
  onBoundsChange,
  onUserMove,
  flyTo,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loadedRef = useRef(false);
  // Kept in refs so the mount-time moveend handlers always call the latest.
  // onBoundsChange especially: the first-render closure holds the initial
  // (unfiltered) search state, so calling it stale refetched pins with every
  // filter dropped on each pan/zoom.
  const onUserMoveRef = useRef(onUserMove);
  onUserMoveRef.current = onUserMove;
  const onBoundsChangeRef = useRef(onBoundsChange);
  onBoundsChangeRef.current = onBoundsChange;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onWatchMoveRef = useRef(onWatchMove);
  onWatchMoveRef.current = onWatchMove;
  const watchCircleRef = useRef(watchCircle);
  watchCircleRef.current = watchCircle;
  const watchMarkerRef = useRef<maplibregl.Marker | null>(null);
  // Map-side pin hover (distinct from list hover, which arrives as a prop).
  const mapHoverIdRef = useRef<number | null>(null);
  const setMapHover = (map: maplibregl.Map, id: number | null) => {
    const prev = mapHoverIdRef.current;
    if (prev != null && prev !== id) {
      map.setFeatureState({ source: "apps", id: prev }, { hovered: false });
      map.setFeatureState({ source: "site-polygons", id: prev }, { hovered: false });
    }
    if (id != null) {
      map.setFeatureState({ source: "apps", id }, { hovered: true });
      map.setFeatureState({ source: "site-polygons", id }, { hovered: true });
    }
    mapHoverIdRef.current = id;
  };

  // Latest props, readable from the map's load handler — which closes over the
  // mount-time values (the init effect runs once) and so can't see them.
  const dataRef = useRef(data);
  dataRef.current = data;
  const polygonsRef = useRef(polygons);
  polygonsRef.current = polygons;
  const prevState = useRef<{ selected: number | null; hovered: number | null }>({
    selected: null,
    hovered: null,
  });
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const hoveredIdRef = useRef(hoveredId);
  hoveredIdRef.current = hoveredId;

  /**
   * Mirror hover/selection onto both sources, so a list hover or an open sheet
   * outlines the site the same way hovering the pin does. The boundary layers
   * paint at zero opacity until their feature carries this state.
   *
   * Called from the selection effect and again from the map's load handler: an
   * application can already be selected before the style finishes loading (a
   * shared /application/… URL selects during the first render), and state set
   * before the sources exist is dropped. The effect can't cover that — it is
   * keyed on the ids, which don't change again afterwards, so the boundary and
   * the selected pin would stay invisible for the whole session.
   */
  const applyActiveState = (map: maplibregl.Map) => {
    const { selected, hovered } = prevState.current;
    const nextSelected = selectedIdRef.current;
    const nextHovered = hoveredIdRef.current;
    for (const source of ["apps", "site-polygons"]) {
      if (selected != null) map.setFeatureState({ source, id: selected }, { selected: false });
      if (hovered != null) map.setFeatureState({ source, id: hovered }, { hovered: false });
      if (nextSelected != null) map.setFeatureState({ source, id: nextSelected }, { selected: true });
      if (nextHovered != null) map.setFeatureState({ source, id: nextHovered }, { hovered: true });
    }
    prevState.current = { selected: nextSelected, hovered: nextHovered };
  };
  const applyActiveStateRef = useRef(applyActiveState);
  applyActiveStateRef.current = applyActiveState;

  const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>({ zoning: false, conservation: false, archaeology: false, aca: false, flood: false, rzlt: false, derelict: false });
  const [layersOpen, setLayersOpen] = useState(false);
  const [mapZoom, setMapZoom] = useState(7);
  const overlaysRef = useRef(overlays);
  overlaysRef.current = overlays;
  const bboxRef = useRef<[number, number, number, number] | null>(null);
  const zoomRef = useRef(7);
  const seqRef = useRef<Record<OverlayKey, number>>({ zoning: 0, conservation: 0, archaeology: 0, aca: 0, flood: 0, rzlt: 0, derelict: 0 });
  // Static overlay layers — fetched at most once, then reused.
  const acaDataRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const floodDataRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const derelictDataRef = useRef<GeoJSON.FeatureCollection | null>(null);
  // The flood file is large (~5 MB gzipped) — surface its fetch in the UI.
  const [floodLoading, setFloodLoading] = useState(false);
  // Latest overlay-refresh closure, so the map's one-off event handlers can
  // always call the current version (which reads live state via refs).
  const applyRef = useRef<(layer: OverlayKey) => void>(() => {});

  const applyOverlay = async (layer: OverlayKey) => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const enabled = overlaysRef.current[layer];
    const vis = enabled ? "visible" : "none";
    for (const id of [`ov-${layer}-fill`, `ov-${layer}-line`]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
    }
    const src = map.getSource(`ov-${layer}`) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    // Static layers: one file each, no viewport queries or zoom gate.
    if (layer === "aca" || layer === "flood" || layer === "derelict") {
      if (!enabled) return;
      const dataRef = layer === "aca" ? acaDataRef : layer === "flood" ? floodDataRef : derelictDataRef;
      if (!dataRef.current) {
        const seq = ++seqRef.current[layer];
        if (layer === "flood") setFloodLoading(true);
        try {
          const fc = layer === "flood"
            ? await getFloodData()
            : await fetch(layer === "aca" ? "/aca.geojson" : "/derelict.geojson").then((r) => r.ok ? r.json() as Promise<GeoJSON.FeatureCollection> : null);
          if (!fc) return;
          dataRef.current = fc;
          if (seq !== seqRef.current[layer]) return;
        } catch {
          return;
        } finally {
          if (layer === "flood") setFloodLoading(false);
        }
      }
      (mapRef.current?.getSource(`ov-${layer}`) as maplibregl.GeoJSONSource | undefined)?.setData(
        dataRef.current as never
      );
      return;
    }
    if (!enabled || !bboxRef.current || zoomRef.current < MIN_OVERLAY_ZOOM) {
      src.setData(EMPTY_FC as never);
      return;
    }
    const seq = ++seqRef.current[layer];
    try {
      const fc = await api.overlay(layer, bboxRef.current);
      if (seq === seqRef.current[layer] && mapRef.current) {
        (mapRef.current.getSource(`ov-${layer}`) as maplibregl.GeoJSONSource | undefined)?.setData(fc as never);
      }
    } catch {
      /* leave the layer as-is on a failed fetch */
    }
  };
  applyRef.current = applyOverlay;

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
      bounds: IRELAND_EAST_BOUNDS,
      fitBoundsOptions: { padding: 24 },
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(
      new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }),
      "top-right"
    );

    map.on("load", () => {
      // Constraint overlays first, so application pins always draw on top.
      const zoneColorExpr = [
        "match",
        ["get", "zone_group"],
        ...Object.entries(ZONE_GROUPS).flatMap(([k, v]) => [k, v.color]),
        ZONE_GROUPS.other.color,
      ] as unknown as maplibregl.ExpressionSpecification;
      // Flood probability bands nest (frequent inside rare), so opacity per
      // band accumulates toward the likely core: rare fringe stays light.
      const floodOpacityExpr = [
        "match",
        ["get", "band"],
        "high",
        0.32,
        "medium",
        0.2,
        0.1,
      ] as unknown as maplibregl.ExpressionSpecification;
      for (const layer of Object.keys(OVERLAY_STYLE) as OverlayKey[]) {
        const s = OVERLAY_STYLE[layer];
        map.addSource(`ov-${layer}`, { type: "geojson", data: EMPTY_FC as never });
        map.addLayer({
          id: `ov-${layer}-fill`,
          type: "fill",
          source: `ov-${layer}`,
          layout: { visibility: "none" },
          paint: {
            "fill-color": layer === "zoning" ? zoneColorExpr : s.fill,
            "fill-opacity": layer === "flood" ? floodOpacityExpr : s.fillOpacity,
          },
        });
        map.addLayer({
          id: `ov-${layer}-line`,
          type: "line",
          source: `ov-${layer}`,
          layout: { visibility: "none" },
          paint: { "line-color": s.line, "line-width": 0.8, "line-opacity": 0.7 },
        });

        // Click a polygon → info popup.
        map.on("click", `ov-${layer}-fill`, (e) => {
          const f = e.features?.[0];
          if (!f) return;
          const pr = f.properties ?? {};
          let html: string;
          if (layer === "aca") {
            html =
              `<div class="ov-popup"><div class="ov-pop-title"><strong>${escapeHtml(String(pr.aca_name ?? "Conservation area"))}</strong></div>` +
              `<span class="ov-pop-tag">${escapeHtml(String(pr.designation ?? "Architectural Conservation Area"))}</span>` +
              `<span class="ov-pop-sub">${escapeHtml(String(pr.council_label ?? ""))}${pr.ref ? ` · ${escapeHtml(String(pr.ref))}` : ""}</span>` +
              `</div>`;
          } else if (layer === "conservation") {
            const url = String(pr.site_url ?? "").trim();
            html =
              `<div class="ov-popup"><div class="ov-pop-title"><strong>${escapeHtml(String(pr.site_name ?? "Designated site"))}</strong></div>` +
              `<span class="ov-pop-tag">${escapeHtml(String(pr.designation ?? "Designated site"))}</span>` +
              (url.startsWith("https://")
                ? `<a class="ov-pop-sub" href="${escapeHtml(url)}" target="_blank" rel="noopener">Site details on npws.ie</a>`
                : "") +
              `</div>`;
          } else if (layer === "flood") {
            // The probability bands nest, so a click usually lands in several
            // features at once — list every band at this point, likeliest first.
            const bandRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
            const scenarios = Array.from(
              new Map(
                (e.features ?? []).map((ft) => {
                  const p = ft.properties ?? {};
                  return [String(p.scenario ?? "").trim(), String(p.band ?? "low")];
                })
              )
            )
              .filter(([sc]) => sc)
              .sort((a, b) => (bandRank[a[1]] ?? 3) - (bandRank[b[1]] ?? 3));
            html =
              `<div class="ov-popup"><div class="ov-pop-title"><strong>Flood zone</strong></div>` +
              scenarios.map(([sc]) => `<span class="ov-pop-tag">${escapeHtml(sc)}</span>`).join("") +
              `<span class="ov-pop-sub">Indicative — not a site-specific assessment</span>` +
              `<a class="ov-pop-sub" href="https://www.floodinfo.ie" target="_blank" rel="noopener">Details on floodinfo.ie</a>` +
              `</div>`;
          } else if (layer === "archaeology") {
            html =
              `<div class="ov-popup"><div class="ov-pop-title"><strong>Zone of Archaeological Notification</strong></div>` +
              `<span class="ov-pop-tag">Recorded monuments${pr.zone_ref ? ` · ${escapeHtml(String(pr.zone_ref))}` : ""}</span>` +
              `<span class="ov-pop-sub">Works here must be notified to the National Monuments Service</span>` +
              `<a class="ov-pop-sub" href="https://maps.archaeology.ie/historicenvironment/" target="_blank" rel="noopener">Details on maps.archaeology.ie</a>` +
              `</div>`;
          } else if (layer === "derelict") {
            const addr = String(pr.address ?? "").trim();
            const ref = String(pr.reference ?? "").trim();
            const council = String(pr.council_label ?? "").trim();
            const dateAdded = String(pr.date_added ?? "").trim();
            const valuation = String(pr.valuation ?? "").trim();
            const isProtected = pr.protected_structure;
            html =
              `<div class="ov-popup"><div class="ov-pop-title"><strong>${escapeHtml(addr || ref || "Derelict site")}</strong></div>` +
              `<span class="ov-pop-tag">Derelict Sites Register${ref ? ` · ${escapeHtml(ref)}` : ""}</span>` +
              (council ? `<span class="ov-pop-sub">${escapeHtml(council)}</span>` : "") +
              (dateAdded ? `<span class="ov-pop-sub">On register since ${escapeHtml(dateAdded)}</span>` : "") +
              (valuation ? `<span class="ov-pop-sub">Valuation: ${escapeHtml(valuation)}</span>` : "") +
              (isProtected ? `<span class="ov-pop-sub">Also a Protected Structure</span>` : "") +
              `</div>`;
          } else if (layer === "rzlt") {
            const parcel = String(pr.parcel_id ?? "").trim();
            const zoneDesc = String(pr.zone_desc ?? "").trim();
            const area = pr.area_ha != null ? `${pr.area_ha} ha` : "";
            const auth = String(pr.authority ?? "").trim();
            html =
              `<div class="ov-popup"><div class="ov-pop-title"><strong>RZLT parcel${parcel ? ` ${escapeHtml(parcel)}` : ""}</strong></div>` +
              `<span class="ov-pop-tag">Residential Zoned Land Tax</span>` +
              (zoneDesc ? `<span class="ov-pop-sub">${escapeHtml(zoneDesc)}</span>` : "") +
              (area || auth ? `<span class="ov-pop-sub">${escapeHtml([area, auth].filter(Boolean).join(" · "))}</span>` : "") +
              `<span class="ov-pop-sub">Vacant/idle serviced land liable for RZLT</span>` +
              `</div>`;
          } else {
            const code = String(pr.zone_code ?? "").trim();
            const name = String(pr.zone_label ?? "").trim();
            const general = String(pr.zone_general ?? "").trim();
            // "Z1: Sustainable Residential Neighbourhoods"
            const head = code && name && name.toLowerCase() !== code.toLowerCase() ? `${code}: ${name}` : name || code || "Zone";
            const showGeneral = general && general.toLowerCase() !== name.toLowerCase();
            html =
              `<div class="ov-popup"><div class="ov-pop-title"><strong>${escapeHtml(head)}</strong>` +
              (showGeneral ? `<span class="ov-pop-gen"> · ${escapeHtml(general)}</span>` : "") +
              `</div><span class="ov-pop-tag">${escapeHtml(ZONE_GROUPS[pr.zone_group as string]?.label ?? "Zoning")}</span>` +
              (pr.plan ? `<span class="ov-pop-sub">${escapeHtml(pr.plan)}</span>` : "") +
              `</div>`;
          }
          new maplibregl.Popup({ closeButton: true, maxWidth: "260px" })
            .setLngLat(e.lngLat)
            .setHTML(html)
            .addTo(map);
        });
        map.on("mouseenter", `ov-${layer}-fill`, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", `ov-${layer}-fill`, () => (map.getCanvas().style.cursor = ""));
      }

      // Alert-area preview (watch creation and "view watch"): one circle.
      map.addSource("watch-circle", { type: "geojson", data: EMPTY_FC as never });
      map.addLayer({
        id: "watch-circle-fill",
        type: "fill",
        source: "watch-circle",
        paint: { "fill-color": "#0b62d6", "fill-opacity": 0.1 },
      });
      map.addLayer({
        id: "watch-circle-line",
        type: "line",
        source: "watch-circle",
        paint: { "line-color": "#0b62d6", "line-width": 2, "line-dasharray": [2, 1.5] },
      });
      // In draft mode a map click moves the centre — dragging the pin is
      // fiddly on touch screens; tapping where you mean is not.
      map.on("click", (e) => {
        if (!watchCircleRef.current?.draggable || !onWatchMoveRef.current) return;
        const hitPin = map.queryRenderedFeatures(e.point, { layers: ["pins", "clusters"] }).length > 0;
        if (!hitPin) onWatchMoveRef.current(e.lngLat.lat, e.lngLat.lng);
      });

      // Site boundaries, revealed per-application on pin hover/selection —
      // always-on polygons read as visual noise, and a boundary with no pin
      // context answers nothing. Added before the pin layers so pins stay on
      // top of their own outline.
      map.addSource("site-polygons", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      const activeExpr = [
        "any",
        ["boolean", ["feature-state", "selected"], false],
        ["boolean", ["feature-state", "hovered"], false],
      ] as unknown as maplibregl.ExpressionSpecification;
      map.addLayer({
        id: "site-fill",
        type: "fill",
        source: "site-polygons",
        paint: {
          "fill-color": "#1e3a5f",
          "fill-opacity": ["case", activeExpr, 0.14, 0],
        },
      });
      map.addLayer({
        id: "site-outline",
        type: "line",
        source: "site-polygons",
        paint: {
          "line-color": "#1e3a5f",
          "line-width": 2.5,
          "line-opacity": ["case", activeExpr, 0.95, 0],
        },
      });

      map.addSource("apps", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterMaxZoom: 13,
        clusterRadius: 45,
        promoteId: "id",
      });

      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "apps",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#1e3a5f",
          "circle-opacity": 0.85,
          "circle-radius": ["step", ["get", "point_count"], 16, 25, 22, 100, 30],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "apps",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 13,
          "text-font": ["Noto Sans Regular"],
        },
        paint: { "text-color": "#ffffff" },
      });

      const colorExpr = [
        "match",
        ["get", "status"],
        ...Object.entries(STATUS_STYLE).flatMap(([k, v]) => [k, v.color]),
        "#64748b",
      ] as unknown as maplibregl.ExpressionSpecification;

      map.addLayer({
        id: "pins",
        type: "circle",
        source: "apps",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": colorExpr,
          "circle-radius": [
            "case",
            ["boolean", ["feature-state", "selected"], false], 11,
            ["boolean", ["feature-state", "hovered"], false], 10,
            8,
          ],
          "circle-stroke-width": [
            "case",
            ["boolean", ["feature-state", "selected"], false], 3,
            2,
          ],
          "circle-stroke-color": [
            "case",
            ["boolean", ["feature-state", "selected"], false], "#0f172a",
            "#ffffff",
          ],
        },
      });
      map.addLayer({
        id: "pin-letters",
        type: "symbol",
        source: "apps",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "text-field": [
            "match",
            ["get", "status"],
            ...Object.entries(STATUS_STYLE).flatMap(([k, v]) => [k, v.letter]),
            "?",
          ] as unknown as maplibregl.ExpressionSpecification,
          "text-size": 10,
          "text-font": ["Noto Sans Regular"],
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#ffffff" },
      });

      map.on("click", "clusters", async (e) => {
        const feature = map.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
        const clusterId = feature.properties?.cluster_id;
        const source = map.getSource("apps") as maplibregl.GeoJSONSource;
        const zoom = await source.getClusterExpansionZoom(clusterId);
        map.easeTo({ center: (feature.geometry as any).coordinates, zoom });
      });
      map.on("click", "pins", (e) => {
        const f = e.features?.[0];
        if (f?.properties?.id != null) onSelectRef.current(Number(f.properties.id));
      });
      for (const layer of ["pins", "clusters"]) {
        map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
      }
      // Map-side pin hover: reveal the site boundary (and grow the pin)
      // without a React round-trip. mousemove, not mouseenter — dense areas
      // can slide the cursor between pins without leaving the layer.
      map.on("mousemove", "pins", (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (id == null || Number(id) === mapHoverIdRef.current) return;
        setMapHover(map, Number(id));
      });
      map.on("mouseleave", "pins", () => setMapHover(map, null));

      loadedRef.current = true;
      // Seed both sources from the current props, not the mount-time ones: the
      // first search usually resolves before the style does, and the [data] /
      // [polygons] effects bail out while loadedRef is false without ever
      // retrying. Boundaries in particular had no other path in — they only
      // appeared once a pan or a new search produced a fresh object.
      if (dataRef.current) {
        (map.getSource("apps") as maplibregl.GeoJSONSource).setData(dataRef.current as never);
      }
      if (polygonsRef.current) {
        (map.getSource("site-polygons") as maplibregl.GeoJSONSource).setData(
          polygonsRef.current as never
        );
      }
      applyActiveStateRef.current(map);
      emitBounds();
    });

    const emitBounds = () => {
      const b = map.getBounds();
      bboxRef.current = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      zoomRef.current = map.getZoom();
      setMapZoom(map.getZoom());
      onBoundsChangeRef.current(bboxRef.current);
    };
    map.on("moveend", emitBounds);
    // A user gesture (pan/zoom) carries an originalEvent; programmatic moves
    // (flyTo/easeTo) don't — so this only fires the "search this area" prompt
    // when the user actually moved the map.
    map.on("moveend", (e) => {
      if ((e as { originalEvent?: unknown }).originalEvent) onUserMoveRef.current?.();
    });
    // Re-fetch any enabled overlay for the new viewport, debounced.
    let overlayTimer: ReturnType<typeof setTimeout> | undefined;
    map.on("moveend", () => {
      clearTimeout(overlayTimer);
      overlayTimer = setTimeout(() => {
        for (const layer of Object.keys(OVERLAY_STYLE) as OverlayKey[]) {
          if (overlaysRef.current[layer]) applyRef.current(layer);
        }
      }, 350);
    });

    return () => {
      loadedRef.current = false;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (map && loadedRef.current && data) {
      (map.getSource("apps") as maplibregl.GeoJSONSource).setData(data as never);
      if (map.getLayer("cluster-count")) {
        map.setLayoutProperty("cluster-count", "visibility", data.truncated ? "none" : "visible");
      }
    }
  }, [data]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && loadedRef.current && polygons) {
      (map.getSource("site-polygons") as maplibregl.GeoJSONSource).setData(polygons as never);
    }
  }, [polygons]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    for (const layer of ["clusters", "pins", "pin-letters"]) {
      if (map.getLayer(layer)) map.setLayoutProperty(layer, "visibility", hideApps ? "none" : "visible");
    }
    if (map.getLayer("cluster-count")) {
      const show = !hideApps && !data?.truncated;
      map.setLayoutProperty("cluster-count", "visibility", show ? "visible" : "none");
    }
  }, [hideApps, data?.truncated]);

  // Draw (or clear) the alert-area circle and manage its centre pin.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const source = map.getSource("watch-circle") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    if (!watchCircle) {
      source.setData(EMPTY_FC as never);
      watchMarkerRef.current?.remove();
      watchMarkerRef.current = null;
      return;
    }
    source.setData(circlePolygon(watchCircle.lat, watchCircle.lng, watchCircle.radius_m) as never);
    if (!watchMarkerRef.current) {
      watchMarkerRef.current = new maplibregl.Marker({ color: "#0b62d6", draggable: Boolean(watchCircle.draggable) })
        .setLngLat([watchCircle.lng, watchCircle.lat])
        .addTo(map);
      watchMarkerRef.current.on("dragend", () => {
        const pos = watchMarkerRef.current?.getLngLat();
        if (pos) onWatchMoveRef.current?.(pos.lat, pos.lng);
      });
    } else {
      watchMarkerRef.current.setLngLat([watchCircle.lng, watchCircle.lat]);
      watchMarkerRef.current.setDraggable(Boolean(watchCircle.draggable));
    }
  }, [watchCircle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    applyActiveStateRef.current(map);
  }, [selectedId, hoveredId]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && flyTo) {
      // Offset, not padding: `offset` applies to this one movement, whereas
      // `padding` would stay on the camera and quietly skew every later
      // easeTo — cluster expansion included.
      map.flyTo({
        center: [flyTo.lng, flyTo.lat],
        zoom: flyTo.zoom ?? Math.max(map.getZoom(), 15),
        offset: flyTo.avoidSheet ? sheetFocusOffset(map.getContainer()) : [0, 0],
      });
    }
  }, [flyTo]);

  // Toggling an overlay on/off applies visibility and (re)loads its data.
  useEffect(() => {
    if (!loadedRef.current) return;
    (Object.keys(OVERLAY_STYLE) as OverlayKey[]).forEach((layer) => applyRef.current(layer));
  }, [overlays]);

  const anyOverlayOn = Object.values(overlays).some(Boolean);
  const overlaysOnCount = Object.values(overlays).filter(Boolean).length;
  return (
    <>
      <div ref={containerRef} className="map-container" role="region" aria-label="Map of planning applications" />
      <div className="map-overlays">
        <button
          type="button"
          className={`layers-btn${anyOverlayOn ? " layers-btn-on" : ""}`}
          aria-expanded={layersOpen}
          onClick={() => setLayersOpen((o) => !o)}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l9 5-9 5-9-5z" />
            <path d="M3 13l9 5 9-5" />
          </svg>
          Layers
          {anyOverlayOn && <span className="layers-count">{overlaysOnCount}</span>}
        </button>
        {layersOpen && (
          <div className="layers-box" role="group" aria-label="Map layers">
            {(Object.keys(OVERLAY_STYLE) as OverlayKey[]).map((layer) => (
              <label key={layer} className="overlay-toggle">
                <input
                  type="checkbox"
                  checked={overlays[layer]}
                  onChange={(e) => setOverlays((o) => ({ ...o, [layer]: e.target.checked }))}
                />
                <span className="overlay-swatch" style={{ background: OVERLAY_STYLE[layer].fill }} aria-hidden="true" />
                {OVERLAY_STYLE[layer].label}
                {layer === "flood" && floodLoading && <span className="overlay-loading"> loading…</span>}
              </label>
            ))}
            {(overlays.zoning || overlays.conservation || overlays.archaeology || overlays.rzlt) && mapZoom < MIN_OVERLAY_ZOOM && (
              <p className="overlay-hint">Zoom in to load zoning, heritage, archaeology and RZLT layers</p>
            )}
            {overlays.flood && (
              <div className="zone-legend">
                {[
                  { a: 0.32, label: "Likely (10–5% AEP)" },
                  { a: 0.2, label: "Moderate (1–0.5% AEP)" },
                  { a: 0.1, label: "Rare (0.1% AEP)" },
                ].map((b) => (
                  <span key={b.label} className="zone-legend-item">
                    <span
                      className="overlay-swatch"
                      style={{ background: `rgba(59, 130, 246, ${b.a + 0.15})` }}
                      aria-hidden="true"
                    />
                    {b.label}
                  </span>
                ))}
              </div>
            )}
            {overlays.zoning && mapZoom >= MIN_OVERLAY_ZOOM && (
              <div className="zone-legend">
                {Object.entries(ZONE_GROUPS).map(([k, v]) => (
                  <span key={k} className="zone-legend-item">
                    <span className="overlay-swatch" style={{ background: v.color }} aria-hidden="true" />
                    {v.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
