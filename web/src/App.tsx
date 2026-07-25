import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import ChatPanel from "./components/ChatPanel";
import AccountPanel from "./components/AccountPanel";
import { accountApi, saveKey, type Me, type SavedApp } from "./accountApi";
import type { AgentAppRef } from "./agentApi";

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
  const [mode, setMode] = useState<"search" | "ask" | "account">("search");
  // Mobile only: the layout shows one of map / list at a time (a toggle),
  // rather than squishing both. Ignored at ≥768px, where they sit side by side.
  const [mobileView, setMobileView] = useState<"map" | "list">("map");
  const [legendOpen, setLegendOpen] = useState(false);
  // Shown after the user pans/zooms the map: a one-tap "search this area".
  const [canSearchArea, setCanSearchArea] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

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
    setCanSearchArea(false);
    runSearch(next);
  };

  // One-shot search of the current map viewport (the floating map button). Uses
  // the live bbox the map keeps in bboxRef; doesn't latch the "map area" filter.
  const searchThisArea = () => {
    setCanSearchArea(false);
    runSearch({ ...state, useMapArea: true });
  };

  const refreshMe = useCallback(async (): Promise<Me> => {
    try {
      const data = await accountApi.me();
      setMe(data);
      return data;
    } catch {
      const empty: Me = { user: null, saves: [], lists: [] };
      setMe(empty);
      return empty;
    }
  }, []);

  // Sign-out sits in the top bar with the rest of the account controls.
  const signOut = useCallback(async () => {
    try {
      await accountApi.logout();
      await refreshMe();
      setMode("search");
    } catch {
      // sign-out failed — leave state unchanged
    }
  }, [refreshMe]);

  const savedByKey = useMemo(() => {
    const m = new Map<string, SavedApp>();
    for (const s of me?.saves ?? []) m.set(saveKey(s.authority_id, s.planning_reference), s);
    return m;
  }, [me]);

  const select = useCallback(async (id: number) => {
    setSelectedId(id);
    try {
      const d = await api.detail(id);
      setDetail(d);
      if (d.lat != null && d.lng != null) setFlyTo({ lat: d.lat, lng: d.lng });
      const save = savedByKey.get(saveKey(d.authority_id, d.planning_reference));
      if (save?.has_update) {
        accountApi.updateSave(save.id, { seen: true }).then(() => refreshMe()).catch(() => {});
      }
    } catch {
      setError("Could not load that application.");
    }
  }, [savedByKey, refreshMe]);

  const toggleSave = useCallback(async (authorityId: string, reference: string) => {
    if (!me?.user) {
      localStorage.setItem("pv_pending_save", JSON.stringify({ authorityId, reference }));
      setMode("account");
      return;
    }
    const existing = savedByKey.get(saveKey(authorityId, reference));
    try {
      if (existing) await accountApi.unsave(existing.id);
      else await accountApi.save(authorityId, reference);
      await refreshMe();
    } catch {
      setError("Could not update your saved applications.");
    }
  }, [me, savedByKey, refreshMe]);

  useEffect(() => {
    void (async () => {
      const freshMe = await refreshMe();
      const hash = window.location.hash;
      if (hash === "#account") setMode("account");
      if (hash === "#auth-expired") {
        setMode("account");
        setAuthNotice("That sign-in link has expired — request a fresh one.");
      }
      const appMatch = hash.match(/^#app=([^:]+):(.+)$/);
      if (appMatch) {
        try {
          const authorityId = decodeURIComponent(appMatch[1]);
          const reference = decodeURIComponent(appMatch[2]);
          const { id } = await api.resolve(authorityId, reference);
          await select(id);
          const key = saveKey(authorityId, reference);
          const save = freshMe.saves.find(
            (s) => saveKey(s.authority_id, s.planning_reference) === key
          );
          if (save?.has_update) {
            accountApi.updateSave(save.id, { seen: true }).then(() => refreshMe()).catch(() => {});
          }
        } catch {
          setError("That application is no longer in the current dataset.");
        }
      }
      if (hash) history.replaceState(null, "", window.location.pathname);
    })();
  }, []);

  useEffect(() => {
    const pending = localStorage.getItem("pv_pending_save");
    if (!pending || !me?.user) return;
    localStorage.removeItem("pv_pending_save");
    try {
      const { authorityId, reference } = JSON.parse(pending);
      void toggleSave(authorityId, reference);
    } catch {
      // corrupted storage entry — already removed above
    }
  }, [me?.user, toggleSave]);

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

  const showAgentApps = useCallback((apps: AgentAppRef[]) => {
    const located = apps.filter((a) => a.lat != null && a.lng != null);
    if (!located.length) return;
    setMapData({
      type: "FeatureCollection",
      features: located.map((a) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [a.lng as number, a.lat as number] },
        properties: {
          id: a.id,
          reference: a.planning_reference,
          status: a.status,
          authority_id: a.authority_id,
          address: a.address_text,
          is_domestic_guess: false,
        },
      })),
    });
    setFlyTo({ lat: located[0].lat as number, lng: located[0].lng as number });
  }, []);

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
        {/* Account lives in the top bar, where a web app puts it — not as a
            third panel tab. Signing in and the dashboard are app-level
            destinations, not modes of the search panel. */}
        <nav className="app-nav" aria-label="Account">
          {me?.user ? (
            <>
              <button
                type="button"
                className={`nav-link ${mode === "account" ? "nav-link-on" : ""}`}
                aria-current={mode === "account" ? "page" : undefined}
                onClick={() => setMode("account")}
              >
                Dashboard
                {me.saves.some((s) => s.has_update) ? <span className="nav-dot" /> : null}
              </button>
              <span className="nav-email" title={me.user.email}>
                {me.user.email}
              </span>
              <button type="button" className="nav-signout" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-primary nav-signin"
              onClick={() => setMode("account")}
            >
              Sign in
            </button>
          )}
        </nav>
      </header>

      {/* The dashboard is a full-screen destination, but the map stays mounted
          behind it (hidden, not unmounted) so returning keeps its position. */}
      <div
        className={`layout ${mode === "search" && mobileView === "map" ? "m-map" : "m-panel"}`}
        hidden={mode === "account"}
      >
        <div className="side-panel">
          <div className="mode-tabs" role="tablist" aria-label="Panel mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "search"}
              className={mode === "search" ? "tab-active" : ""}
              onClick={() => setMode("search")}
            >
              Search
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "ask"}
              className={mode === "ask" ? "tab-active" : ""}
              onClick={() => setMode("ask")}
            >
              Ask
            </button>
          </div>

          <div hidden={mode !== "search"} className="search-wrap">
            <SearchBar
              value={state.q}
              onChange={(q) => setState((s) => ({ ...s, q }))}
              onSubmit={(q) => {
                applyState({ ...state, q });
                // On mobile, a keyword search wants results — switch to the list.
                if (q.trim()) setMobileView("list");
              }}
              onNearMe={nearMe}
            />
            <FiltersBar meta={meta} state={state} onChange={applyState} />
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {/* Mobile map/list toggle — hidden at ≥768px, where both show. */}
            <div className="view-toggle" role="group" aria-label="View">
              <span className="vt-count" role="status">
                {total.toLocaleString()} result{total === 1 ? "" : "s"}
              </span>
              <div className="vt-seg">
                <button
                  type="button"
                  className={mobileView === "map" ? "on" : ""}
                  aria-pressed={mobileView === "map"}
                  onClick={() => setMobileView("map")}
                >
                  Map
                </button>
                <button
                  type="button"
                  className={mobileView === "list" ? "on" : ""}
                  aria-pressed={mobileView === "list"}
                  onClick={() => setMobileView("list")}
                >
                  List
                </button>
              </div>
            </div>
            <div className="results-scroll">
              <ResultsList
                results={results}
                total={total}
                fuzzy={fuzzy}
                loading={loading}
                selectedId={selectedId}
                onSelect={select}
                onHover={setHoveredId}
                savedByKey={savedByKey}
                onToggleSave={toggleSave}
              />
            </div>
          </div>

          <div hidden={mode !== "ask"} className="chat-wrap">
            <ChatPanel onSelectApp={select} onHoverApp={setHoveredId} onAppsReferenced={showAgentApps} />
          </div>

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
            onUserMove={() => {
              if (!state.useMapArea) setCanSearchArea(true);
            }}
            flyTo={flyTo}
          />
          {canSearchArea && (
            <button type="button" className="search-area-btn" onClick={searchThisArea}>
              Search this area
            </button>
          )}
          <div className={`legend ${legendOpen ? "legend-open" : ""}`} aria-label="Map legend">
            <button
              type="button"
              className="legend-toggle"
              aria-expanded={legendOpen}
              onClick={() => setLegendOpen((o) => !o)}
            >
              Key
            </button>
            <div className="legend-items">
              {Object.entries(STATUS_STYLE)
                .filter(([k]) => k !== "unknown")
                .map(([key, s]) => (
                  <span key={key} className="legend-item">
                    <span className="legend-pin" style={{ background: s.color }} aria-hidden="true">
                      {s.letter}
                    </span>
                    {s.label}
                  </span>
                ))}
            </div>
          </div>
        </div>
      </div>

      {mode === "account" && (
        <main className="account-screen">
          <div className="account-screen-inner">
            <button type="button" className="back-to-map" onClick={() => setMode("search")}>
              ← Back to map
            </button>
            <AccountPanel
              me={me}
              notice={authNotice}
              onRefresh={refreshMe}
              onOpenApp={async (authorityId, reference) => {
                try {
                  const { id } = await api.resolve(authorityId, reference);
                  setMode("search");
                  await select(id);
                } catch {
                  setError("That application is no longer in the current dataset.");
                }
              }}
              onGoSearch={() => setMode("search")}
            />
          </div>
        </main>
      )}

      <footer className="app-footer">
        <span>
          {meta?.attribution ?? ""} Register data last updated{" "}
          {meta?.source_updated_at ?? oldestSync?.slice(0, 10) ?? "—"}
          {meta?.generated_at && ` · refreshed here ${meta.generated_at.slice(0, 10)}`}.
        </span>
      </footer>

      {detail && (
        <>
          <div
            className="sheet-backdrop"
            onClick={() => {
              setDetail(null);
              setSelectedId(null);
            }}
            aria-hidden="true"
          />
          <DetailPanel
            detail={detail}
            meta={meta}
            onClose={() => {
              setDetail(null);
              setSelectedId(null);
            }}
            onSelectRelated={select}
            saved={savedByKey.has(saveKey(detail.authority_id, detail.planning_reference))}
            onToggleSave={() => toggleSave(detail.authority_id, detail.planning_reference)}
          />
        </>
      )}
    </div>
  );
}
