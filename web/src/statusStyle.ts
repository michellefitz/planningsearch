/**
 * Status colours pair with a letter glyph on each pin so state is never
 * conveyed by colour alone (PRD F2.2 / F8.3).
 *
 * Lives outside MapView because the results list, the filter panel and the
 * detail sheet all need it. Importing it from MapView pulled that module —
 * and maplibre-gl with it, 217 kB gzipped — into the initial bundle even
 * though the map is loaded on demand.
 */
export const STATUS_STYLE: Record<string, { color: string; letter: string; label: string }> = {
  pending: { color: "#2563eb", letter: "P", label: "Pending decision" },
  further_info: { color: "#9333ea", letter: "F", label: "Further information" },
  granted: { color: "#16a34a", letter: "G", label: "Granted" },
  refused: { color: "#dc2626", letter: "R", label: "Refused" },
  withdrawn: { color: "#6b7280", letter: "W", label: "Withdrawn" },
  invalid: { color: "#a16207", letter: "I", label: "Invalid" },
  incomplete: { color: "#b45309", letter: "!", label: "Incomplete" },
  appealed: { color: "#ea580c", letter: "A", label: "Under appeal" },
  split: { color: "#db2777", letter: "S", label: "Split decision" },
  exempt: { color: "#16a34a", letter: "D", label: "Declared exempt" },
  not_exempt: { color: "#dc2626", letter: "D", label: "Declared not exempt" },
  decided: { color: "#0d9488", letter: "D", label: "Decided" },
  unknown: { color: "#64748b", letter: "?", label: "Unknown" },
};
