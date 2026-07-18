import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { PointFeatureCollection } from "../api";

/**
 * Status colours pair with a letter glyph on each pin so state is never
 * conveyed by colour alone (PRD F2.2 / F8.3).
 */
export const STATUS_STYLE: Record<string, { color: string; letter: string; label: string }> = {
  pending: { color: "#2563eb", letter: "P", label: "Pending decision" },
  further_info: { color: "#9333ea", letter: "F", label: "Further information" },
  granted: { color: "#16a34a", letter: "G", label: "Granted" },
  refused: { color: "#dc2626", letter: "R", label: "Refused" },
  withdrawn: { color: "#6b7280", letter: "W", label: "Withdrawn" },
  invalid: { color: "#a16207", letter: "I", label: "Invalid" },
  appealed: { color: "#ea580c", letter: "A", label: "Under appeal" },
  unknown: { color: "#64748b", letter: "?", label: "Unknown" },
};

const IRELAND_EAST_BOUNDS: [number, number, number, number] = [-7.2, 52.9, -5.9, 53.7];

interface Props {
  data: PointFeatureCollection | null;
  selectedId: number | null;
  hoveredId: number | null;
  onSelect: (id: number) => void;
  onBoundsChange: (bbox: [number, number, number, number]) => void;
  flyTo?: { lat: number; lng: number } | null;
}

export default function MapView({ data, selectedId, hoveredId, onSelect, onBoundsChange, flyTo }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loadedRef = useRef(false);

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
        if (f?.properties?.id != null) onSelect(Number(f.properties.id));
      });
      for (const layer of ["pins", "clusters"]) {
        map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
      }

      loadedRef.current = true;
      if (data) (map.getSource("apps") as maplibregl.GeoJSONSource).setData(data as never);
      emitBounds();
    });

    const emitBounds = () => {
      const b = map.getBounds();
      onBoundsChange([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    };
    map.on("moveend", emitBounds);

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
    }
  }, [data]);

  const prevState = useRef<{ selected: number | null; hovered: number | null }>({
    selected: null,
    hovered: null,
  });
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const { selected, hovered } = prevState.current;
    if (selected != null) map.setFeatureState({ source: "apps", id: selected }, { selected: false });
    if (hovered != null) map.setFeatureState({ source: "apps", id: hovered }, { hovered: false });
    if (selectedId != null)
      map.setFeatureState({ source: "apps", id: selectedId }, { selected: true });
    if (hoveredId != null) map.setFeatureState({ source: "apps", id: hoveredId }, { hovered: true });
    prevState.current = { selected: selectedId, hovered: hoveredId };
  }, [selectedId, hoveredId]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && flyTo) {
      map.flyTo({ center: [flyTo.lng, flyTo.lat], zoom: Math.max(map.getZoom(), 15) });
    }
  }, [flyTo]);

  return <div ref={containerRef} className="map-container" role="region" aria-label="Map of planning applications" />;
}
