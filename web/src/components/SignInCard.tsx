import { useState } from "react";
import { accountApi } from "../accountApi";
import { posthog } from "../posthog";

/**
 * The signed-out state, shared by every screen that needs an account.
 *
 * Saved, Alerts and My account each hit this, and each wants to say something
 * apt about what signing in gets you — a promise about watched areas is not a
 * promise about saved applications — so the headline and blurb are the
 * caller's, and only the form is shared.
 */
export default function SignInCard({
  headline,
  blurb,
  notice,
}: {
  headline: string;
  blurb: string;
  notice: string | null;
}) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  return (
    <div className="account-panel account-signin">
      <div className="signin-card">
        <h2>{headline}</h2>
        <p>{blurb}</p>
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
                posthog.capture("sign_in_link_requested");
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
