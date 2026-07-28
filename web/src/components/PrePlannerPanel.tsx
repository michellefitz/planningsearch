import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { api, fmtDate, type AppSummary } from "../api";
import {
  preplanApi,
  type PreplanEvent,
  type PreplanProject,
  type PreplanReport,
} from "../preplanApi";
import ReportView from "./ReportView";
import { XIcon } from "./icons";

type View =
  | { kind: "list" }
  | { kind: "new" }
  | { kind: "running"; project: PreplanProject }
  | { kind: "report"; report: PreplanReport };

interface PickedLocation {
  lat: number;
  lng: number;
  address: string;
  eircode?: string | null;
}

/** Small pin-drop map: click to choose the site. */
function PinMap({ value, onPick }: { value: PickedLocation | null; onPick: (lat: number, lng: number) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
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
      center: [-6.5, 53.35],
      zoom: 9,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("click", (e) => onPickRef.current(e.lngLat.lat, e.lngLat.lng));
    mapRef.current = map;
    return () => {
      markerRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!value) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) {
      markerRef.current = new maplibregl.Marker({ color: "#1f4ed8" })
        .setLngLat([value.lng, value.lat])
        .addTo(map);
    } else {
      markerRef.current.setLngLat([value.lng, value.lat]);
    }
    map.easeTo({ center: [value.lng, value.lat], zoom: Math.max(map.getZoom(), 14), duration: 350 });
  }, [value]);

  return <div className="preplan-map" ref={containerRef} />;
}

function NewProjectForm({ onCreated, onCancel }: { onCreated: (p: PreplanProject) => void; onCancel: () => void }) {
  const [label, setLabel] = useState("");
  const [intent, setIntent] = useState("");
  const [location, setLocation] = useState<PickedLocation | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<AppSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  const runAddressSearch = useCallback(async (q: string) => {
    const seq = ++searchSeq.current;
    if (q.trim().length < 3) {
      setMatches([]);
      return;
    }
    setSearching(true);
    try {
      const res = await api.search(new URLSearchParams({ q: q.trim(), limit: "6" }));
      if (seq !== searchSeq.current) return;
      setMatches(res.results.filter((r) => r.lat != null && r.lng != null));
    } catch {
      if (seq === searchSeq.current) setMatches([]);
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => runAddressSearch(query), 250);
    return () => window.clearTimeout(t);
  }, [query, runAddressSearch]);

  const submit = async () => {
    if (!label.trim() || !intent.trim() || !location) return;
    setSubmitting(true);
    setError(null);
    try {
      const { project } = await preplanApi.createProject({
        label: label.trim(),
        intent: intent.trim(),
        lat: location.lat,
        lng: location.lng,
        address: location.address,
        eircode: location.eircode ?? null,
      });
      onCreated(project);
    } catch {
      setError("Couldn’t save the project — try again.");
      setSubmitting(false);
    }
  };

  return (
    <div className="preplan-new">
      <h3>New pre-planner project</h3>
      <div className="preplan-form">
        <label className="pf-field">
          <span>Project name</span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Our house — attic conversion"
            maxLength={120}
          />
        </label>

        <label className="pf-field">
          <span>What do you want to do here?</span>
          <textarea
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            rows={3}
            placeholder="e.g. Convert the attic with a rear dormer and two roof windows to the front"
            maxLength={1000}
          />
        </label>

        <div className="pf-field">
          <span>Where is it?</span>
          <p className="pf-hint">
            Search an address or Eircode from the planning register, or click the map to drop a pin.
          </p>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Address or Eircode…"
            aria-label="Search an address"
          />
          {(matches.length > 0 || searching) && query.trim().length >= 3 && !location && (
            <ul className="pf-matches">
              {searching && <li className="pf-searching">Searching the register…</li>}
              {matches.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setLocation({
                        lat: m.lat as number,
                        lng: m.lng as number,
                        address: m.address_text ?? m.planning_reference,
                        eircode: (m as { eircode?: string | null }).eircode ?? null,
                      });
                      setMatches([]);
                    }}
                  >
                    {m.address_text ?? m.planning_reference}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <PinMap
            value={location}
            onPick={(lat, lng) =>
              setLocation({ lat, lng, address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` })
            }
          />
          {location && (
            <p className="pf-picked">
              <span>{location.address}</span>
              <button type="button" className="pf-clear" onClick={() => setLocation(null)} aria-label="Clear location">
                <XIcon />
              </button>
            </p>
          )}
        </div>

        {error && <p className="preplan-error">{error}</p>}
        <div className="pf-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!label.trim() || !intent.trim() || !location || submitting}
            onClick={submit}
          >
            {submitting ? "Saving…" : "Save project"}
          </button>
        </div>
      </div>
    </div>
  );
}

const SECTION_LABELS: Record<string, string> = {
  designations: "Designations at the site",
  heritage_points: "Heritage within 250 m",
  flood_ground: "Flood & ground checks",
  precedents: "Nearby precedents",
  area_stats: "Area statistics",
};

function RunningView({ project, steps, sections }: { project: PreplanProject; steps: string[]; sections: Set<string> }) {
  return (
    <div className="preplan-running">
      <h3>Generating report — {project.label}</h3>
      <p className="preplan-running-sub">
        This gathers live data and reads decision documents, so it can take a minute or two.
      </p>
      <ul className="preplan-steps">
        {Object.entries(SECTION_LABELS).map(([name, label]) => (
          <li key={name} className={sections.has(name) ? "step-done" : "step-waiting"}>
            <span className="step-tick" aria-hidden="true">
              {sections.has(name) ? "✓" : ""}
            </span>
            {label}
          </li>
        ))}
      </ul>
      {steps.length > 0 && <p className="preplan-current-step">{steps[steps.length - 1]}</p>}
    </div>
  );
}

export default function PrePlannerPanel({
  onOpenApp,
}: {
  onOpenApp?: (authorityId: string, reference: string) => void;
}) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [projects, setProjects] = useState<PreplanProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runSteps, setRunSteps] = useState<string[]>([]);
  const [runSections, setRunSections] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await preplanApi.projects();
      setProjects(data.projects);
      setError(null);
    } catch {
      setError("Couldn’t load your pre-planner projects.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openReport = async (reportId: number) => {
    try {
      const { report } = await preplanApi.report(reportId);
      setView({ kind: "report", report });
    } catch {
      setError("Couldn’t open that report.");
    }
  };

  const generate = async (project: PreplanProject) => {
    setRunSteps([]);
    setRunSections(new Set());
    setView({ kind: "running", project });
    let reportId: number | null = null;
    let failed = false;
    try {
      await preplanApi.generate(project.id, (ev: PreplanEvent) => {
        if (ev.type === "progress") setRunSteps((s) => [...s, ev.step]);
        if (ev.type === "section") setRunSections((s) => new Set(s).add(ev.name));
        if (ev.type === "error") failed = true;
        if (ev.type === "done" && ev.report_id) reportId = ev.report_id;
      });
    } catch {
      failed = true;
    }
    refresh();
    if (reportId != null) {
      await openReport(reportId);
    } else {
      setError(failed ? "Report generation failed — the sections gathered were saved to the project." : null);
      setView({ kind: "list" });
    }
  };

  if (view.kind === "new") {
    return (
      <div className="preplan">
        <NewProjectForm
          onCancel={() => setView({ kind: "list" })}
          onCreated={(p) => {
            setProjects((cur) => [p, ...cur]);
            generate(p);
          }}
        />
      </div>
    );
  }

  if (view.kind === "running") {
    return (
      <div className="preplan">
        <RunningView project={view.project} steps={runSteps} sections={runSections} />
      </div>
    );
  }

  if (view.kind === "report") {
    return (
      <div className="preplan">
        <div className="preplan-report-bar no-print">
          <button type="button" className="btn" onClick={() => setView({ kind: "list" })}>
            ← All projects
          </button>
          <button type="button" className="btn" onClick={() => window.print()}>
            Print
          </button>
        </div>
        <ReportView report={view.report} onOpenApp={onOpenApp} />
      </div>
    );
  }

  return (
    <div className="preplan">
      <div className="preplan-head">
        <div>
          <h2>Pre-planner</h2>
          <p className="preplan-sub">
            Save a place and what you want to do there, then generate a research report on the
            designations, precedents and statistics that surround it.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setView({ kind: "new" })}>
          New project
        </button>
      </div>

      {error && <p className="preplan-error">{error}</p>}
      {loading ? (
        <p className="preplan-none">Loading…</p>
      ) : projects.length === 0 ? (
        <div className="preplan-empty">
          <p>No projects yet.</p>
          <p className="preplan-none">
            Start with the place you’re thinking about — your own house, or one you’re looking at — and
            describe the works. The report pulls together everything PlanView knows around that point.
          </p>
        </div>
      ) : (
        <ul className="preplan-projects">
          {projects.map((p) => {
            const hasReport = p.latest_report_id != null && p.latest_report_status === "complete";
            return (
              <li
                key={p.id}
                className={`preplan-project${hasReport ? " preplan-project-clickable" : ""}`}
                role={hasReport ? "button" : undefined}
                tabIndex={hasReport ? 0 : undefined}
                onClick={() => hasReport && openReport(p.latest_report_id as number)}
                onKeyDown={(e) => {
                  if (hasReport && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                    e.preventDefault();
                    openReport(p.latest_report_id as number);
                  }
                }}
              >
                <div className="pp-main">
                  <span className="pp-label">{p.label}</span>
                  <span className="pp-address">
                    {p.address}
                    {p.eircode ? ` · ${p.eircode}` : ""}
                  </span>
                  <span className="pp-intent">{p.intent}</span>
                </div>
                <div className="pp-side">
                  {hasReport ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        openReport(p.latest_report_id as number);
                      }}
                    >
                      Report · {fmtDate(p.latest_report_at ?? "")}
                    </button>
                  ) : p.latest_report_status === "error" ? (
                    <span className="pp-status">last run failed</span>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      generate(p);
                    }}
                  >
                    {p.latest_report_id ? "Run new report" : "Generate report"}
                  </button>
                  <button
                    type="button"
                    className="pp-delete"
                    aria-label={`Delete ${p.label}`}
                    title="Delete project"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!window.confirm(`Delete “${p.label}” and its reports?`)) return;
                      await preplanApi.deleteProject(p.id).catch(() => {});
                      refresh();
                    }}
                  >
                    <XIcon />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
