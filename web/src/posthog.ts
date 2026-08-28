import posthog from "posthog-js";

const apiKey = import.meta.env.VITE_PUBLIC_POSTHOG_KEY;
const apiHost = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;

const isProduction =
  typeof window !== "undefined" &&
  (window.location.hostname === "planningsearch.vercel.app" ||
    window.location.hostname === "planningsearch-server.vercel.app");

if (apiKey && apiHost && (isProduction || import.meta.env.DEV)) {
  posthog.init(apiKey, {
    api_host: apiHost,
    capture_exceptions: true,
    persistence: "localStorage+cookie",
    loaded: (ph) => {
      if (!isProduction) {
        ph.register({ environment: "development" });
      }
    },
  });
} else if (import.meta.env.DEV) {
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
