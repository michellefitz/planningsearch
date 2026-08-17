import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  EMPTY_SEARCH,
  mapParams,
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
import { STATUS_STYLE } from "./statusStyle";
import { accountApi, saveKey, type AreaWatch, type Me, type SavedApp } from "./accountApi";
import type { AgentAppRef } from "./agentApi";
import { coverageSummary } from "./coverage";
import { posthog } from "./posthog";

// maplibre-gl is 217 kB gzipped — 60% of the initial JS — for a map that
// cannot draw anything until the pins arrive anyway. Loading it alongside
// the shell let the search bar and filters paint first.
const MapView = lazy(() => import("./components/MapView"));
const DetailPanel = lazy(() => import("./components/DetailPanel"));
const ChatPanel = lazy(() => import("./components/ChatPanel"));
const AccountPanel = lazy(() => import("./components/AccountPanel"));
const PrePlannerPanel = lazy(() => import("./components/PrePlannerPanel"));

/**
 * An open application is a real, shareable address: /application/{council}/{ref}.
 * The reference is percent-encoded because Irish references contain slashes
 * ("3456/25"). Vercel's SPA fallback serves index.html for any path, so a link
 * pasted cold resolves on load.
 */
/** Sort options, and the label the compact control shows for each. */
const SORT_LABELS: Record<string, string> = {
  relevance: "Best match",
  received: "Date received",
  decision: "Decision date",
  distance: "Distance",
};

const appPath = (authorityId: string, reference: string): string =>
  `/application/${encodeURIComponent(authorityId)}/${encodeURIComponent(reference)}`;

const parseAppPath = (pathname: string): { authorityId: string; reference: string } | null => {
  const m = pathname.match(/^\/application\/([^/]+)\/(.+?)\/?$/);
  if (!m) return null;
  try {
    return { authorityId: decodeURIComponent(m[1]), reference: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
};

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [state, setState] = useState<SearchState>(EMPTY_SEARCH);
  const [results, setResults] = useState<AppSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [fuzzy, setFuzzy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mapData, setMapData] = useState<PointFeatureCollection | null>(null);
  const [sitePolygons, setSitePolygons] = useState<GeoJSON.FeatureCollection | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [detail, setDetail] = useState<AppDetail | null>(null);
  const [flyTo, setFlyTo] = useState<{ lat: number; lng: number; zoom?: number; avoidSheet?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"search" | "ask" | "account" | "preplan">("search");
  // Mobile only: the layout shows one of map / list at a time (a toggle),
  // rather than squishing both. Ignored at ≥768px, where they sit side by side.
  const [mobileView, setMobileView] = useState<"map" | "list">("map");
  // On mobile the search/filter chrome floats over the map, so the map's own
  // controls have to clear it. Its height changes as controls wrap and applied
  // chips come and go, so it is measured rather than guessed at.
  const sidePanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sidePanelRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const publish = () =>
      el.parentElement?.style.setProperty("--overlay-h", `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Desktop only: tuck the whole panel away for a full-width map.
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  // Mobile account menu. Only rendered as a menu below 768px — above it the
  // same buttons sit inline in the top bar and this stays false.
  const [navOpen, setNavOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  // Shown after the user pans/zooms the map: a one-tap "search this area".
  const [canSearchArea, setCanSearchArea] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  // Area-watch creation (draggable circle + card) and read-only preview of a
  // saved watch. Only one circle shows at a time; a draft wins.
  const [watchDraft, setWatchDraft] = useState<{ name: string; lat: number; lng: number; radius_m: number } | null>(null);
  const [watchView, setWatchView] = useState<AreaWatch | null>(null);
  const [watchSaving, setWatchSaving] = useState(false);
  const [watchNotice, setWatchNotice] = useState<string | null>(null);

  const bboxRef = useRef<[number, number, number, number] | null>(null);
  const nearRef = useRef<{ lat: number; lng: number } | null>(null);
  const searchSeq = useRef(0);
  const flyOnNextSearch = useRef(false);
  const pinSeq = useRef(0);
  const pinTimer = useRef<number | null>(null);
  const identifiedEmailRef = useRef<string | null>(null);
  // True while we're applying a URL (initial load or back/forward), so the
  // selection effect doesn't push a duplicate history entry straight back.
  const applyingUrl = useRef(false);
  // Desktop sheet close: keep it mounted with a closing class so the slide-out
  // can play, then unmount. Mobile dismiss animates in DetailPanel's drag code.
  const [sheetClosing, setSheetClosing] = useState(false);
  const sheetCloseTimer = useRef<number | null>(null);
  const closeSheet = useCallback(() => {
    // Closing the sheet returns to the previous address, so Back and the close
    // button agree with each other.
    if (parseAppPath(window.location.pathname)) history.pushState(null, "", "/");
    if (window.matchMedia("(max-width: 767px)").matches) {
      setDetail(null);
      setSelectedId(null);
      return;
    }
    setSheetClosing(true);
    sheetCloseTimer.current = window.setTimeout(() => {
      sheetCloseTimer.current = null;
      setSheetClosing(false);
      setDetail(null);
      setSelectedId(null);
    }, 240);
  }, []);

  useEffect(() => {
    api.meta().then(setMeta).catch(() => setError("Could not reach the PlanView API."));
  }, []);

  const runSearch = useCallback(
    async (s: SearchState) => {
      if (pinTimer.current != null) {
        window.clearTimeout(pinTimer.current);
        pinTimer.current = null;
      }
      ++pinSeq.current;
      const seq = ++searchSeq.current;
      const shouldFly = flyOnNextSearch.current;
      flyOnNextSearch.current = false;
      setLoading(true);
      setError(null);
      try {
        const params = searchParams(s, bboxRef.current, nearRef.current);
        const mp = mapParams(s, bboxRef.current, nearRef.current);
        const [listRes, geo] = await Promise.all([api.search(params), api.mapGeoJson(mp)]);
        if (seq !== searchSeq.current) return; // stale response
        setResults(listRes.results);
        setTotal(listRes.total);
        setFuzzy(listRes.fuzzy);
        setMapData(geo);
        // Site boundaries render on pin hover/selection only, so they are not
        // worth blocking first paint for — at ~120 kB gzipped they were the
        // largest thing on the critical path, fetched before anyone had
        // touched a pin. Loaded after the list and pins are up; a failure just
        // means no outline, never a failed search.
        void api
          .mapPolygons(mp)
          .then((polys) => {
            if (seq === searchSeq.current) setSitePolygons(polys);
          })
          .catch(() => {});
        if (shouldFly && listRes.results.length > 0) {
          const r = listRes.results[0];
          if (r.lat != null && r.lng != null)
            setFlyTo({ lat: r.lat, lng: r.lng, zoom: 14 });
        }
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

  // Dismiss the account menu the way a menu is expected to go: tap anywhere
  // else, or press Escape.
  useEffect(() => {
    if (!navOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setNavOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [navOpen]);

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

  // Start an area-watch draft at the current map centre. Entering the draft
  // switches the whole screen into a focused map-only mode (panel, filters,
  // pins and competing CTAs all hidden) — see the `watch-mode` layout class.
  const startWatchDraft = () => {
    const b = bboxRef.current;
    const center = b
      ? { lat: (b[1] + b[3]) / 2, lng: (b[0] + b[2]) / 2 }
      : { lat: 53.35, lng: -6.26 };
    setWatchView(null);
    setWatchNotice(null);
    setMobileView("map");
    setCanSearchArea(false);
    setWatchDraft({ name: "", radius_m: 1000, ...center });
  };

  // Place search inside watch mode: jump the map (and the pin) to a town,
  // suburb or Eircode. The application register doubles as a gazetteer — every
  // settlement has applications, and their coordinates are already local.
  const [watchPlaceQ, setWatchPlaceQ] = useState("");
  const watchPlaceSearch = async (q: string) => {
    const query = q.trim();
    if (!query) return;
    setWatchNotice(null);
    try {
      const res = await api.search(new URLSearchParams({ q: query, limit: "10" }));
      const hit = res.results.find((r) => r.lat != null && r.lng != null);
      if (!hit) {
        setWatchNotice("Couldn't find that place — try a nearby town or an Eircode.");
        return;
      }
      setWatchDraft((d) => (d ? { ...d, lat: hit.lat!, lng: hit.lng! } : d));
      setFlyTo({ lat: hit.lat!, lng: hit.lng!, zoom: 14 });
    } catch {
      setWatchNotice("Search failed — try again.");
    }
  };

  const watchUseMyLocation = () => {
    if (!navigator.geolocation) {
      setWatchNotice("Your browser doesn't share location — search for a place instead.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        setWatchDraft((d) => (d ? { ...d, lat, lng } : d));
        setFlyTo({ lat, lng, zoom: 14 });
      },
      () => setWatchNotice("Couldn't get your location — search for a place instead."),
      { timeout: 8000 }
    );
  };

  const saveWatchDraft = async () => {
    if (!watchDraft) return;
    setWatchSaving(true);
    setWatchNotice(null);
    try {
      const watch = await accountApi.createWatch({
        name: watchDraft.name.trim() || "Watched area",
        lat: watchDraft.lat,
        lng: watchDraft.lng,
        radius_m: watchDraft.radius_m,
      });
      await refreshMe();
      posthog.capture("area_watch_created", { radius_m: watch.radius_m });
      setWatchDraft(null);
      setWatchView(watch);
      setWatchNotice(`Watching ${watch.name} — new applications and commencements land in your daily email.`);
    } catch {
      setWatchNotice("Could not save that area — try again.");
    } finally {
      setWatchSaving(false);
    }
  };

  // Pins follow the viewport, independently of the list. Panning re-fetches
  // only the map layer — debounced, because moveend fires continuously during
  // a drag — so the payload stays proportional to what's on screen rather than
  // to the whole register.
  const refreshPins = useCallback((s: SearchState) => {
    if (pinTimer.current != null) window.clearTimeout(pinTimer.current);
    pinTimer.current = window.setTimeout(async () => {
      const seq = ++pinSeq.current;
      try {
        const mp = mapParams(s, bboxRef.current, nearRef.current);
        const geo = await api.mapGeoJson(mp);
        if (seq === pinSeq.current) setMapData(geo);
        // Outlines follow the pins rather than arriving with them — same
        // reasoning as the initial search: nothing sees them until a pin is
        // hovered or tapped, and they are the heavier half of the pair.
        void api
          .mapPolygons(mp)
          .then((polys) => {
            if (seq === pinSeq.current && polys) setSitePolygons(polys);
          })
          .catch(() => {});
      } catch {
        // A failed pin refresh leaves the previous pins up; the list is
        // unaffected and the next move retries.
      }
    }, 350);
  }, []);

  const refreshMe = useCallback(async (): Promise<Me> => {
    try {
      const data = await accountApi.me();
      if (data.user && identifiedEmailRef.current !== data.user.email) {
        // The /api/me response exposes no stable account ID, so email is the
        // only available distinct-id fallback. Keep it as a person property too.
        posthog.identify(data.user.email, { email: data.user.email });
        identifiedEmailRef.current = data.user.email;
      }
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
      posthog.reset();
      identifiedEmailRef.current = null;
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
    if (sheetCloseTimer.current != null) {
      window.clearTimeout(sheetCloseTimer.current);
      sheetCloseTimer.current = null;
      setSheetClosing(false);
    }
    setSelectedId(id);
    try {
      const d = await api.detail(id);
      posthog.capture("application_viewed", {
        authority_id: d.authority_id,
        application_type: d.application_type,
        status: d.status,
      });
      setDetail(d);
      // Give the open application its own history entry so it can be linked,
      // bookmarked and dismissed with the browser's Back button.
      const url = appPath(d.authority_id, d.planning_reference);
      if (applyingUrl.current) history.replaceState(null, "", url);
      else if (window.location.pathname !== url) history.pushState(null, "", url);
      // The sheet is about to cover the bottom (phone) or right (desktop) of
      // the map, so aim for the middle of what stays visible — centring on
      // the canvas put the pin you just tapped underneath the sheet.
      if (d.lat != null && d.lng != null)
        setFlyTo({ lat: d.lat, lng: d.lng, avoidSheet: true });
      const save = savedByKey.get(saveKey(d.authority_id, d.planning_reference));
      if (save?.has_update) {
        accountApi.updateSave(save.id, { seen: true }).then(() => refreshMe()).catch(() => {});
      }
    } catch {
      setError("Could not load that application.");
    }
  }, [savedByKey, refreshMe]);

  // Optimistic: the star fills the instant it's clicked; the request settles
  // in the background and a failure resyncs from the server.
  const toggleSave = useCallback(async (authorityId: string, reference: string) => {
    if (!me?.user) {
      localStorage.setItem("pv_pending_save", JSON.stringify({ authorityId, reference }));
      setMode("account");
      return;
    }
    const existing = savedByKey.get(saveKey(authorityId, reference));
    // A negative id is an optimistic save still in flight — ignore re-clicks
    // until the server id lands, or an unsave would target a phantom row.
    if (existing && existing.id < 0) return;
    if (existing) {
      setMe((m) => m && ({
        ...m,
        saves: m.saves.filter((s) => s.id !== existing.id),
        lists: m.lists.map((l) => ({ ...l, item_ids: l.item_ids.filter((id) => id !== existing.id) })),
      }));
      try {
        await accountApi.unsave(existing.id);
        posthog.capture("application_unsaved", { authority_id: authorityId });
      } catch {
        setError("Could not update your saved applications.");
        await refreshMe();
      }
    } else {
      const now = new Date().toISOString();
      const temp: SavedApp = {
        id: -Date.now(),
        authority_id: authorityId,
        planning_reference: reference,
        alerts_enabled: true,
        events_seen_at: now,
        created_at: now,
        has_update: false,
        app: results.find(
          (r) => r.authority_id === authorityId && r.planning_reference === reference
        ) ?? null,
      };
      setMe((m) => m && ({ ...m, saves: [temp, ...m.saves] }));
      try {
        const real = await accountApi.save(authorityId, reference);
        posthog.capture("application_saved", { authority_id: authorityId });
        setMe((m) => m && ({ ...m, saves: m.saves.map((s) => (s.id === temp.id ? real : s)) }));
      } catch {
        setError("Could not update your saved applications.");
        await refreshMe();
      }
    }
  }, [me, savedByKey, refreshMe, results]);

  useEffect(() => {
    void (async () => {
      const freshMe = await refreshMe().finally(() => setAuthChecked(true));
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
      // A shared/bookmarked /application/... link resolves on load. The legacy
      // #app= form (used by digest emails) is rewritten to it above, so the
      // canonical address is what ends up in the bar either way.
      const fromPath = parseAppPath(window.location.pathname);
      if (fromPath && !appMatch) {
        applyingUrl.current = true;
        try {
          const { id } = await api.resolve(fromPath.authorityId, fromPath.reference);
          await select(id);
        } catch {
          setError("That application is no longer in the current dataset.");
          history.replaceState(null, "", "/");
        } finally {
          applyingUrl.current = false;
        }
      }
      if (hash) history.replaceState(null, "", window.location.pathname);
    })();
  }, []);

  // Back/forward between an open application and the map.
  useEffect(() => {
    const onPop = async () => {
      const target = parseAppPath(window.location.pathname);
      if (!target) {
        setDetail(null);
        setSelectedId(null);
        return;
      }
      applyingUrl.current = true;
      try {
        const { id } = await api.resolve(target.authorityId, target.reference);
        await select(id);
      } catch {
        setError("That application is no longer in the current dataset.");
      } finally {
        applyingUrl.current = false;
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [select]);

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

  /**
   * Search/Ask. Rendered twice and shown once: in the top bar on a phone,
   * where the row has space the panel does not, and above the panel at
   * >=768px. One `mode` drives both, so they cannot disagree.
   */
  const modeTabs = (variant: string) => (
    <div className={`mode-tabs ${variant}`} role="tablist" aria-label="Panel mode">
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
  );

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          PlanView <span className="beta">beta</span>
        </h1>
        {/* Not while drafting a watch: that mode hides the side panel to leave
            the map alone with the circle, and these tabs used to live in the
            panel, so they went with it. Now they are up here they have to be
            withheld deliberately, or Ask would switch a panel nobody can see. */}
        {(mode === "search" || mode === "ask") && !watchDraft && modeTabs("mode-tabs-top")}
        {/* Account lives in the top bar, where a web app puts it — not as a
            third panel tab. Signing in and the dashboard are app-level
            destinations, not modes of the search panel. */}
        <nav className="app-nav" aria-label="Account" ref={navRef}>
          {!authChecked ? null : me?.user ? (
            <>
              {/* Signed in, the top bar carried four controls — two links, the
                  email and Sign out — which on a phone left no room for
                  anything else. They collapse behind one avatar button here;
                  the wrapper is display:contents at ≥768px, so the desktop bar
                  keeps the same inline row it always had. */}
              <button
                type="button"
                className="nav-avatar"
                aria-expanded={navOpen}
                aria-haspopup="menu"
                aria-label={`Account menu for ${me.user.email}`}
                onClick={() => setNavOpen((o) => !o)}
              >
                {me.user.email.slice(0, 1).toUpperCase()}
                {/* The dot has to survive the collapse, or a saved application
                    with an update becomes invisible until you go looking. */}
                {me.saves.some((s) => s.has_update) ? <span className="nav-dot nav-dot-avatar" /> : null}
              </button>
              <div className={`nav-links ${navOpen ? "nav-links-open" : ""}`} role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className={`nav-link ${mode === "account" ? "nav-link-on" : ""}`}
                  aria-current={mode === "account" ? "page" : undefined}
                  onClick={() => {
                    setNavOpen(false);
                    setMode("account");
                  }}
                >
                  Dashboard
                  {me.saves.some((s) => s.has_update) ? <span className="nav-dot" /> : null}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`nav-link ${mode === "preplan" ? "nav-link-on" : ""}`}
                  aria-current={mode === "preplan" ? "page" : undefined}
                  onClick={() => {
                    setNavOpen(false);
                    setMode("preplan");
                  }}
                >
                  Pre-planner
                </button>
                <span className="nav-email" title={me.user.email}>
                  {me.user.email}
                </span>
                <button
                  type="button"
                  role="menuitem"
                  className="nav-signout"
                  onClick={() => {
                    setNavOpen(false);
                    signOut();
                  }}
                >
                  Sign out
                </button>
              </div>
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
        className={`layout ${mode === "search" && (mobileView === "map" || watchDraft) ? "m-map" : "m-panel"}${panelCollapsed ? " panel-collapsed" : ""}${watchDraft ? " watch-mode" : ""}`}
        hidden={mode === "account" || mode === "preplan"}
      >
        <div className="side-panel" ref={sidePanelRef}>
          {modeTabs("mode-tabs-panel")}

          <div hidden={mode !== "search"} className="search-wrap">
            <SearchBar
              value={state.q}
              onChange={(q) => setState((s) => ({ ...s, q }))}
              onSubmit={(q) => {
                posthog.capture("search_submitted", { has_query: Boolean(q.trim()) });
                if (q.trim()) flyOnNextSearch.current = true;
                applyState({ ...state, q });
                // On mobile, a keyword search wants results — switch to the list.
                if (q.trim()) setMobileView("list");
              }}
              onNearMe={nearMe}
            />
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {/* Filters and the map/list toggle share one line on mobile, where
                two near-empty rows cost more screen than they earn. Desktop
                keeps them as they were — the wrapper is display:contents there,
                and the toggle is hidden anyway. */}
            <div className="panel-controls">
            <FiltersBar meta={meta} state={state} onChange={applyState} total={total} />
            {/* Mobile map/list toggle — hidden at ≥768px, where both show. */}
            <div className="view-toggle" role="group" aria-label="View">
              <span className="vt-count" role="status">
                {total.toLocaleString()} result{total === 1 ? "" : "s"}
              </span>
              {/* The native select carries the interaction — it must stay at
                  16px or iOS zooms the page on focus — but it sits invisibly
                  over a label we control, so the row keeps one type scale
                  instead of one control shouting at 16px beside 12px text. */}
              <label className="sort-inline">
                <span className="sort-value" aria-hidden="true">
                  {SORT_LABELS[state.sort] ?? "Sort"}
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 4L5 6.5 7.5 4" />
                  </svg>
                </span>
                <select
                  className="sort-native"
                  value={state.sort}
                  onChange={(e) => applyState({ ...state, sort: e.target.value })}
                  aria-label="Sort results"
                >
                  {Object.entries(SORT_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
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
                coverage={coverageSummary(meta)}
              />
            </div>
          </div>

          <div hidden={mode !== "ask"} className="chat-wrap">
            <Suspense>
              <ChatPanel onSelectApp={select} onHoverApp={setHoveredId} onAppsReferenced={showAgentApps} />
            </Suspense>
          </div>

        </div>

        <div className="map-wrap">
          <button
            type="button"
            className="panel-collapse-btn"
            aria-expanded={!panelCollapsed}
            aria-label={panelCollapsed ? "Show search panel" : "Hide search panel"}
            title={panelCollapsed ? "Show search panel" : "Hide search panel"}
            onClick={() => setPanelCollapsed((c) => !c)}
          >
            <svg
              aria-hidden="true"
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6.5 1.5 3 5l3.5 3.5" />
            </svg>
          </button>
          {/* Something has to occupy the map's space while its code arrives,
              or the screen reads as broken rather than busy — the tiles used
              to appear out of a flat grey rectangle with no sign anything was
              happening. */}
          <Suspense
            fallback={
              <div className="map-skeleton" role="status" aria-label="Loading the map">
                <span className="map-skeleton-pulse" aria-hidden="true" />
                <span className="map-skeleton-label">Loading the map…</span>
              </div>
            }
          >
          <MapView
            data={mapData}
            polygons={sitePolygons}
            hideApps={Boolean(watchDraft)}
            watchCircle={
              watchDraft
                ? { lat: watchDraft.lat, lng: watchDraft.lng, radius_m: watchDraft.radius_m, draggable: true }
                : watchView
                  ? { lat: watchView.lat, lng: watchView.lng, radius_m: watchView.radius_m }
                  : null
            }
            onWatchMove={(lat, lng) => setWatchDraft((d) => (d ? { ...d, lat, lng } : d))}
            selectedId={selectedId}
            hoveredId={hoveredId}
            onSelect={select}
            onBoundsChange={(bbox) => {
              bboxRef.current = bbox;
              // "Limit to current map area" re-runs the whole search; otherwise
              // just the pins follow the viewport.
              if (state.useMapArea) runSearch(state);
              else refreshPins(state);
            }}
            onUserMove={() => {
              if (!state.useMapArea) setCanSearchArea(true);
            }}
            flyTo={flyTo}
          />
          </Suspense>
          {canSearchArea && !watchDraft && (
            <button type="button" className="search-area-btn" onClick={searchThisArea}>
              Search this area
            </button>
          )}
          {/* "+ Watch an area" used to sit here, but a permanent button over
              the map overlapped the legend and attribution and cost space on
              small screens. Watches are still created from the account panel
              ("Watch an area on the map"), which enters the same draft mode;
              where the entry point belongs on the map is still open. */}
          {watchDraft && (
            <>
              <div className="watch-banner" role="status">
                <strong>Watch this area</strong>
                <span>
                  Tap the map or drag the pin to place the circle — we'll email you when anything
                  new lands inside it.
                </span>
              </div>
              <div className="watch-card" role="dialog" aria-label="Watch this area">
                <form
                  className="watch-place-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void watchPlaceSearch(watchPlaceQ);
                  }}
                >
                  <input
                    type="search"
                    value={watchPlaceQ}
                    placeholder="Find a town, address or Eircode…"
                    aria-label="Find a place"
                    onChange={(e) => setWatchPlaceQ(e.target.value)}
                  />
                  <button type="submit" aria-label="Go to place">Go</button>
                  <button type="button" onClick={watchUseMyLocation} title="Centre on my location">
                    My location
                  </button>
                </form>
                <div className="watch-radius-row" role="radiogroup" aria-label="Radius">
                  {[250, 500, 1000, 2000, 5000, 10000].map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={`chip ${watchDraft.radius_m === r ? "chip-on" : ""}`}
                      onClick={() => setWatchDraft({ ...watchDraft, radius_m: r })}
                    >
                      {r < 1000 ? `${r} m` : `${r / 1000} km`}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={watchDraft.name}
                  placeholder="Name it — e.g. Home, Maynooth office"
                  maxLength={80}
                  onChange={(e) => setWatchDraft({ ...watchDraft, name: e.target.value })}
                />
                {watchNotice && <p className="watch-notice">{watchNotice}</p>}
                <div className="watch-actions">
                  {me?.user ? (
                    <button type="button" className="watch-save" disabled={watchSaving} onClick={saveWatchDraft}>
                      {watchSaving ? "Saving…" : "Save watch"}
                    </button>
                  ) : (
                    <button type="button" className="watch-save" onClick={() => setMode("account")}>
                      Sign in to save
                    </button>
                  )}
                  <button type="button" className="watch-cancel" onClick={() => { setWatchDraft(null); setWatchNotice(null); }}>
                    Cancel
                  </button>
                </div>
              </div>
            </>
          )}
          {!watchDraft && watchView && (
            <button
              type="button"
              className="watch-viewing-chip"
              onClick={() => { setWatchView(null); setWatchNotice(null); }}
              title="Hide this watched area"
            >
              {watchNotice ?? `Watching: ${watchView.name}`} ✕
            </button>
          )}
          {/* A map that quietly stops drawing pins reads as "there's nothing
              else here". Say when it's a subset and what to do about it. */}
          {mapData?.truncated && (
            <p className="map-truncated" role="status">
              {/* Two wordings, one meaning: the full sentence needs more width
                  than a phone has between the Layers chip and the zoom column,
                  and a banner that covers the map controls is worse than a
                  terse one. */}
              <span className="mt-long">
                Showing {mapData.features.length.toLocaleString()} of{" "}
                {mapData.matched?.toLocaleString()} in view — zoom in to see the rest
              </span>
              <span className="mt-short">
                {mapData.features.length.toLocaleString()} of{" "}
                {mapData.matched?.toLocaleString()} shown — zoom in
              </span>
            </p>
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

        {/* One button, one place. It lives on the layout rather than inside
            either pane so it does not move when the view flips — a control
            that jumps between corners is one you have to look for each time.
            Mobile only; desktop shows both panes at once. */}
        {mode === "search" && !watchDraft && (
          <button
            type="button"
            className="view-switch-btn"
            onClick={() => {
              if (mobileView === "map") {
                // Panning refreshes the pins but not the list, so the list can
                // be showing a different place than the map. Reconcile on the
                // way to it — and only when the map has actually moved, so an
                // untouched view isn't silently narrowed to the viewport.
                if (canSearchArea) searchThisArea();
                setMobileView("list");
              } else {
                setMobileView("map");
              }
            }}
          >
            {mobileView === "map" ? (
              <>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                  <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
                </svg>
                List
              </>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
                  <path d="M1.5 3.8 5.75 2v10.2L1.5 14V3.8Z" />
                  <path d="M5.75 2 10.25 3.8v10.2L5.75 12.2V2Z" />
                  <path d="M10.25 3.8 14.5 2v10.2L10.25 14V3.8Z" />
                </svg>
                Map
              </>
            )}
          </button>
        )}
      </div>

      {mode === "preplan" && (
        <main className="account-screen preplan-screen">
          <div className="account-screen-inner">
            <button type="button" className="back-to-map no-print" onClick={() => setMode("search")}>
              ← Back to map
            </button>
            <Suspense>
              <PrePlannerPanel
                onOpenApp={async (authorityId, reference) => {
                  try {
                    const { id } = await api.resolve(authorityId, reference);
                    await select(id);
                  } catch {
                    setError("That application is no longer in the current dataset.");
                  }
                }}
              />
            </Suspense>
          </div>
        </main>
      )}

      {mode === "account" && (
        <main className="account-screen">
          <div className="account-screen-inner">
            <button type="button" className="back-to-map" onClick={() => setMode("search")}>
              ← Back to map
            </button>
            <Suspense>
            <AccountPanel
              me={me}
              notice={authNotice}
              onRefresh={refreshMe}
              onOpenApp={async (authorityId, reference) => {
                try {
                  const { id } = await api.resolve(authorityId, reference);
                  // Stay in account mode: the detail sheet slides over the
                  // dashboard, and closing it lands back on the register.
                  await select(id);
                } catch {
                  setError("That application is no longer in the current dataset.");
                }
              }}
              onGoSearch={() => setMode("search")}
              onAddWatch={() => {
                setMode("search");
                startWatchDraft();
              }}
              onViewWatch={(w) => {
                setWatchDraft(null);
                setWatchNotice(null);
                setWatchView(w);
                setMode("search");
                // Zoom so the whole circle fits: 250 m → 15 down to 2 km → 12.
                setFlyTo({ lat: w.lat, lng: w.lng, zoom: 15 - Math.log2(w.radius_m / 250) });
              }}
            />
            </Suspense>
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
            className={`sheet-backdrop${sheetClosing ? " sheet-closing" : ""}`}
            onClick={closeSheet}
            aria-hidden="true"
          />
          <Suspense>
            <DetailPanel
              detail={detail}
              meta={meta}
              closing={sheetClosing}
              onClose={closeSheet}
              onSelectRelated={select}
              saved={savedByKey.has(saveKey(detail.authority_id, detail.planning_reference))}
              onToggleSave={() => toggleSave(detail.authority_id, detail.planning_reference)}
            />
          </Suspense>
        </>
      )}
    </div>
  );
}
