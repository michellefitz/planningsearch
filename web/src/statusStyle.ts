/**
 * Status colours pair with a letter glyph on each pin so state is never
 * conveyed by colour alone (PRD F2.2 / F8.3).
 *
 * Lives outside MapView because the results list, the filter panel and the
 * detail sheet all need it. Importing it from MapView pulled that module —
 * and maplibre-gl with it, 217 kB gzipped — into the initial bundle even
 * though the map is loaded on demand.
 */
export const STATUS_STYLE: Record<string, { color: string; letter: string; label: string; hint: string }> = {
  pending: { color: "#2563eb", letter: "P", label: "Pending decision", hint: "The council hasn't decided yet. Usually takes up to 8 weeks from the date received." },
  further_info: { color: "#9333ea", letter: "F", label: "Further information", hint: "The council has asked the applicant for more detail before it can decide. The statutory clock pauses until it arrives." },
  granted: { color: "#16a34a", letter: "G", label: "Granted", hint: "Permission was approved, possibly with conditions attached." },
  refused: { color: "#dc2626", letter: "R", label: "Refused", hint: "The council refused permission. The applicant can appeal to An Coimisiún Pleanála within 4 weeks." },
  withdrawn: { color: "#6b7280", letter: "W", label: "Withdrawn", hint: "The applicant pulled the application before it was decided." },
  invalid: { color: "#a16207", letter: "I", label: "Invalid", hint: "The application didn't meet basic requirements (missing documents, wrong fee) and was returned without being assessed." },
  incomplete: { color: "#b45309", letter: "!", label: "Incomplete", hint: "The application was lodged but is missing information needed to start the formal process." },
  appealed: { color: "#ea580c", letter: "A", label: "Under appeal", hint: "The council's decision has been appealed to An Coimisiún Pleanála. Either the applicant or a third party can appeal." },
  split: { color: "#db2777", letter: "S", label: "Split decision", hint: "Part of what was applied for was granted and part was refused." },
  exempt: { color: "#16a34a", letter: "D", label: "Declared exempt", hint: "The council ruled that the works don't need planning permission — a Section 5 declaration confirming exempted development." },
  not_exempt: { color: "#dc2626", letter: "D", label: "Declared not exempt", hint: "The council ruled that the works do need planning permission — the exemption claimed doesn't apply." },
  decided: { color: "#0d9488", letter: "D", label: "Decided", hint: "A decision has been made, but the specific outcome isn't categorised in the register data." },
  unknown: { color: "#64748b", letter: "?", label: "Unknown", hint: "The status in the register couldn't be mapped to a known outcome." },
};
