import { fmtDate } from "../api";
import { renderMarkdown } from "../markdown";
import type {
  HeritageItem,
  PreplanReport,
  RateBlock,
  Unavailable,
} from "../preplanApi";

function isUnavailable(v: unknown): v is Unavailable {
  return typeof v === "object" && v !== null && (v as Unavailable).unavailable === true;
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

export default function ReportView({ report }: { report: PreplanReport }) {
  const s = report.sections ?? {};
  const designations = s.designations;
  const heritage = s.heritage_points;
  const floodGround = s.flood_ground;
  const precedents = s.precedents;
  const stats = s.area_stats;

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
        {report.status === "error" && (
          <p className="report-unavailable">
            This report didn’t finish generating — the sections below are what was gathered before it stopped.
          </p>
        )}
      </header>

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
        <h3>Nearby precedents</h3>
        {isUnavailable(precedents) || !precedents ? (
          <UnavailableNote what="Nearby applications" reason={precedents?.reason} />
        ) : precedents.items.length === 0 ? (
          <p className="report-none">No applications found within 1 km in the current dataset.</p>
        ) : (
          <>
            <table className="report-precedents">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Development</th>
                  <th>Distance</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {precedents.items.map((p) => (
                  <tr key={`${p.authority_id}-${p.planning_reference}`}>
                    <td className="rp-ref">{p.planning_reference}</td>
                    <td>
                      {p.description ?? "—"}
                      {p.address_text ? <span className="rp-addr">{p.address_text}</span> : null}
                    </td>
                    <td className="rp-dist">{p.distance_m} m</td>
                    <td>
                      {p.decision ?? p.status ?? "—"}
                      {p.appeal_reference ? (
                        <span className="rp-appeal">
                          appealed{p.appeal_decision ? ` — ${p.appeal_decision}` : ""}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {precedents.deep_dives.length > 0 && (
              <div className="report-dives">
                <h4>From the decision documents</h4>
                {precedents.deep_dives.map((d, i) => (
                  <div className="report-dive" key={i}>
                    <p className="rd-doc">
                      {d.planning_reference} · {d.document}
                    </p>
                    <p>{d.extract}</p>
                  </div>
                ))}
              </div>
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

      <section className="report-section report-narrative">
        <h3>Things to consider</h3>
        <p className="report-disclaimer">
          Informational considerations drawn from the data above — not professional advice, and not a
          prediction of any decision.
        </p>
        {report.narrative ? (
          renderMarkdown(report.narrative, 0)
        ) : (
          <p className="report-none">The considerations section couldn’t be written for this report.</p>
        )}
      </section>
    </article>
  );
}
