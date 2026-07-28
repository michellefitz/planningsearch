import { useEffect, useState } from "react";

/** Google Maps satellite view with a pin on the property. The documented Maps
 *  URLs API has no pin+satellite combination (map_action=map centres without a
 *  marker, so the click-through lost the property the thumbnail's pin marked),
 *  so this uses a place URL with the satellite layer in the data param
 *  (`!3m1!1e3`) — long-stable, and if Google drops the param it degrades to a
 *  pinned roadmap rather than breaking. Consumer Google Maps (google.com/maps),
 *  unaffected by the EEA Platform terms. */
export const aerialUrl = (lat: number, lng: number): string =>
  `https://www.google.com/maps/place/${lat},${lng}/@${lat},${lng},19z/data=!3m1!1e3`;

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

/**
 * Static aerial thumbnail for the inline preview.
 *
 * Google's Maps Static API can't be used here: as of the EEA Platform terms
 * (8 Jul 2025), Satellite/Hybrid map types are no longer served to projects on
 * an EEA billing account, and Google Maps Content may not be shown "with or near
 * a non-Google map" — and our base map is OpenStreetMap/MapLibre. So the inline
 * thumbnail comes from a non-Google source.
 *
 * Preferred: Mapbox Satellite (freshest imagery) when VITE_MAPBOX_TOKEN is set.
 * Fallback: Esri World Imagery (keyless, same ArcGIS family as our zoning/flood
 * layers), a ~230m-wide 16:9 Web-Mercator export around the point.
 */
const esriAerial = (lat: number, lng: number): string => {
  const R = 20037508.342789244;
  const x = (lng * R) / 180;
  const y = (R * Math.log(Math.tan(((90 + lat) * Math.PI) / 360))) / Math.PI;
  const halfW = 190;
  const halfH = (halfW * 360) / 640;
  const bbox = `${x - halfW},${y - halfH},${x + halfW},${y + halfH}`;
  return (
    "https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export" +
    `?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=640,360&format=jpg&f=image`
  );
};

const mapboxAerial = (lat: number, lng: number): string =>
  `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/` +
  `${lng},${lat},17.5,0/640x360@2x` +
  `?access_token=${MAPBOX_TOKEN}`;

/** Non-Google satellite thumbnail: Mapbox when a token is configured, else Esri. */
const aerialThumb = (lat: number, lng: number): string =>
  MAPBOX_TOKEN ? mapboxAerial(lat, lng) : esriAerial(lat, lng);

/** Open the property in Google Maps — Street View and satellite when we have
 *  coordinates, otherwise an address search (official Maps URLs API, no key). */
export function MapLinks({ detail: d }: { detail: { lat: number | null; lng: number | null; address_text: string | null } }) {
  const hasCoords = d.lat != null && d.lng != null;
  if (!hasCoords && !d.address_text) return null;
  return (
    <>
      {hasCoords ? (
        <>
          <a
            className="btn"
            href={`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${d.lat},${d.lng}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Street View ↗
          </a>
          <a
            className="btn"
            href={aerialUrl(d.lat!, d.lng!)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Aerial view ↗
          </a>
        </>
      ) : (
        <a
          className="btn"
          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.address_text!)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Find on Google Maps ↗
        </a>
      )}
    </>
  );
}

export const GMAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined;

/**
 * Inline Street View + satellite thumbnails via Google's static image APIs
 * (needs VITE_GOOGLE_MAPS_KEY; renders nothing without it). The free
 * metadata endpoint gates the Street View pane so places with no coverage
 * don't show Google's grey placeholder.
 */
/** Street View metadata dates arrive as "YYYY-MM" (sometimes "YYYY"); show
 *  them as "Jun 2021" so users can judge how current the imagery is. */
function formatPanoDate(raw: string): string {
  const m = raw.match(/^(\d{4})(?:-(\d{2}))?/);
  if (!m) return raw;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = m[2] ? months[Number(m[2]) - 1] : null;
  return month ? `${month} ${m[1]}` : m[1];
}

/** Compass bearing (deg, 0–360) from one lat/lng to another — used to aim the
 *  Street View camera from the chosen panorama toward the property, so it faces
 *  the building instead of pointing along the road. */
function bearing(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const φ1 = toRad(fromLat);
  const φ2 = toRad(toLat);
  const Δλ = toRad(toLng - fromLng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180) / Math.PI; // Google accepts negative headings
}

export default function PropertyMedia({
  lat,
  lng,
  address,
}: {
  lat: number | null;
  lng: number | null;
  address: string | null;
}) {
  const d = { lat, lng, address_text: address };
  // null = no panorama / not loaded; object = the panorama, with the heading
  // that aims it from the pano back at the property.
  const [pano, setPano] = useState<{
    panoId: string;
    date: string | null;
    heading: number | null;
  } | null>(null);
  const hasCoords = d.lat != null && d.lng != null;

  useEffect(() => {
    setPano(null);
    if (!GMAPS_KEY || !hasCoords) return;
    const ctrl = new AbortController();
    const lat = d.lat!;
    const lng = d.lng!;

    // Simply the nearest outdoor panorama. We tried searching a ring around the
    // site for more recent imagery, but "newest" is no proxy for "the road the
    // property is on" — it could land a street away. Nearest is at least
    // predictable, and the click-through lets people walk to the frontage.
    fetch(
      `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&source=outdoor&key=${GMAPS_KEY}`,
      { signal: ctrl.signal }
    )
      .then((r) => r.json())
      .then((m: { status: string; date?: string; pano_id?: string; location?: { lat: number; lng: number } }) => {
        if (m.status !== "OK" || !m.pano_id) return setPano(null);
        setPano({
          panoId: m.pano_id,
          date: m.date ?? null,
          heading: m.location
            ? Math.round(bearing(m.location.lat, m.location.lng, lat, lng))
            : null,
        });
      })
      .catch(() => setPano(null));
    return () => ctrl.abort();
  }, [d.lat, d.lng, hasCoords]);

  // If a static image fails (e.g. the Maps Static API isn't enabled on the key),
  // hide the broken image and leave the tile as a labelled link to the map.
  const onImgError = (e: { currentTarget: HTMLImageElement }) => {
    e.currentTarget.style.display = "none";
    e.currentTarget.parentElement?.classList.add("media-tile-failed");
  };

  if (!GMAPS_KEY || !hasCoords) return null;
  return (
    <div className="media-row">
      {pano && (
        <a
          // Open the same panorama we picked, aimed the same way, so the
          // click-through matches the thumbnail.
          href={
            `https://www.google.com/maps/@?api=1&map_action=pano&pano=${pano.panoId}` +
            (pano.heading != null ? `&heading=${pano.heading}` : "")
          }
          target="_blank"
          rel="noopener noreferrer"
          className="media-tile"
        >
          <img
            src={
              // Render the panorama we chose by id (not location, which would
              // re-pick the nearest one). fov=110 (default 90): our coordinate is
              // the site centroid, not the building frontage, so a narrow cone can
              // leave the house at the edge of frame.
              `https://maps.googleapis.com/maps/api/streetview?size=640x360&pano=${pano.panoId}&fov=110` +
              (pano.heading != null ? `&heading=${pano.heading}` : "") +
              `&key=${GMAPS_KEY}`
            }
            alt={`Street View of ${d.address_text ?? "the property"}`}
            loading="lazy"
            onError={onImgError}
          />
          <span className="media-label">
            Street View{pano.date ? ` · ${formatPanoDate(pano.date)}` : ""}
          </span>
        </a>
      )}
      <a href={aerialUrl(d.lat!, d.lng!)} target="_blank" rel="noopener noreferrer" className="media-tile">
        <img
          src={aerialThumb(d.lat!, d.lng!)}
          alt={`Aerial view of ${d.address_text ?? "the property"}`}
          loading="lazy"
          onError={onImgError}
        />
        {/* The image is centred on the property, so the tile centre marks it. */}
        <span className="aerial-pin" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="30" height="30">
            <path
              d="M12 2C8.1 2 5 5.1 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.9-3.1-7-7-7z"
              fill="#e11d48"
              stroke="#fff"
              strokeWidth="1.6"
            />
            <circle cx="12" cy="9" r="2.6" fill="#fff" />
          </svg>
        </span>
        <span className="media-label">Aerial ↗</span>
      </a>
    </div>
  );
}
