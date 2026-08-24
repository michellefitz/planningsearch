const DISMISSED_KEY = "planview:welcome-dismissed";

export function WelcomeModal({ onClose }: { onClose: () => void }) {
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

        <h2>Welcome to PlanView</h2>
        <p>
          PlanView brings together planning applications from councils across Ireland
          into one searchable map. Here are a few things you can do:
        </p>

        <ul>
          <li>
            <strong>Search by address or area</strong> to find applications near a
            location, or use keywords like "demolition" or "solar panels"
          </li>
          <li>
            <strong>Click any pin</strong> to see the full application, including
            AI-generated summaries, conditions, and related applications at the same address
          </li>
          <li>
            <strong>Ask a question</strong> using the Ask tab to chat with an AI
            assistant that can search the register for you
          </li>
          <li>
            <strong>Toggle map layers</strong> like zoning, flood risk, and derelict
            sites to see what applies to a location
          </li>
        </ul>

        <p className="welcome-account">
          Create a free account to save applications, watch areas for new activity,
          and run property reports.
        </p>

        <button type="button" className="btn btn-primary welcome-go" onClick={onClose}>
          Start exploring
        </button>
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
