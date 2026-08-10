import posthog from "posthog-js";

const apiKey = import.meta.env.VITE_PUBLIC_POSTHOG_KEY;
const apiHost = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;

if (apiKey && apiHost) {
  posthog.init(apiKey, {
    api_host: apiHost,
    capture_exceptions: true,
  });
} else if (import.meta.env.DEV) {
  // Analytics is optional for local development: warn loudly, but never throw.
  // This runs at module load, so throwing took the whole app down with a blank
  // page — anyone cloning the repo without a PostHog project couldn't run it.
  const missing = [
    !apiKey && "VITE_PUBLIC_POSTHOG_KEY",
    !apiHost && "VITE_PUBLIC_POSTHOG_HOST",
  ].filter(Boolean);
  console.warn(
    `PostHog is disabled: ${missing.join(" and ")} not set. Analytics events ` +
      `will not be recorded. Copy web/.env.example to web/.env and fill it in ` +
      `to enable them locally; production sets these in the Vercel project.`
  );
}

export { posthog };
