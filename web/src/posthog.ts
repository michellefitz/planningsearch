import posthog from "posthog-js";

const apiKey = import.meta.env.VITE_PUBLIC_POSTHOG_KEY;
const apiHost = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;

if (apiKey && apiHost) {
  posthog.init(apiKey, {
    api_host: apiHost,
    capture_exceptions: true,
  });
} else if (import.meta.env.DEV) {
  if (!apiKey) {
    throw new Error(
      "VITE_PUBLIC_POSTHOG_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once VITE_PUBLIC_POSTHOG_KEY is configured"
    );
  }
  throw new Error(
    "VITE_PUBLIC_POSTHOG_HOST variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once VITE_PUBLIC_POSTHOG_KEY is configured"
  );
}

export { posthog };
