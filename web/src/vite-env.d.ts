/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google Cloud key for Street View Static + Maps Static APIs (optional). */
  readonly VITE_GOOGLE_MAPS_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
