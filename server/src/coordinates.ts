/**
 * Second defence for a record that arrives without a map pin.
 *
 * A record with no coordinates is invisible on the map however well it reads
 * in the list, and nothing on screen says why. Recent Kildare applications are
 * scraped from the council's own register rather than the national feed, and
 * their coordinates come from each detail page's Site Location tab — so a page
 * that doesn't answer loses them. Because the scrape runs fresh on every
 * deploy, a pin can be there one build and gone the next. 20 Glen Easton
 * Gardens in Leixlip was reported missing twice.
 *
 * The retry in ingest/eplanning-list.ts is the first defence, and it only
 * helps where the council recorded a location at all: of 39 unlocated records
 * in the 1,000 most recently received (2026-08-18, every one Kildare), 12 had
 * coordinates on the page and 27 had none.
 *
 * This is the second. It infers nothing — the address key is the same one that
 * groups an application's own planning history, so a match is the same
 * property, and the coordinates copied are the council's own geocoding of it.
 * Only numbered addresses qualify: a townland is shared by many houses, and a
 * pin on the wrong one is worse than no pin.
 */
import { isSpecificAddress, normalizeAddress } from "./ingest/ppr.js";

interface Locatable {
  authority_id: string;
  address_text?: string | null;
  lat?: number | null;
  lng?: number | null;
}

/** Fills coordinates in place; returns how many records were given one. */
export function fillMissingCoordinates(records: Locatable[]): number {
  const known = new Map<string, { lat: number; lng: number }>();
  const keyOf = (r: Locatable): string | null => {
    if (!r.address_text) return null;
    const address = normalizeAddress(r.address_text);
    return isSpecificAddress(address) ? `${r.authority_id}|${address}` : null;
  };

  for (const r of records) {
    if (r.lat == null || r.lng == null) continue;
    const key = keyOf(r);
    if (key && !known.has(key)) known.set(key, { lat: r.lat, lng: r.lng });
  }

  let filled = 0;
  for (const r of records) {
    if (r.lat != null && r.lng != null) continue;
    const key = keyOf(r);
    const hit = key ? known.get(key) : undefined;
    if (!hit) continue;
    r.lat = hit.lat;
    r.lng = hit.lng;
    filled++;
  }
  return filled;
}
