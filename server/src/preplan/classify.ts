export function classifyWorkType(description: string): string {
  if (!description) return "other";
  const d = description.toLowerCase();
  if (/\battic\b.*\b(conver|storage|room|bedroom)|convert.*\battic\b|dormer/.test(d)) return "attic_conversion";
  if (/\b(extension|extend)\b(?!.*\bduration\b)/i.test(d)) return "extension";
  if (/\b(new|erect|construct|build)\b.*\b(dwell|house|home|bungalow|apartment|unit)/i.test(d)) return "new_dwelling";
  if (/\bchange\s+of\s+use\b/i.test(d)) return "change_of_use";
  if (/\bdemoli/i.test(d)) return "demolition";
  if (/\bretention\s+of\b/i.test(d)) return "retention";
  return "other";
}

export const WORK_TYPE_LABELS: Record<string, string> = {
  extension: "Extensions & conversions",
  attic_conversion: "Attic conversions",
  new_dwelling: "New dwellings",
  change_of_use: "Change of use",
  demolition: "Demolition",
  retention: "Retention",
  other: "Other",
};
