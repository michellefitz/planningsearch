import { useState } from "react";

const DISMISSED_KEY = "planview:welcome-dismissed";

function DataSourcesIllustration() {
  return (
    <svg viewBox="0 0 320 180" fill="none" className="welcome-illustration" aria-hidden="true">
      {/* Central property card */}
      <rect x="100" y="50" width="120" height="80" rx="6" fill="white" stroke="#dcdee4" strokeWidth="1.5" />
      <rect x="112" y="62" width="96" height="10" rx="3" fill="#17191e" opacity="0.8" />
      <text x="112" y="70" fontSize="8" fontWeight="600" fill="white">124 Sweetmount Ave</text>
      <rect x="112" y="78" width="60" height="4" rx="2" fill="#dcdee4" />
      <rect x="112" y="86" width="80" height="4" rx="2" fill="#eef0f3" />
      <rect x="112" y="94" width="50" height="4" rx="2" fill="#eef0f3" />
      <circle cx="196" cy="68" r="8" fill="#16a34a" opacity="0.9" />
      <text x="196" y="71" fontSize="7" fill="white" textAnchor="middle" fontWeight="700">G</text>

      {/* Source labels radiating out */}
      <rect x="10" y="12" width="90" height="22" rx="11" fill="#eaf2fe" stroke="#93c5fd" />
      <text x="55" y="26" fontSize="7.5" fill="#1e40af" textAnchor="middle" fontWeight="500">Dublin City Council</text>
      <line x1="100" y1="33" x2="130" y2="55" stroke="#93c5fd" strokeWidth="1" strokeDasharray="3 2" />

      <rect x="120" y="4" width="80" height="22" rx="11" fill="#f0fdf4" stroke="#86efac" />
      <text x="160" y="18" fontSize="7.5" fill="#166534" textAnchor="middle" fontWeight="500">An Bord Pleanála</text>
      <line x1="160" y1="26" x2="160" y2="50" stroke="#86efac" strokeWidth="1" strokeDasharray="3 2" />

      <rect x="220" y="12" width="90" height="22" rx="11" fill="#fef3c7" stroke="#fcd34d" />
      <text x="265" y="26" fontSize="7.5" fill="#92400e" textAnchor="middle" fontWeight="500">Flood zones</text>
      <line x1="220" y1="33" x2="195" y2="55" stroke="#fcd34d" strokeWidth="1" strokeDasharray="3 2" />

      <rect x="15" y="140" width="75" height="22" rx="11" fill="#fce7f3" stroke="#f9a8d4" />
      <text x="52" y="154" fontSize="7.5" fill="#9d174d" textAnchor="middle" fontWeight="500">Price Register</text>
      <line x1="90" y1="145" x2="120" y2="125" stroke="#f9a8d4" strokeWidth="1" strokeDasharray="3 2" />

      <rect x="120" y="148" width="80" height="22" rx="11" fill="#ede9fe" stroke="#c4b5fd" />
      <text x="160" y="162" fontSize="7.5" fill="#5b21b6" textAnchor="middle" fontWeight="500">Zoning maps</text>
      <line x1="160" y1="148" x2="160" y2="130" stroke="#c4b5fd" strokeWidth="1" strokeDasharray="3 2" />

      <rect x="225" y="140" width="85" height="22" rx="11" fill="#f1f5f9" stroke="#cbd5e1" />
      <text x="267" y="154" fontSize="7.5" fill="#475569" textAnchor="middle" fontWeight="500">Derelict sites</text>
      <line x1="230" y1="145" x2="200" y2="125" stroke="#cbd5e1" strokeWidth="1" strokeDasharray="3 2" />
    </svg>
  );
}

function AiSummariesIllustration() {
  return (
    <svg viewBox="0 0 320 180" fill="none" className="welcome-illustration" aria-hidden="true">
      {/* Application card */}
      <rect x="45" y="10" width="230" height="160" rx="6" fill="white" stroke="#dcdee4" />

      {/* Header with reference */}
      <rect x="58" y="22" width="90" height="5" rx="2" fill="#17191e" opacity="0.7" />
      <rect x="58" y="31" width="140" height="4" rx="2" fill="#dcdee4" />

      {/* Summary block */}
      <rect x="55" y="44" width="210" height="38" rx="5" fill="#eaf2fe" stroke="#93c5fd" strokeDasharray="3 2" />
      <text x="65" y="55" fontSize="7" fontWeight="600" fill="#1e40af" letterSpacing="0.5">SUMMARY</text>
      <rect x="65" y="60" width="185" height="3.5" rx="1.5" fill="#60a5fa" opacity="0.4" />
      <rect x="65" y="67" width="150" height="3.5" rx="1.5" fill="#60a5fa" opacity="0.35" />
      <rect x="65" y="74" width="170" height="3.5" rx="1.5" fill="#60a5fa" opacity="0.3" />

      {/* Refusal reason block */}
      <rect x="55" y="88" width="100" height="28" rx="5" fill="#fef2f2" stroke="#fca5a5" strokeDasharray="3 2" />
      <text x="65" y="99" fontSize="6.5" fontWeight="600" fill="#b91c1c" letterSpacing="0.4">REFUSAL REASON</text>
      <rect x="65" y="104" width="75" height="3" rx="1.5" fill="#f87171" opacity="0.35" />
      <rect x="65" y="110" width="60" height="3" rx="1.5" fill="#f87171" opacity="0.3" />

      {/* Conditions block */}
      <rect x="163" y="88" width="100" height="28" rx="5" fill="#f0fdf4" stroke="#86efac" strokeDasharray="3 2" />
      <text x="173" y="99" fontSize="6.5" fontWeight="600" fill="#166534" letterSpacing="0.4">CONDITIONS</text>
      <rect x="173" y="104" width="75" height="3" rx="1.5" fill="#4ade80" opacity="0.4" />
      <rect x="173" y="110" width="55" height="3" rx="1.5" fill="#4ade80" opacity="0.35" />

      {/* FI request block */}
      <rect x="55" y="122" width="100" height="28" rx="5" fill="#fef3c7" stroke="#fcd34d" strokeDasharray="3 2" />
      <text x="65" y="133" fontSize="6.5" fontWeight="600" fill="#92400e" letterSpacing="0.4">FURTHER INFO</text>
      <rect x="65" y="138" width="75" height="3" rx="1.5" fill="#fbbf24" opacity="0.4" />
      <rect x="65" y="144" width="60" height="3" rx="1.5" fill="#fbbf24" opacity="0.35" />

      {/* Appeal block */}
      <rect x="163" y="122" width="100" height="28" rx="5" fill="#ede9fe" stroke="#c4b5fd" strokeDasharray="3 2" />
      <text x="173" y="133" fontSize="6.5" fontWeight="600" fill="#5b21b6" letterSpacing="0.4">APPEAL</text>
      <rect x="173" y="138" width="75" height="3" rx="1.5" fill="#a78bfa" opacity="0.4" />
      <rect x="173" y="144" width="55" height="3" rx="1.5" fill="#a78bfa" opacity="0.35" />

      {/* Sparkle */}
      <circle cx="262" cy="22" r="12" fill="#eaf2fe" />
      <path d="M262 14 L263.5 19 L268 20.5 L263.5 22 L262 27 L260.5 22 L256 20.5 L260.5 19 Z" fill="#0b62d6" />
    </svg>
  );
}

const STEPS = [
  {
    illustration: DataSourcesIllustration,
    title: "All planning data in one place",
    body: "We pull together multiple council and national data sources so you get the full picture for any property, all on one screen.",
  },
  {
    illustration: AiSummariesIllustration,
    title: "Understand applications in seconds",
    body: "AI-generated plain-English summaries of every application, so you can scan and understand without opening a single document.",
  },
  {
    illustration: null,
    title: "Find it fast, stay informed",
    body: null,
    features: [
      {
        icon: "search",
        title: "Search",
        desc: "Find applications instantly by address, area, or keyword",
      },
      {
        icon: "star",
        title: "Save",
        desc: "Save applications and track them over time",
      },
      {
        icon: "bell",
        title: "Alerts",
        desc: "Watch an area and get emailed when something changes",
      },
    ],
  },
];

function FeatureIcon({ type }: { type: string }) {
  if (type === "search") return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="6" stroke="#0b62d6" strokeWidth="1.8" />
      <line x1="13.5" y1="13.5" x2="17" y2="17" stroke="#0b62d6" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
  if (type === "star") return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 2.5l2.2 4.5 5 .7-3.6 3.5.85 5-4.45-2.3L5.55 16.2l.85-5L2.8 7.7l5-.7L10 2.5z" fill="#0b62d6" />
    </svg>
  );
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 2C7.5 2 5.5 4 5.5 6.5c0 3 4.5 8 4.5 8s4.5-5 4.5-8C14.5 4 12.5 2 10 2z" fill="none" stroke="#0b62d6" strokeWidth="1.5" />
      <path d="M7 14.5C6 15 5.5 15.5 5.5 16c0 1 2 2 4.5 2s4.5-1 4.5-2c0-.5-.5-1-1.5-1.5" stroke="#0b62d6" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="10" cy="6.5" r="1.5" fill="#0b62d6" />
    </svg>
  );
}

export function WelcomeModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];

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
          {current.illustration && <current.illustration />}
          <h2>{current.title}</h2>
          {current.body && <p>{current.body}</p>}
          {current.features && (
            <div className="welcome-features">
              {current.features.map((f) => (
                <div key={f.icon} className="welcome-feature">
                  <span className="welcome-feature-icon"><FeatureIcon type={f.icon} /></span>
                  <div>
                    <strong>{f.title}</strong>
                    <span>{f.desc}</span>
                  </div>
                </div>
              ))}
            </div>
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
