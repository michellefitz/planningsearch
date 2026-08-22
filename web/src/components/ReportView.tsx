import { fmtDate } from "../api";
import { renderMarkdown } from "../markdown";
import type {
  HeritageItem,
  PrecedentItem,
  PreplanReport,
  RateBlock,
  Unavailable,
} from "../preplanApi";
import PropertyMedia from "./PropertyMedia";
import { StatusBadge } from "./ResultsList";

function isUnavailable(v: unknown): v is Unavailable {
  return typeof v === "object" && v !== null && (v as Unavailable).unavailable === true;
}

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

/** Static minimap of the precedents: numbered rose pins matching the list below,
 *  a larger blue pin for the site itself, auto-fit to the markers. A plain <img>
 *  so it prints. Null (no map) without a token or when items carry no coords. */
function precedentsMapUrl(report: PreplanReport, items: PrecedentItem[]): string | null {
  if (!MAPBOX_TOKEN || report.lat == null || report.lng == null) return null;
  const c = (n: number) => n.toFixed(5);
  const pins = items
    .slice(0, 8)
    .map((p, i) => (p.lat != null && p.lng != null ? `pin-s-${i + 1}+e11d48(${c(p.lng)},${c(p.lat)})` : null))
    .filter((s): s is string => s !== null);
  if (!pins.length) return null;
  // Site pin last so it draws on top of any overlapping precedent pin.
  const overlays = [...pins, `pin-l+2563eb(${c(report.lng)},${c(report.lat)})`].join(",");
  return (
    `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${overlays}/auto/660x360@2x` +
    `?padding=60&access_token=${MAPBOX_TOKEN}`
  );
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
  const rural = s.rural_housing;
  const localPlan = s.local_plan;
  const { overview, rest: narrative } = splitNarrative(report.narrative);
  const precMapUrl =
    !isUnavailable(precedents) && precedents ? precedentsMapUrl(report, precedents.items) : null;

  return (
    <article className="report">
      <header className="report-head">
        <p className=”report-kicker”>{report.intent ? “Pre-planning research report” : “Planning history report”} · #{report.id}</p>
        <h2>{report.label}</h2>
        <p className=”report-sub”>
          {report.address}
          {report.eircode ? ` · ${report.eircode}` : “”} · generated {fmtDate(report.generated_at)}
        </p>
        {report.intent && <p className=”report-intent”>”{report.intent}”</p>}
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
            {precMapUrl && (
              <figure className="report-prec-map">
                <img
                  src={precMapUrl}
                  alt="Map of the site and the numbered nearby applications"
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.parentElement!.style.display = "none";
                  }}
                />
                <figcaption>Blue pin: this site. Numbered pins match the applications below.</figcaption>
              </figure>
            )}
            <ul className="report-prec-list">
              {precedents.items.map((p, i) => (
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
                      {precMapUrl && i < 8 && <span className="rp-num">{i + 1}</span>}
                      <span className="rp-ref">
                        {p.planning_reference}
                        {(p.id != null || p.source_url) && (
                          <a
                            /* The agile councils' source_url is a keyword
                               search that does not find its own application —
                               the portal needs its internal id, which only the
                               resolver can fetch. It falls back to source_url
                               for the councils whose register URL is already a
                               deep link, so this is right for all seven. */
                            href={
                              p.id != null
                                ? `/api/applications/${p.id}/portal`
                                : (p.source_url as string)
                            }
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

      {/* Only for a proposal to build a house on a site. These run at a far
          lower grant rate than everything else a council decides, and the test
          they turn on — local need — is nowhere in the register: it is stated
          in the refusals, which is why this section quotes them. */}
      {rural && (
        <section className="report-section">
          <h3>Building a one-off house here</h3>
          <div className="report-stats">
            <Rates label={`One-off houses within ${Math.round(rural.rates.radius_m / 1000)} km`} r={rural.rates.within_radius} />
            <Rates label="One-off houses, whole authority" r={rural.rates.authority_one_off} />
            <Rates label="All applications, whole authority" r={rural.rates.authority_all} />
          </div>
          {rural.rates.authority_one_off.grant_rate != null &&
            rural.rates.authority_all.grant_rate != null && (
              <p className="report-plan">
                A one-off house is decided against a different test than an ordinary application,
                and the gap between those two rates is that test.
              </p>
            )}

          {rural.themes.length > 0 ? (
            <>
              <h4 className="rp-subhead">
                What nearby refusals turned on{" "}
                <span className="rp-muted">
                  (read from {rural.reasons_read} refused application{rural.reasons_read === 1 ? "" : "s"})
                </span>
              </h4>
              <ul className="rural-themes">
                {rural.themes.map((t) => (
                  <li key={t.key}>
                    <span className="rural-theme-label">{t.label}</span>
                    <span className="rural-theme-count">
                      {t.count} of {t.of}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="report-none">
              No refused one-off houses nearby had readable reasons, so there is nothing to
              generalise from here — check the council&rsquo;s own file for the ones listed above.
            </p>
          )}

          {rural.local_need_quote && (
            <>
              <h4 className="rp-subhead">How local need was put, in the council&rsquo;s words</h4>
              <blockquote className="rural-quote">{rural.local_need_quote}</blockquote>
            </>
          )}

          {rural.decisions.length > 0 && (
            <p className="caveat">
              Read from{" "}
              {rural.decisions
                .map((d) => `${d.planning_reference} (${(d.distance_m / 1000).toFixed(1)} km, ${d.source})`)
                .join("; ")}
              . Refusal reasons are specific to those sites — they show what the council weighs,
              not what it would decide for yours.
            </p>
          )}
        </section>
      )}

      <section className="report-section report-narrative">
        <h3>Considerations</h3>
        <p className="report-disclaimer">
          Informational considerations drawn from the data above — not professional advice, and not a
          prediction of any decision.
        </p>
        {!isUnavailable(localPlan) && localPlan && (
          <p className="report-plan">
            Applications here are decided under the{" "}
            <a href={localPlan.url} target="_blank" rel="noopener noreferrer">
              {localPlan.name} ↗
            </a>{" "}
            — the points below draw on the data in this report and point at the chapters most
            relevant to your proposal.
          </p>
        )}
        {narrative ? (
          renderMarkdown(narrative, 0)
        ) : (
          <p className="report-none">The considerations section couldn’t be written for this report.</p>
        )}
      </section>
    </article>
  );
}
