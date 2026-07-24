/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google Cloud key for Street View Static + Maps Static APIs (optional). */
  readonly VITE_GOOGLE_MAPS_KEY?: string;
  /** Mapbox token for the aerial thumbnail (optional). When set, the inline
   *  satellite preview uses Mapbox; otherwise it falls back to keyless Esri.
   *  Google satellite is unavailable here under the EEA Platform terms. */
  readonly VITE_MAPBOX_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
