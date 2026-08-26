import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { AgentAppRef } from "../agentApi";

const STATUS_COLORS: Record<string, string> = {
  granted: "#16a34a",
  refused: "#dc2626",
  pending: "#2563eb",
  further_info: "#d97706",
  withdrawn: "#6b7280",
  invalid: "#6b7280",
  split: "#9333ea",
  decided: "#16a34a",
  exempt: "#16a34a",
  not_exempt: "#dc2626",
};

export default function ChatMap({
  apps,
  onSelect,
}: {
  apps: AgentAppRef[];
  onSelect: (id: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || apps.length === 0) return;

    const pts = apps.filter((a) => a.lat != null && a.lng != null);
    if (pts.length === 0) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "&copy; OpenStreetMap contributors",
          },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
      center: [pts[0].lng!, pts[0].lat!],
      zoom: 13,
      attributionControl: false,
      interactive: true,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      const bounds = new maplibregl.LngLatBounds();
      for (const a of pts) {
        bounds.extend([a.lng!, a.lat!]);
        const color = STATUS_COLORS[a.status] ?? "#6b7280";
        const el = document.createElement("div");
        el.className = "chat-map-pin";
        el.style.background = color;
        el.title = a.address_text ?? a.planning_reference;
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          onSelect(a.id);
        });
        new maplibregl.Marker({ element: el })
          .setLngLat([a.lng!, a.lat!])
          .addTo(map);
      }
      if (pts.length > 1) {
        map.fitBounds(bounds, { padding: 40, maxZoom: 15, duration: 0 });
      }
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Render once per mount — apps won't change for a completed message
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="chat-map" ref={containerRef} />;
}
