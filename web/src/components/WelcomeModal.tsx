import { useState } from "react";

const DISMISSED_KEY = "planview:welcome-dismissed";

/* One restrained palette, matching the app icon and the reference: a deep
   navy, white, a single green for the plot, and the app's action blue for the
   primary button. No gradients or extra hues. */
const NAVY = "#12294d";
const GREEN = "#2ea36a";
const MAP_BG = "#e9edf2";
const ROAD = "#ffffff";

/* ---- Screen 1: layered data sources ------------------------------------ */

const SOURCE_PILLS = [
  { key: "councils", label: "Local councils" },
  { key: "abp", label: "An Bord Pleanála" },
  { key: "zoning", label: "Zoning & development plans" },
  { key: "flood", label: "Flood zones" },
  { key: "price", label: "Price register" },
  { key: "derelict", label: "Derelict sites" },
] as const;

function PillIcon({ type }: { type: string }) {
  const c = { stroke: NAVY, strokeWidth: 1.5, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (type) {
    case "councils":
      return (
        <g {...c}>
          <path d="M2 5.5 L7 2.5 L12 5.5" />
          <line x1="2.5" y1="12" x2="11.5" y2="12" />
          <line x1="4" y1="6.5" x2="4" y2="11" />
          <line x1="7" y1="6.5" x2="7" y2="11" />
          <line x1="10" y1="6.5" x2="10" y2="11" />
        </g>
      );
    case "abp":
      return (
        <g {...c}>
          <line x1="7" y1="2.5" x2="7" y2="12" />
          <line x1="3" y1="4" x2="11" y2="4" />
          <path d="M3 4 L1.5 8 h3 Z" fill={NAVY} stroke="none" />
          <path d="M11 4 L9.5 8 h3 Z" fill={NAVY} stroke="none" />
          <line x1="5" y1="12" x2="9" y2="12" />
        </g>
      );
    case "zoning":
      return (
        <g {...c}>
          <path d="M7 2.5 L12 5.5 L7 8.5 L2 5.5 Z" />
          <path d="M2.5 8.5 L7 11 L11.5 8.5" />
        </g>
      );
    case "flood":
      return (
        <g {...c}>
          <path d="M1.5 5 q2 -2 3.5 0 t3.5 0 t3.5 0" />
          <path d="M1.5 9 q2 -2 3.5 0 t3.5 0 t3.5 0" />
        </g>
      );
    case "price":
      return (
        <g {...c}>
          <path d="M2.5 7 L7 3 L11.5 7" />
          <path d="M4 7 V11.5 H10 V7" />
        </g>
      );
    default: // derelict
      return (
        <g {...c}>
          <rect x="2.5" y="2.5" width="9" height="9" rx="1.5" strokeDasharray="2 2" />
        </g>
      );
  }
}

function DataSourcesIllustration() {
  const pillH = 30;
  const gap = 6;
  const top = 10;
  const cy = (i: number) => top + i * (pillH + gap) + pillH / 2;
  const target = { x: 250, y: cy(2.5) };
  const stackCx = 276;
  return (
    <svg viewBox="0 0 340 236" className="wm-illustration" aria-hidden="true">
      {/* dashed connectors from each pill to the stack */}
      {SOURCE_PILLS.map((_, i) => (
        <path
          key={i}
          d={`M196 ${cy(i)} C 224 ${cy(i)}, 226 ${target.y}, ${target.x} ${target.y}`}
          fill="none"
          stroke="#b7c3d6"
          strokeWidth="1.2"
          strokeDasharray="3 3"
        />
      ))}

      {/* isometric map-layer stack */}
      {[
        { cy: 196, fill: "#c6d3e6", op: 0.85 },
        { cy: 174, fill: "#b3c4dd", op: 0.95 },
      ].map((l, i) => (
        <polygon
          key={i}
          points={`${stackCx - 58},${l.cy} ${stackCx},${l.cy - 30} ${stackCx + 58},${l.cy} ${stackCx},${l.cy + 30}`}
          fill={l.fill}
          opacity={l.op}
        />
      ))}
      {/* top layer with the plot + pin */}
      <polygon
        points={`${stackCx - 58},152 ${stackCx},122 ${stackCx + 58},152 ${stackCx},182`}
        fill="#ffffff"
        stroke="#9db3d1"
        strokeWidth="1.2"
      />
      <polygon
        points={`${stackCx - 4},152 ${stackCx + 22},139 ${stackCx + 48},152 ${stackCx + 22},165`}
        fill={GREEN}
        opacity="0.95"
      />
      {/* navy map pin hovering over the plot */}
      <g transform={`translate(${stackCx + 22}, 150)`}>
        <path d="M0 0 L-6 -11 L6 -11 Z" fill={NAVY} />
        <circle cx="0" cy="-18" r="9" fill={NAVY} />
        <circle cx="0" cy="-18" r="3.4" fill="#ffffff" />
      </g>

      {/* source pills */}
      {SOURCE_PILLS.map((p, i) => {
        const y = top + i * (pillH + gap);
        return (
          <g key={p.key}>
            <rect x="4" y={y} width="192" height={pillH} rx="15" fill="#ffffff" stroke="#dfe4ec" strokeWidth="1.2" />
            <g transform={`translate(18, ${y + pillH / 2 - 7})`}>
              <PillIcon type={p.key} />
            </g>
            <text x="42" y={y + pillH / 2 + 3.5} fontSize="11" fontWeight="500" fill={NAVY}>
              {p.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ---- Screen 2: a property card over the map ---------------------------- */

function MiniMap({ variant }: { variant: "card" | "features" }) {
  // A quiet geometric map: light ground, white streets, one green plot. Each
  // variant's viewBox matches its scene's aspect so nothing is cropped.
  if (variant === "features") {
    return (
      <svg viewBox="0 0 340 128" className="wm-map" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <rect width="340" height="128" fill={MAP_BG} />
        <g stroke={ROAD} strokeWidth="9" strokeLinecap="square">
          <line x1="-10" y1="30" x2="360" y2="6" />
          <line x1="70" y1="-10" x2="150" y2="140" />
          <line x1="-10" y1="96" x2="360" y2="118" />
        </g>
        <g stroke={ROAD} strokeWidth="4" strokeLinecap="square" opacity="0.9">
          <line x1="150" y1="60" x2="360" y2="48" />
        </g>
        <polygon points="214,58 300,48 316,110 228,116" fill={GREEN} />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 340 214" className="wm-map" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="340" height="214" fill={MAP_BG} />
      <g stroke={ROAD} strokeWidth="9" strokeLinecap="square">
        <line x1="-10" y1="44" x2="360" y2="8" />
        <line x1="60" y1="-10" x2="130" y2="224" />
        <line x1="-10" y1="162" x2="360" y2="128" />
        <line x1="256" y1="-10" x2="306" y2="224" />
      </g>
      <g stroke={ROAD} strokeWidth="4" strokeLinecap="square" opacity="0.9">
        <line x1="130" y1="96" x2="360" y2="74" />
      </g>
      <polygon points="198,60 300,46 322,158 216,158" fill={GREEN} />
    </svg>
  );
}

function CardRowIcon({ type }: { type: string }) {
  const c = { stroke: NAVY, strokeWidth: 1.5, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (type) {
    case "summary":
      return <g {...c}><line x1="3" y1="4.5" x2="13" y2="4.5" /><line x1="3" y1="8" x2="13" y2="8" /><line x1="3" y1="11.5" x2="9" y2="11.5" /></g>;
    case "conditions":
      return <g {...c}><rect x="3.5" y="2.5" width="9" height="11" rx="1.5" /><path d="M5.5 7 L7 8.5 L10 5.5" /></g>;
    case "fi":
      return <g {...c}><circle cx="8" cy="8" r="5.5" /><line x1="8" y1="7.5" x2="8" y2="11" /><circle cx="8" cy="5" r="0.6" fill={NAVY} stroke="none" /></g>;
    default: // related
      return <g {...c}><circle cx="4.5" cy="4.5" r="2" /><circle cx="11.5" cy="11.5" r="2" /><line x1="6" y1="6" x2="10" y2="10" /></g>;
  }
}

const CARD_ROWS = [
  { key: "summary", label: "Summary" },
  { key: "conditions", label: "Conditions" },
  { key: "fi", label: "Further information" },
  { key: "related", label: "Related applications" },
];

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4l4 4-4 4" stroke="#aab2c0" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AiSummariesIllustration() {
  return (
    <div className="wm-scene">
      <MiniMap variant="card" />
      <div className="wm-appcard">
        <div className="wm-appcard-head">
          <span className="wm-appcard-addr">21 Swantmount Ave</span>
          <span className="wm-badge">Granted</span>
        </div>
        <div className="wm-appcard-meta">Dublin City Council · DCC/1234/25</div>
        <div className="wm-appcard-desc">
          Two-storey extension to side and rear, including new garage and associated site works.
        </div>
        <div className="wm-appcard-rows">
          {CARD_ROWS.map((r) => (
            <div key={r.key} className="wm-appcard-row">
              <span className="wm-row-icon">
                <svg width="16" height="16" viewBox="0 0 16 16"><CardRowIcon type={r.key} /></svg>
              </span>
              <span className="wm-row-label">{r.label}</span>
              <Chevron />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---- Screen 3: search / save / alerts --------------------------------- */

function FeatureIcon({ type }: { type: string }) {
  const c = { stroke: NAVY, strokeWidth: 1.7, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (type === "search")
    return <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><g {...c}><circle cx="9.5" cy="9.5" r="6" /><line x1="14" y1="14" x2="18.5" y2="18.5" /></g></svg>;
  if (type === "star")
    return <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M11 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4L11 15.9 6.2 18l.9-5.4L3.2 8.7l5.4-.8L11 3z" {...c} /></svg>;
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <g {...c}>
        <path d="M6 9a5 5 0 0 1 10 0c0 4 1.5 5 1.5 5h-13S6 13 6 9z" />
        <path d="M9.2 18a2 2 0 0 0 3.6 0" />
      </g>
    </svg>
  );
}

const FEATURES = [
  { icon: "search", title: "Search", desc: "Find applications instantly by address, area, or keyword" },
  { icon: "star", title: "Save", desc: "Save applications and track them over time" },
  { icon: "bell", title: "Alerts", desc: "Watch an area and get emailed when something changes" },
];

function BellBadgeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 22 22" aria-hidden="true">
      <g stroke="#ffffff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 9a5 5 0 0 1 10 0c0 4 1.5 5 1.5 5h-13S6 13 6 9z" />
        <path d="M9.2 18a2 2 0 0 0 3.6 0" />
      </g>
    </svg>
  );
}

function AlertsScene() {
  return (
    <div className="wm-scene wm-scene-short">
      <MiniMap variant="features" />
      <div className="wm-badge-pin" aria-hidden="true">
        <span className="wm-newbadge"><BellBadgeIcon /> New application</span>
        <svg className="wm-pin-line" viewBox="0 0 40 44" fill="none">
          <line x1="20" y1="0" x2="20" y2="30" stroke={NAVY} strokeWidth="2" />
          <path d="M20 44 L14 31 L26 31 Z" fill={NAVY} />
          <circle cx="20" cy="27" r="8" fill={NAVY} />
          <circle cx="20" cy="27" r="3" fill="#ffffff" />
        </svg>
      </div>
    </div>
  );
}

/* ---- Shell ------------------------------------------------------------- */

const STEPS = ["sources", "summaries", "alerts"] as const;

export function WelcomeModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;

  return (
    <div className="welcome-backdrop" onClick={onClose}>
      <div className="welcome-modal" role="dialog" aria-label="Welcome to PlanView" onClick={(e) => e.stopPropagation()}>
        <div className="wm-top">
          <div className="wm-segments" aria-hidden="true">
            {STEPS.map((_, i) => (
              <span key={i} className={`wm-segment${i === step ? " wm-segment-on" : ""}`} />
            ))}
          </div>
          <button type="button" className="welcome-close" onClick={onClose} aria-label="Close">
            <svg aria-hidden="true" width={13} height={13} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" />
            </svg>
          </button>
        </div>

        <div className="welcome-slide" key={step}>
          {step === 0 && (
            <>
              <DataSourcesIllustration />
              <h2>All planning data<br />in one place</h2>
              <p>We pull together multiple council and national data sources so you get the full picture for any property, all on one screen.</p>
            </>
          )}
          {step === 1 && (
            <>
              <AiSummariesIllustration />
              <h2>Understand applications<br />in seconds</h2>
              <p>AI-generated plain-English summaries of every application, with key details, status, conditions and related applications — so you can scan and understand without opening a single document.</p>
            </>
          )}
          {step === 2 && (
            <>
              <h2>Find it fast,<br />stay informed</h2>
              <div className="wm-features">
                {FEATURES.map((f) => (
                  <div key={f.icon} className="wm-feature">
                    <span className="wm-feature-icon"><FeatureIcon type={f.icon} /></span>
                    <div>
                      <strong>{f.title}</strong>
                      <span>{f.desc}</span>
                    </div>
                  </div>
                ))}
              </div>
              <AlertsScene />
            </>
          )}
        </div>

        <div className="welcome-footer">
          <div className="welcome-dots">
            {STEPS.map((_, i) => (
              <button
                key={i}
                type="button"
                className={`welcome-dot${i === step ? " welcome-dot-active" : ""}`}
                onClick={() => setStep(i)}
                aria-label={`Step ${i + 1}`}
              />
            ))}
          </div>
          <div className="welcome-nav">
            {step > 0 && (
              <button type="button" className="wm-back" onClick={() => setStep(step - 1)}>
                Back
              </button>
            )}
            {isLast ? (
              <button type="button" className="wm-primary" onClick={onClose}>
                Get started
              </button>
            ) : (
              <button type="button" className="wm-primary" onClick={() => setStep(step + 1)}>
                Next
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3 8h9M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function shouldShowWelcome(): boolean {
  try {
    return !localStorage.getItem(DISMISSED_KEY);
  } catch {
    return false;
  }
}

export function dismissWelcome(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {}
}
