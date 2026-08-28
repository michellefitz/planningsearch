import { useState } from "react";
import { posthog } from "../posthog";

export default function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);

  const submit = () => {
    if (!message.trim()) return;
    const subject = encodeURIComponent("PlanView feedback");
    const body = encodeURIComponent(
      `${message.trim()}${email.trim() ? `\n\n— ${email.trim()}` : ""}`
    );
    window.open(
      `mailto:shellie.fitzpatrick@gmail.com?subject=${subject}&body=${body}`,
      "_blank"
    );
    posthog.capture("feedback_submitted", {
      has_email: Boolean(email.trim()),
      message_length: message.trim().length,
    });
    setSent(true);
  };

  return (
    <>
      <div className="feedback-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="feedback-modal" role="dialog" aria-label="Send feedback">
        {sent ? (
          <div className="feedback-sent">
            <p><strong>Thanks!</strong></p>
            <p>Your email app should have opened with the message. If it didn't, you can email me directly at shellie.fitzpatrick@gmail.com</p>
            <button type="button" className="btn" onClick={onClose}>Close</button>
          </div>
        ) : (
          <>
            <h3>Send feedback</h3>
            <p className="feedback-blurb">
              PlanView is a side project and I'd love to hear what you think — what's useful, what's broken, what's missing.
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
              <span>What's on your mind?</span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                placeholder="Found a bug, have an idea, or just want to say hello…"
                autoFocus
              />
            </label>
            <div className="feedback-actions">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!message.trim()}
                onClick={submit}
              >
                Send
              </button>
            </div>
            <p className="feedback-fine">Thanks — Michelle</p>
          </>
        )}
      </div>
    </>
  );
}
