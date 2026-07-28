import { fmtDate } from "../api";
import { renderMarkdown } from "../markdown";
import type {
  HeritageItem,
  PreplanReport,
  RateBlock,
  Unavailable,
} from "../preplanApi";
import PropertyMedia from "./PropertyMedia";
import { StatusBadge } from "./ResultsList";

function isUnavailable(v: unknown): v is Unavailable {
  return typeof v === "object" && v !== null && (v as Unavailable).unavailable === true;
}

/** Split the narrative's leading **Overview** section from the rest, so the
 *  quick take renders at the top of the report and the detail at the bottom. */
function splitNarrative(narrative: string | null): { overview: string | null; rest: string | null } {
  if (!narrative) return { overview: null, rest: null };
  const m = narrative.match(/\*\*Overview\*\*\s*([\s\S]*?)(?=\n\s*\*\*|$)/);
  if (!m) return { overview: null, rest: narrative };
  const rest = (narrative.slice(0, m.index) + narrative.slice((m.index ?? 0) + m[0].length)).trim();
  return { overview: m[1].trim() || null, rest: rest || null };
}

function UnavailableNote({ what, reason }: { what: string; reason?: string }) {
  return (
    <p className="report-unavailable">
      {what} couldn’t be checked{reason ? ` — ${reason}` : ""}.
    </p>
  );
}

function HeritageList({ title, items }: { title: string; items: HeritageItem[] | Unavailable }) {
  if (isUnavailable(items)) return <UnavailableNote what={title} reason={items.reason} />;
  if (!items.length) return <p className="report-none">{title}: none within 250 m.</p>;
  return (
    <div className="report-heritage-group">
      <h4>{title}</h4>
      <ul className="report-heritage">
        {items.map((it, i) => (
          <li key={i}>
            <div className="rh-row">
              <span className="rh-name">
                {it.url ? (
                  <a href={it.url} target="_blank" rel="noreferrer">
                    {it.name}
                  </a>
                ) : (
                  it.name
                )}
              </span>
              {it.detail && <span className="rh-detail">{it.detail}</span>}
              <span className="rh-dist">
                {it.distance_m != null ? `${it.distance_m} m` : ""}
                {it.ref ? ` · ${it.ref}` : ""}
              </span>
            </div>
            {it.notes && <p className="rh-notes">{it.notes}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Rates({ label, r }: { label: string; r: RateBlock }) {
  return (
    <div className="report-rates">
      <h4>{label}</h4>
      <dl>
        <div>
          <dt>Applications</dt>
          <dd>{r.total.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Grant rate</dt>
          <dd>{r.grant_rate != null ? `${r.grant_rate}%` : "—"}</dd>
        </div>
        <div>
          <dt>Refused</dt>
          <dd>{r.refused.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Appealed</dt>
          <dd>{r.appealed.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Median decision</dt>
          <dd>{r.median_decision_days != null ? `${r.median_decision_days} days` : "—"}</dd>
        </div>
      </dl>
    </div>
  );
}

export default function ReportView({
  report,
  onOpenApp,
}: {
  report: PreplanReport;
  onOpenApp?: (authorityId: string, reference: string) => void;
}) {
  const s = report.sections ?? {};
  const designations = s.designations;
  const heritage = s.heritage_points;
  const floodGround = s.flood_ground;
  const precedents = s.precedents;
  const stats = s.area_stats;
  const localPlan = s.local_plan;
  const { overview, rest: narrative } = splitNarrative(report.narrative);

  return (
    <article className="report">
      <header className="report-head">
        <p className="report-kicker">Pre-planning research report · #{report.id}</p>
        <h2>{report.label}</h2>
        <p className="report-sub">
          {report.address}
          {report.eircode ? ` · ${report.eircode}` : ""} · generated {fmtDate(report.generated_at)}
        </p>
        <p className="report-intent">“{report.intent}”</p>
        <PropertyMedia lat={report.lat} lng={report.lng} address={report.address} />
        {report.status === "error" && (
          <p className="report-unavailable">
            This report didn’t finish generating — the sections below are what was gathered before it stopped.
          </p>
        )}
      </header>

      {overview && (
        <section className="report-section report-overview">
          <h3>At a glance</h3>
          <p className="report-disclaimer">
            AI research summary — informational, not advice or a prediction.
          </p>
          {renderMarkdown(overview, 90)}
        </section>
      )}

      <section className="report-section">
        <h3>Designations at this site</h3>
        {isUnavailable(designations) || !designations ? (
          <UnavailableNote what="Designations" reason={designations?.reason} />
        ) : (
          <>
            {designations.items.length ? (
              <ul className="report-designations">
                {designations.items.map((d, i) => (
                  <li key={i}>
                    <span className="rd-kind">{d.kind}</span>
                    <span className="rd-name">
                      {d.name}
                      {d.detail && <span className="rd-detail"> · {d.detail}</span>}
                    </span>
                    <span className="rd-meaning">{d.meaning}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="report-none">
                No zoning, nature, archaeology or conservation-area designations found at this exact point.
              </p>
            )}
            {designations.failed.length > 0 && (
              <p className="report-unavailable">Couldn’t be checked: {designations.failed.join(", ")}.</p>
            )}
          </>
        )}
      </section>

      <section className="report-section">
        <h3>How this area decides</h3>
        {isUnavailable(stats) || !stats ? (
          <UnavailableNote what="Area statistics" reason={stats?.reason} />
        ) : (
          <div className="report-stats">
            <Rates label="Within 2 km" r={stats.within_2km} />
            <Rates label="Across the authority" r={stats.authority} />
          </div>
        )}
      </section>

      <section className="report-section">
        <h3>Nearby precedents</h3>
        {isUnavailable(precedents) || !precedents ? (
          <UnavailableNote what="Nearby applications" reason={precedents?.reason} />
        ) : precedents.items.length === 0 ? (
          <p className="report-none">No applications found within 1 km in the current dataset.</p>
        ) : (
          <>
            <p className="report-hint no-print">Click an application to open its full record.</p>
            <ul className="report-prec-list">
              {precedents.items.map((p) => (
                <li key={`${p.authority_id}-${p.planning_reference}`}>
                  <div
                    className={`report-prec${onOpenApp ? " report-prec-clickable" : ""}`}
                    role={onOpenApp ? "button" : undefined}
                    tabIndex={onOpenApp ? 0 : undefined}
                    onClick={() => onOpenApp?.(p.authority_id, p.planning_reference)}
                    onKeyDown={(e) => {
                      if (onOpenApp && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        onOpenApp(p.authority_id, p.planning_reference);
                      }
                    }}
                  >
                    <div className="rp-top">
                      <span className="rp-ref">
                        {p.planning_reference}
                        {p.source_url && (
                          <a
                            href={p.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="View on the council's planning register"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {" "}
                            ↗
                          </a>
                        )}
                      </span>
                      <StatusBadge status={p.status ?? "unknown"} label={p.status_label ?? p.status ?? "Unknown"} />
                      {p.appeal_reference && (
                        <span className="rp-appeal-pill">
                          Appealed{p.appeal_decision ? ` · ${p.appeal_decision}` : ""}
                        </span>
                      )}
                      <span className="rp-dist">{p.distance_m} m</span>
                    </div>
                    <p className="rp-summary">{p.ai_summary ?? p.description ?? "—"}</p>
                    {p.address_text && <p className="rp-addr">{p.address_text}</p>}
                  </div>
                </li>
              ))}
            </ul>
            {precedents.deep_dives.length > 0 && (
              <div className="report-dives">
                <h4>From the decision documents</h4>
                {precedents.deep_dives.map((d, i) => (
                  <div className="report-dive" key={i}>
                    <p className="rd-doc">
                      {d.planning_reference} · {d.document}
                    </p>
                    <div className="rd-extract">{renderMarkdown(d.extract, 40 + i)}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <section className="report-section">
        <h3>Flood & ground</h3>
        {isUnavailable(floodGround) || !floodGround ? (
          <UnavailableNote what="Flood and ground conditions" reason={floodGround?.reason} />
        ) : (
          <ul className="report-ground">
            <li>
              <span className="rg-label">Flood extents</span>
              {isUnavailable(floodGround.flood) ? (
                <span className="rg-value">couldn’t be checked</span>
              ) : floodGround.flood.at_risk ? (
                <span className="rg-value rg-flag">
                  within an indicative flood extent ({floodGround.flood.scenarios.join("; ")})
                </span>
              ) : (
                <span className="rg-value">not within a mapped flood extent</span>
              )}
            </li>
            <li>
              <span className="rg-label">Groundwater vulnerability</span>
              {isUnavailable(floodGround.groundwater) ? (
                <span className="rg-value">couldn’t be checked</span>
              ) : floodGround.groundwater ? (
                <span className="rg-value">
                  {floodGround.groundwater.description || floodGround.groundwater.category}
                  {floodGround.groundwater.meaning ? ` — ${floodGround.groundwater.meaning}` : ""}
                </span>
              ) : (
                <span className="rg-value">no mapped category at this point</span>
              )}
            </li>
            <li>
              <span className="rg-label">Radon</span>
              <span className="rg-value">
                couldn’t be checked — check your area on the EPA radon map at epa.ie
              </span>
            </li>
          </ul>
        )}
      </section>

      <section className="report-section">
        <h3>Heritage within 250 m</h3>
        {isUnavailable(heritage) || !heritage ? (
          <UnavailableNote what="Heritage records" reason={heritage?.reason} />
        ) : (
          <>
            <HeritageList title="Protected & listed buildings (NIAH)" items={heritage.niah} />
            <HeritageList title="Recorded monuments (SMR)" items={heritage.smr} />
          </>
        )}
      </section>

      {!isUnavailable(localPlan) && localPlan && (
        <section className="report-section">
          <h3>The plan this would be judged against</h3>
          <p className="report-plan">
            Applications here are decided under the{" "}
            <a href={localPlan.url} target="_blank" rel="noopener noreferrer">
              {localPlan.name} ↗
            </a>
            . The “Things to consider” section below points at the chapters most relevant to your
            proposal — worth reading before you apply.
          </p>
        </section>
      )}

      <section className="report-section report-narrative">
        <h3>Things to consider</h3>
        <p className="report-disclaimer">
          Informational considerations drawn from the data above — not professional advice, and not a
          prediction of any decision.
        </p>
        {narrative ? (
          renderMarkdown(narrative, 0)
        ) : (
          <p className="report-none">The considerations section couldn’t be written for this report.</p>
        )}
      </section>
    </article>
  );
}
