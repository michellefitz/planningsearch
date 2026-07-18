import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  EMPTY_SEARCH,
  searchParams,
  type AppDetail,
  type AppSummary,
  type Meta,
  type PointFeatureCollection,
  type SearchState,
} from "./api";
import SearchBar from "./components/SearchBar";
import FiltersBar from "./components/FiltersBar";
import ResultsList from "./components/ResultsList";
import DetailPanel from "./components/DetailPanel";
import MapView, { STATUS_STYLE } from "./components/MapView";

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [state, setState] = useState<SearchState>(EMPTY_SEARCH);
  const [results, setResults] = useState<AppSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [fuzzy, setFuzzy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mapData, setMapData] = useState<PointFeatureCollection | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [detail, setDetail] = useState<AppDetail | null>(null);
  const [flyTo, setFlyTo] = useState<{ lat: number; lng: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bboxRef = useRef<[number, number, number, number] | null>(null);
  const nearRef = useRef<{ lat: number; lng: number } | null>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    api.meta().then(setMeta).catch(() => setError("Could not reach the PlanView API."));
  }, []);

  const runSearch = useCallback(
    async (s: SearchState) => {
      const seq = ++searchSeq.current;
      setLoading(true);
      setError(null);
      try {
        const params = searchParams(s, bboxRef.current, nearRef.current);
        const [listRes, geo] = await Promise.all([api.search(params), api.mapGeoJson(params)]);
        if (seq !== searchSeq.current) return; // stale response
        setResults(listRes.results);
        setTotal(listRes.total);
        setFuzzy(listRes.fuzzy);
        setMapData(geo);
      } catch {
        if (seq === searchSeq.current) setError("Search failed — is the server running?");
      } finally {
        if (seq === searchSeq.current) setLoading(false);
      }
    },
    []
  );

  // Initial load: recent applications everywhere.
  useEffect(() => {
    runSearch(EMPTY_SEARCH);
  }, [runSearch]);

  const applyState = (next: SearchState) => {
    setState(next);
    runSearch(next);
  };

  const select = useCallback(async (id: number) => {
    setSelectedId(id);
    try {
      const d = await api.detail(id);
      setDetail(d);
      if (d.lat != null && d.lng != null) setFlyTo({ lat: d.lat, lng: d.lng });
    } catch {
      setError("Could not load that application.");
    }
  }, []);

  const nearMe = () => {
    if (!navigator.geolocation) {
      setError("Geolocation is not available in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        nearRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setFlyTo(nearRef.current);
        applyState({ ...state, sort: "distance" });
      },
      () => setError("Could not get your location — check browser permissions.")
    );
  };

  const oldestSync = meta?.authorities.reduce<string | null>(
    (acc, a) => (a.last_synced && (!acc || a.last_synced < acc) ? a.last_synced : acc),
    null
  );

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          PlanView <span className="beta">beta</span>
        </h1>
        <p className="tagline">
          Planning applications for Dublin City, Fingal, Dún Laoghaire-Rathdown, South Dublin &amp;
          Kildare — one search, one map.
        </p>
      </header>

      <div className="layout">
        <div className="side-panel">
          <SearchBar
            value={state.q}
            onChange={(q) => setState((s) => ({ ...s, q }))}
            onSubmit={(q) => applyState({ ...state, q })}
            onNearMe={nearMe}
          />
          <FiltersBar meta={meta} state={state} onChange={applyState} />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {detail ? (
            <DetailPanel
              detail={detail}
              meta={meta}
              onClose={() => {
                setDetail(null);
                setSelectedId(null);
              }}
              onSelectRelated={select}
            />
          ) : (
            <ResultsList
              results={results}
              total={total}
              fuzzy={fuzzy}
              loading={loading}
              selectedId={selectedId}
              onSelect={select}
              onHover={setHoveredId}
            />
          )}
        </div>

        <div className="map-wrap">
          <MapView
            data={mapData}
            selectedId={selectedId}
            hoveredId={hoveredId}
            onSelect={select}
            onBoundsChange={(bbox) => {
              bboxRef.current = bbox;
              if (state.useMapArea) runSearch(state);
            }}
            flyTo={flyTo}
          />
          <div className="legend" aria-label="Map legend">
            {Object.entries(STATUS_STYLE)
              .filter(([k]) => k !== "unknown")
              .map(([key, s]) => (
                <span key={key} className="legend-item">
                  <span className="status-dot" style={{ background: s.color }} aria-hidden="true">
                    {s.letter}
                  </span>
                  {s.label}
                </span>
              ))}
          </div>
        </div>
      </div>

      <footer className="app-footer">
        <span>
          {meta?.attribution ?? ""} Data as of {oldestSync?.slice(0, 10) ?? "—"}.
        </span>
      </footer>
    </div>
  );
}
