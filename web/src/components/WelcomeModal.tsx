import { useState } from "react";

const DISMISSED_KEY = "planview:welcome-dismissed";

function DataSourcesIllustration() {
  return (
    <svg viewBox="0 0 320 180" fill="none" className="welcome-illustration" aria-hidden="true">
      {/* Stacked cards representing different data sources */}
      <rect x="40" y="90" width="110" height="70" rx="6" fill="#eef0f3" stroke="#dcdee4" />
      <text x="55" y="113" fontSize="9" fontWeight="600" fill="#5a616e">Flood zones</text>
      <rect x="50" y="97" width="80" height="4" rx="2" fill="#dcdee4" />

      <rect x="105" y="60" width="110" height="70" rx="6" fill="#eaf2fe" stroke="#93c5fd" />
      <text x="120" y="83" fontSize="9" fontWeight="600" fill="#1e40af">Council portals</text>
      <rect x="115" y="90" width="70" height="4" rx="2" fill="#93c5fd" />
      <rect x="115" y="99" width="55" height="4" rx="2" fill="#bfdbfe" />
      <rect x="115" y="108" width="85" height="4" rx="2" fill="#bfdbfe" />

      <rect x="170" y="30" width="110" height="70" rx="6" fill="#f0fdf4" stroke="#86efac" />
      <text x="185" y="53" fontSize="9" fontWeight="600" fill="#166534">An Bord Pleanála</text>
      <rect x="180" y="60" width="65" height="4" rx="2" fill="#86efac" />
      <rect x="180" y="69" width="80" height="4" rx="2" fill="#bbf7d0" />

      {/* Arrow converging */}
      <path d="M85 155 L160 165" stroke="#949aa6" strokeWidth="1.5" strokeDasharray="3 3" />
      <path d="M160 95 L160 165" stroke="#949aa6" strokeWidth="1.5" strokeDasharray="3 3" />
      <path d="M235 95 L160 165" stroke="#949aa6" strokeWidth="1.5" strokeDasharray="3 3" />
      <circle cx="160" cy="168" r="6" fill="#0b62d6" />
      <text x="160" y="171" fontSize="7" fill="white" textAnchor="middle" fontWeight="700">P</text>
    </svg>
  );
}

function AiSummariesIllustration() {
  return (
    <svg viewBox="0 0 320 180" fill="none" className="welcome-illustration" aria-hidden="true">
      {/* Document with highlighted summary */}
      <rect x="70" y="15" width="180" height="150" rx="6" fill="white" stroke="#dcdee4" />

      {/* Document lines */}
      <rect x="85" y="32" width="100" height="5" rx="2" fill="#dcdee4" />
      <rect x="85" y="42" width="150" height="4" rx="2" fill="#eef0f3" />
      <rect x="85" y="50" width="130" height="4" rx="2" fill="#eef0f3" />
      <rect x="85" y="58" width="145" height="4" rx="2" fill="#eef0f3" />

      {/* AI summary highlight box */}
      <rect x="82" y="72" width="156" height="50" rx="5" fill="#eaf2fe" stroke="#93c5fd" strokeDasharray="3 2" />
      <text x="92" y="85" fontSize="7" fontWeight="600" fill="#1e40af" letterSpacing="0.5">AI SUMMARY</text>
      <rect x="92" y="92" width="130" height="4" rx="2" fill="#60a5fa" opacity="0.5" />
      <rect x="92" y="100" width="110" height="4" rx="2" fill="#60a5fa" opacity="0.5" />
      <rect x="92" y="108" width="120" height="4" rx="2" fill="#60a5fa" opacity="0.4" />

      {/* More document lines below */}
      <rect x="85" y="132" width="140" height="4" rx="2" fill="#eef0f3" />
      <rect x="85" y="140" width="100" height="4" rx="2" fill="#eef0f3" />
      <rect x="85" y="148" width="125" height="4" rx="2" fill="#eef0f3" />

      {/* Sparkle icon */}
      <circle cx="248" cy="30" r="14" fill="#eaf2fe" />
      <path d="M248 20 L250 26 L256 28 L250 30 L248 36 L246 30 L240 28 L246 26 Z" fill="#0b62d6" />
    </svg>
  );
}

function SpeedIllustration() {
  return (
    <svg viewBox="0 0 320 180" fill="none" className="welcome-illustration" aria-hidden="true">
      {/* Search bar */}
      <rect x="50" y="20" width="220" height="32" rx="16" fill="white" stroke="#dcdee4" />
      <circle cx="72" cy="36" r="7" stroke="#949aa6" strokeWidth="1.5" fill="none" />
      <line x1="77" y1="41" x2="80" y2="44" stroke="#949aa6" strokeWidth="1.5" strokeLinecap="round" />
      <text x="90" y="40" fontSize="10" fill="#949aa6">124 Sweetmount Ave, Dundrum</text>

      {/* Instant result card */}
      <rect x="60" y="60" width="200" height="44" rx="5" fill="white" stroke="#dcdee4" />
      <circle cx="76" cy="76" r="6" fill="#16a34a" />
      <text x="76" y="79" fontSize="7" fill="white" textAnchor="middle" fontWeight="700">G</text>
      <rect x="88" y="70" width="100" height="5" rx="2" fill="#17191e" />
      <rect x="88" y="80" width="155" height="4" rx="2" fill="#dcdee4" />
      <rect x="88" y="89" width="80" height="4" rx="2" fill="#eef0f3" />

      {/* Bell / alert */}
      <rect x="60" y="118" width="200" height="44" rx="5" fill="#f0fdf4" stroke="#86efac" />
      <path d="M82 140 C82 133 86 128 92 128 C98 128 102 133 102 140 L82 140 Z" fill="#16a34a" opacity="0.7" />
      <circle cx="92" cy="126" r="2" fill="#16a34a" />
      <line x1="87" y1="142" x2="97" y2="142" stroke="#16a34a" strokeWidth="1.5" strokeLinecap="round" />
      <text x="112" y="135" fontSize="8" fontWeight="600" fill="#166534">Status updated</text>
      <text x="112" y="147" fontSize="8" fill="#5a616e">SD22B/0354 — Granted</text>
    </svg>
  );
}

const STEPS = [
  {
    illustration: DataSourcesIllustration,
    title: "All planning data in one place",
    body: "PlanView pulls together data from council portals, An Bord Pleanála, the national planning register, property sales, flood zones, zoning maps, and derelict sites. You get the full picture for any location without switching between sites.",
  },
  {
    illustration: AiSummariesIllustration,
    title: "Understand applications in seconds",
    body: "Every application gets AI-generated summaries of what's proposed, why it was refused, what further information was requested, notable conditions, and appeal outcomes. You can scan and understand without opening a single document.",
  },
  {
    illustration: SpeedIllustration,
    title: "Find it fast, stay informed",
    body: "Search by address, area, or keyword and see results instantly on the map. Save applications to track them, watch an area for new activity, and get email alerts when something changes. No more logging in to check.",
  },
];

export function WelcomeModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];
  const Illustration = current.illustration;

  return (
    <div className="welcome-backdrop" onClick={onClose}>
      <div
        className="welcome-modal"
        role="dialog"
        aria-label="Welcome to PlanView"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="welcome-close" onClick={onClose} aria-label="Close">
          <svg aria-hidden="true" width={13} height={13} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" />
          </svg>
        </button>

        <div className="welcome-slide" key={step}>
          <Illustration />
          <h2>{current.title}</h2>
          <p>{current.body}</p>
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
              <button type="button" className="btn welcome-back" onClick={() => setStep(step - 1)}>
                Back
              </button>
            )}
            {isLast ? (
              <button type="button" className="btn btn-primary welcome-go" onClick={onClose}>
                Get started
              </button>
            ) : (
              <button type="button" className="btn btn-primary welcome-next" onClick={() => setStep(step + 1)}>
                Next
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
