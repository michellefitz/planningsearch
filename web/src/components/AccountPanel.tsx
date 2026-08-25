import { useEffect, useState } from "react";
import { accountApi, type Me } from "../accountApi";
import SignInCard from "./SignInCard";

/**
 * The one detail the register cannot supply.
 *
 * Saved on blur rather than behind a Save button: it is a single field, and a
 * button that is the only thing on the screen to press invites a trip that
 * changes nothing. Empty clears it back to null, and the address takes over
 * again wherever a name would have been used.
 */
function NameField({ name, onSaved }: { name: string | null; onSaved: () => Promise<Me> }) {
  const [value, setValue] = useState(name ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // Another device, or a reload mid-edit: follow the server unless the field
  // is dirty, so typing is never yanked out from under the cursor.
  useEffect(() => {
    setValue((v) => (v === (name ?? "") ? v : name ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const commit = async () => {
    const next = value.trim();
    if (next === (name ?? "")) return setState("idle");
    setState("saving");
    try {
      await accountApi.updateAccount({ name: next || null });
      await onSaved();
      setState("saved");
    } catch {
      setState("error");
    }
  };

  return (
    <label className="acct-field">
      <span className="acct-field-label">Name</span>
      <input
        type="text"
        value={value}
        maxLength={80}
        placeholder="Not set"
        autoComplete="name"
        onChange={(e) => {
          setValue(e.target.value);
          if (state !== "idle") setState("idle");
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setValue(name ?? "");
            setState("idle");
          }
        }}
      />
      <span className={`acct-field-note acct-field-${state}`} role="status">
        {state === "saving" ? "Saving…"
          : state === "saved" ? "Saved"
          : state === "error" ? "Couldn't save — try again."
          : "Used to greet you in alert emails."}
      </span>
    </label>
  );
}

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
  onRefresh,
  onSignOut,
  onGoSaved,
  onGoAlerts,
}: {
  me: Me | null;
  notice: string | null;
  onRefresh: () => Promise<Me>;
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

      <section className="acct-section" aria-label="Your details">
        <h3>Your details</h3>
        <NameField name={me.user.name} onSaved={onRefresh} />
        <p className="acct-email-line">
          <span className="acct-email">{me.user.email}</span>
          <span className="acct-fine">
            PlanView has no password — you sign in with a link sent here.
          </span>
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
