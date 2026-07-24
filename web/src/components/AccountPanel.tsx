import { useState } from "react";
import { accountApi, type Me } from "../accountApi";

interface Props {
  me: Me | null;
  notice: string | null;
  onRefresh: () => Promise<void>;
  onOpenApp: (authorityId: string, reference: string) => Promise<void>;
  onGoSearch: () => void;
}

export default function AccountPanel({ me, notice, onRefresh, onOpenApp, onGoSearch }: Props) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  if (!me) return <div className="account-panel"><p className="account-muted">Loading…</p></div>;

  if (!me.user) {
    return (
      <div className="account-panel account-signin">
        <div className="signin-card">
          <h2>Your applications, watched</h2>
          <p>
            Save any planning application, organise them into lists, and get an email
            the day something changes — a decision, an appeal, work starting on site.
          </p>
          {notice && <p className="signin-notice">{notice}</p>}
          {state === "sent" ? (
            <div className="signin-sent">
              <strong>Check your inbox</strong>
              <p>We've sent a sign-in link to {email}. It expires in 15 minutes.</p>
            </div>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setState("sending");
                try {
                  await accountApi.requestLink(email);
                  setState("sent");
                } catch {
                  setState("error");
                }
              }}
            >
              <input
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
              <button type="submit" disabled={state === "sending"}>
                {state === "sending" ? "Sending…" : "Email me a sign-in link"}
              </button>
              {state === "error" && (
                <p className="signin-notice">Couldn't send just now — try again in a moment.</p>
              )}
            </form>
          )}
          <p className="signin-fine">No password. First sign-in creates your account.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="account-panel">
      <div className="account-head">
        <h2>Saved applications</h2>
        <button
          type="button"
          className="account-signout"
          onClick={async () => {
            await accountApi.logout();
            await onRefresh();
          }}
        >
          Sign out
        </button>
      </div>
      {me.saves.length === 0 ? (
        <div className="account-empty">
          <strong>Nothing saved yet</strong>
          <p>Star any application in Search and it'll live here — with alerts when it changes.</p>
          <button type="button" onClick={onGoSearch}>Search your area</button>
        </div>
      ) : (
        <ul className="account-saves">
          {me.saves.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => void onOpenApp(s.authority_id, s.planning_reference)}>
                <strong>{s.app?.address_text ?? s.planning_reference}</strong>
                {s.has_update && <span className="badge-updated">Updated</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
