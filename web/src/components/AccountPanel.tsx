import { type Me } from "../accountApi";
import SignInCard from "./SignInCard";

/**
 * My account — who you are and how we reach you.
 *
 * Small on purpose. Everything that used to live on this screen is now a
 * destination of its own: saved applications under Saved, watched areas under
 * Alerts. What is left is identity, and the one preference that is genuinely
 * global rather than a property of a saved thing.
 *
 * Note what is deliberately NOT here: the per-application, per-list and
 * per-area alert toggles. Those belong on the row they alert about, because
 * turning one off is a statement about that list or that area — not about your
 * account. A single global mute would be a real addition rather than a move,
 * and there is no account-level setting behind it yet.
 */
export default function AccountPanel({
  me,
  notice,
  onSignOut,
  onGoSaved,
  onGoAlerts,
}: {
  me: Me | null;
  notice: string | null;
  onSignOut: () => void;
  onGoSaved: () => void;
  onGoAlerts: () => void;
}) {
  if (!me) return <div className="account-panel"><p className="account-muted">Loading…</p></div>;

  if (!me.user) {
    return (
      <SignInCard
        headline="Sign in to PlanView"
        blurb="One account keeps your saved applications, your lists and the areas you watch — and lets us email you when something changes."
        notice={notice}
      />
    );
  }

  const savedCount = me.saves.length;
  const watchCount = me.watches?.length ?? 0;

  return (
    <div className="account-panel">
      <div className="reg-head">
        <h2>My account</h2>
      </div>

      <section className="acct-section" aria-label="Sign-in details">
        <h3>Signed in as</h3>
        <p className="acct-email">{me.user.email}</p>
        <p className="acct-fine">
          PlanView has no password — you sign in with a link sent to this address.
        </p>
      </section>

      <section className="acct-section" aria-label="What you are tracking">
        <h3>What you're tracking</h3>
        <div className="acct-links">
          <button type="button" className="acct-link" onClick={onGoSaved}>
            <b>{savedCount}</b>
            <span>saved {savedCount === 1 ? "application" : "applications"}</span>
          </button>
          <button type="button" className="acct-link" onClick={onGoAlerts}>
            <b>{watchCount}</b>
            <span>watched {watchCount === 1 ? "area" : "areas"}</span>
          </button>
        </div>
      </section>

      <section className="acct-section" aria-label="Session">
        <button type="button" className="acct-signout" onClick={onSignOut}>
          Sign out
        </button>
      </section>
    </div>
  );
}
