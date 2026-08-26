import { fmtDate } from "../api";
import { renderMarkdown } from "../markdown";
import type {
  AppealDetail,
  ConditionTheme,
  FITheme,
  HeritageItem,
  NearbySection,
  PrecedentItem,
  PreplanReport,
  RateBlock,
  SiteConstraints,
  Unavailable,
} from "../preplanApi";
import PropertyMedia from "./PropertyMedia";
import { StatusBadge } from "./ResultsList";

function isUnavailable(v: unknown): v is Unavailable {
  return typeof v === "object" && v !== null && (v as Unavailable).unavailable === true;
}

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

const WORK_TYPE_LABELS: Record<string, string> = {
  extension: "Extensions & conversions",
  attic_conversion: "Attic conversions",
  new_dwelling: "New dwellings",
  change_of_use: "Change of use",
  demolition: "Demolition",
  retention: "Retention",
  other: "Other",
};

function precedentsMapUrl(report: PreplanReport, items: PrecedentItem[]): string | null {
  if (!MAPBOX_TOKEN || report.lat == null || report.lng == null) return null;
  const c = (n: number) => n.toFixed(5);
  const pins = items
    .slice(0, 8)
    .map((p, i) => (p.lat != null && p.lng != null ? `pin-s-${i + 1}+e11d48(${c(p.lng)},${c(p.lat)})` : null))
    .filter((s): s is string => s !== null);
  if (!pins.length) return null;
  const overlays = [...pins, `pin-l+2563eb(${c(report.lng)},${c(report.lat)})`].join(",");
  return (
    `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${overlays}/auto/660x360@2x` +
    `?padding=60&access_token=${MAPBOX_TOKEN}`
  );
}

function UnavailableNote({ what, reason }: { what: string; reason?: string }) {
  return (
    <p className="report-unavailable">
      {what} couldn't be checked{reason ? ` — ${reason}` : ""}.
    </p>
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

function portalHref(p: PrecedentItem): string | null {
  if (p.id != null) return `/api/applications/${p.id}/portal`;
  if (p.source_url) return p.source_url;
  return null;
}

function isExpired(decisionDate: string | null): boolean {
  if (!decisionDate) return false;
  const expiry = new Date(decisionDate);
  expiry.setFullYear(expiry.getFullYear() + 5);
  return expiry < new Date();
}

function SiteConstraintsSection({ constraints }: { constraints: SiteConstraints }) {
  const { designations, heritage, flood } = constraints;
  return (
    <dl className="report-constraints">
      {designations.items.length > 0 ? (
        designations.items.map((d, i) => (
          <div key={i}>
            <dt>{d.kind}</dt>
            <dd>
              <strong>{d.name}</strong> · {d.detail}
              <br />
              <span className="hint">{d.meaning}</span>
            </dd>
          </div>
        ))
      ) : (
        <div>
          <dt>Designations</dt>
          <dd>No zoning, nature, archaeology or conservation-area designations found</dd>
        </div>
      )}

      <div>
        <dt>Flood risk</dt>
        <dd>
          {isUnavailable(flood.flood)
            ? "couldn't be checked"
            : flood.flood.at_risk
              ? `within an indicative flood extent (${flood.flood.scenarios.join("; ")})`
              : "not within a mapped flood extent"}
        </dd>
      </div>

      <div>
        <dt>Groundwater</dt>
        <dd>
          {isUnavailable(flood.groundwater)
            ? "couldn't be checked"
            : flood.groundwater
              ? `${flood.groundwater.description || flood.groundwater.category}${flood.groundwater.meaning ? ` — ${flood.groundwater.meaning}` : ""}`
              : "no mapped category at this point"}
        </dd>
      </div>

      <div>
        <dt>Radon</dt>
        <dd>couldn't be checked — check your area on the EPA radon map at epa.ie</dd>
      </div>

      <div>
        <dt>Protected & listed buildings</dt>
        <dd>
          {isUnavailable(heritage.niah) ? (
            "couldn't be checked"
          ) : heritage.niah.length === 0 ? (
            "none within 250 m"
          ) : (
            <ul className="report-heritage">
              {heritage.niah.map((it: HeritageItem, i: number) => (
                <li key={i}>
                  {it.url ? (
                    <a href={it.url} target="_blank" rel="noreferrer">{it.name}</a>
                  ) : (
                    it.name
                  )}
                  {it.distance_m != null && ` · ${it.distance_m} m`}
                  {it.ref && ` · ${it.ref}`}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>

      <div>
        <dt>Recorded monuments</dt>
        <dd>
          {isUnavailable(heritage.smr) ? (
            "couldn't be checked"
          ) : heritage.smr.length === 0 ? (
            "none within 250 m"
          ) : (
            <ul className="report-heritage">
              {heritage.smr.map((it: HeritageItem, i: number) => (
                <li key={i}>
                  {it.name}
                  {it.distance_m != null && ` · ${it.distance_m} m`}
                  {it.ref && ` · ${it.ref}`}
                  {it.notes && <span className="rh-notes"> — {it.notes}</span>}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>

      {designations.failed.length > 0 && (
        <div>
          <dt>Not checked</dt>
          <dd>{designations.failed.join(", ")}</dd>
        </div>
      )}
    </dl>
  );
}

function AddressHistoryCard({ p }: { p: PrecedentItem }) {
  const href = portalHref(p);
  const granted = p.status === "granted" || p.decision === "granted" || p.decision === "grant" || (p.status_label ?? "").toLowerCase().includes("grant");
  return (
    <div className="report-prec">
      <div className="rp-top">
        <span className="rp-ref">
          {p.planning_reference}
          {href && (
            <a href={href} target="_blank" rel="noopener noreferrer" title="View on the council's planning register"> ↗</a>
          )}
        </span>
        <StatusBadge status={p.status ?? "unknown"} label={p.status_label ?? p.status ?? "Unknown"} />
        {p.decision_date && <span className="rp-date">{fmtDate(p.decision_date)}</span>}
        {granted && isExpired(p.decision_date) && <span className="rp-expired">(expired)</span>}
      </div>
      <p className="rp-summary">{p.ai_summary ?? p.description ?? "—"}</p>
      {granted && (
        <p className="rp-commencement">
          {p.completion_date
            ? `Completed ${fmtDate(p.completion_date)}`
            : p.commencement_date
              ? `Commenced ${fmtDate(p.commencement_date)}`
              : "No commencement notice"}
        </p>
      )}
    </div>
  );
}

function NearbyCard({ p }: { p: PrecedentItem }) {
  const href = portalHref(p);
  return (
    <div className="report-prec">
      <div className="rp-top">
        <span className="rp-ref">
          {p.planning_reference}
          {href && (
            <a href={href} target="_blank" rel="noopener noreferrer" title="View on the council's planning register"> ↗</a>
          )}
        </span>
        <StatusBadge status={p.status ?? "unknown"} label={p.status_label ?? p.status ?? "Unknown"} />
        <span className="rp-dist">{p.distance_m} m</span>
      </div>
      <p className="rp-summary">{p.ai_summary ?? p.description ?? "—"}</p>
    </div>
  );
}

function ConditionThemesBlock({ themes }: { themes: ConditionTheme[] }) {
  if (!themes.length) return null;
  return (
    <div className="report-condition-themes">
      <h4>Condition themes</h4>
      {themes.map((t, i) => (
        <div key={i} className="report-theme-group">
          <strong>{t.theme}</strong>
          <ul>
            {t.examples.map((ex, j) => (
              <li key={j}>
                {ex.reference} · {ex.address} — {ex.summary}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function AppealsBlock({ appeals }: { appeals: AppealDetail[] }) {
  if (!appeals.length) return null;
  return (
    <div className="report-appeals">
      <h4>Appeals in this area</h4>
      <ul>
        {appeals.map((a, i) => (
          <li key={i}>
            <strong>{a.reference}</strong> · {a.address}
            <br />
            {a.proposal}
            <br />
            Council: {a.council_decision}. Appeal: {a.appeal_outcome}.
            {a.what_changed && <> What changed: {a.what_changed}</>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FIThemesBlock({ themes }: { themes: FITheme[] }) {
  if (!themes.length) return null;
  return (
    <div className="report-fi-themes">
      <h4>Further Information patterns</h4>
      <ul>
        {themes.map((t, i) => (
          <li key={i}>
            <strong>{t.theme}</strong> ({t.count})
            {t.examples.length > 0 && (
              <ul>
                {t.examples.map((ex, j) => (
                  <li key={j}>{ex.reference} · {ex.address}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OfficersNote({ officers }: { officers: Array<{ name: string; count: number }> }) {
  if (!officers.length) return null;
  const text = officers.map((o) => `${o.name} (${o.count} decision${o.count === 1 ? "" : "s"})`).join(", ");
  return <p className="report-officers">Recent applications in this area were assessed by {text}.</p>;
}

export default function ReportView({
  report,
  onOpenApp,
}: {
  report: PreplanReport;
  onOpenApp?: (authorityId: string, reference: string) => void;
}) {
  const s = report.sections ?? {};

  // Backward compatibility: build site_constraints from legacy keys if needed.
  const constraints: SiteConstraints | Unavailable | null = s.site_constraints ??
    (s.designations
      ? isUnavailable(s.designations)
        ? s.designations
        : {
            designations: s.designations,
            heritage: isUnavailable(s.heritage_points) || !s.heritage_points
              ? { niah: [] as HeritageItem[], smr: [] as HeritageItem[] }
              : s.heritage_points,
            flood: isUnavailable(s.flood_ground) || !s.flood_ground
              ? { flood: { unavailable: true as const, reason: "unavailable" }, groundwater: null, radon: { unavailable: true as const, reason: "unavailable" } }
              : s.flood_ground,
          }
      : null);

  // Backward compatibility: split old precedents into address/nearby.
  const addressHistory = s.address_history ??
    (s.precedents && !isUnavailable(s.precedents) ? { items: [] } : null);
  const nearby: NearbySection | Unavailable | null = s.nearby ??
    (s.precedents
      ? isUnavailable(s.precedents)
        ? s.precedents
        : { items: s.precedents.items, officers: [], appeals: [], fi_count: 0, condition_themes: [], fi_themes: [] }
      : null);

  const stats = s.area_stats;
  const rural = s.rural_housing;
  const localPlan = s.local_plan;
  const atAGlance = s.at_a_glance;
  const narrative = report.narrative;

  const nearbyItems = !isUnavailable(nearby) && nearby ? nearby.items : [];
  const precMapUrl = nearbyItems.length ? precedentsMapUrl(report, nearbyItems) : null;

  // Group nearby items by work_type.
  const groupedNearby = new Map<string, PrecedentItem[]>();
  for (const item of nearbyItems) {
    const wt = item.work_type ?? "other";
    const list = groupedNearby.get(wt) ?? [];
    list.push(item);
    groupedNearby.set(wt, list);
  }

  // Sort address history newest first.
  const addressItems = (!isUnavailable(addressHistory) && addressHistory?.items ? [...addressHistory.items] : [])
    .sort((a, b) => {
      const da = a.received_date ?? a.decision_date ?? "";
      const db = b.received_date ?? b.decision_date ?? "";
      return db.localeCompare(da);
    });

  return (
    <article className="report">
      {/* 1. Property header */}
      <header className="report-head">
        <p className="report-kicker">Property report &middot; #{report.id}</p>
        <h2>{report.label}</h2>
        <p className="report-sub">
          {report.address}
          {report.eircode ? ` · ${report.eircode}` : ""} · generated {fmtDate(report.generated_at)}
        </p>
        {report.intent && <p className="report-intent">"{report.intent}"</p>}
        <PropertyMedia lat={report.lat} lng={report.lng} address={report.address} />
        {report.status === "error" && (
          <p className="report-unavailable">
            This report didn't finish generating — the sections below are what was gathered before it stopped.
          </p>
        )}
      </header>

      {/* 2. At a glance */}
      {atAGlance && (
        <section className="report-section report-overview">
          <h3>At a glance</h3>
          <p className="report-disclaimer">
            AI research summary — informational, not professional advice, and not a prediction of any decision.
          </p>
          <p>{atAGlance}</p>
        </section>
      )}

      {/* 3. Site constraints */}
      <section className="report-section">
        <h3>Site constraints</h3>
        {isUnavailable(constraints) || !constraints ? (
          <UnavailableNote what="Site constraints" reason={isUnavailable(constraints) ? constraints.reason : undefined} />
        ) : (
          <SiteConstraintsSection constraints={constraints} />
        )}
      </section>

      {/* 4. Planning history at this address */}
      <section className="report-section">
        <h3>Planning history at this address</h3>
        {isUnavailable(addressHistory) ? (
          <UnavailableNote what="Address history" reason={addressHistory.reason} />
        ) : addressItems.length === 0 ? (
          <p className="report-none">No planning applications found at this address.</p>
        ) : (
          <ul className="report-prec-list">
            {addressItems.map((p) => (
              <li key={`${p.authority_id}-${p.planning_reference}`}>
                <AddressHistoryCard p={p} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 5. What happened nearby */}
      <section className="report-section">
        <h3>What happened nearby</h3>
        {isUnavailable(nearby) || !nearby ? (
          <UnavailableNote what="Nearby applications" reason={isUnavailable(nearby) ? nearby.reason : undefined} />
        ) : nearbyItems.length === 0 ? (
          <p className="report-none">No applications found within 1 km in the current dataset.</p>
        ) : (
          <>
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

            {[...groupedNearby.entries()]
              .sort(([a], [b]) => {
                const order = Object.keys(WORK_TYPE_LABELS);
                return order.indexOf(a) - order.indexOf(b);
              })
              .map(([wt, items]) => (
                <div key={wt} className="report-nearby-group">
                  <h4>{WORK_TYPE_LABELS[wt] ?? wt}</h4>
                  <ul className="report-prec-list">
                    {items.map((p) => (
                      <li key={`${p.authority_id}-${p.planning_reference}`}>
                        <NearbyCard p={p} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}

            <ConditionThemesBlock themes={nearby.condition_themes ?? []} />
            <AppealsBlock appeals={nearby.appeals ?? []} />
            <FIThemesBlock themes={nearby.fi_themes ?? []} />
            <OfficersNote officers={nearby.officers ?? []} />
          </>
        )}
      </section>

      {/* 6. How this area decides */}
      <section className="report-section">
        <h3>How this area decides</h3>
        {isUnavailable(stats) || !stats ? (
          <UnavailableNote what="Area statistics" reason={isUnavailable(stats) ? stats.reason : undefined} />
        ) : (
          <div className="report-stats">
            <Rates label="Within 2 km" r={stats.within_2km} />
            <Rates label="Across the authority" r={stats.authority} />
          </div>
        )}
      </section>

      {/* Rural housing — conditional, unchanged */}
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

      {/* 7. Considerations */}
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
          <p className="report-none">The considerations section couldn't be written for this report.</p>
        )}
      </section>
    </article>
  );
}
