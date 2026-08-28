import { useState } from "react";
import { posthog } from "../posthog";

export default function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);

  const submit = async () => {
    if (!message.trim() || sending) return;
    setSending(true);
    setError(false);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() || null, message: message.trim() }),
      });
      if (!res.ok) throw new Error();
      posthog.capture("feedback_submitted", {
        has_email: Boolean(email.trim()),
        message_length: message.trim().length,
      });
      setSent(true);
    } catch {
      setError(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="feedback-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="feedback-modal" role="dialog" aria-label="Send feedback">
        {sent ? (
          <div className="feedback-sent">
            <p><strong>Thanks for the feedback!</strong></p>
            <button type="button" className="btn" onClick={onClose}>Close</button>
          </div>
        ) : (
          <>
            <h3>Send feedback</h3>
            <p className="feedback-blurb">
              I'd love to hear what you think — what's useful, what's broken, what's missing.
            </p>
            <label className="feedback-field">
              <span>Your email <span className="feedback-optional">(optional)</span></span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <label className="feedback-field">
              <span>Feedback</span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                placeholder="Found a bug, have an idea, or just want to say hello…"
                autoFocus
              />
            </label>
            {error && <p className="feedback-error">Couldn't send — try again.</p>}
            <div className="feedback-actions">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!message.trim() || sending}
                onClick={submit}
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
