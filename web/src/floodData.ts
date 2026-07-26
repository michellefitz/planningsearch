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
