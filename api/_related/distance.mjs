/**
 * How far apart two applications may be and still be the same address.
 *
 * Outside the cities the "address" on an application is a townland — "Riggins,
 * Dunshaughlin, County Meath" — with no house number and usually no Eircode.
 * Everything in the townland normalises to one address key, so the "other
 * applications at this address" list filled up with properties that share a
 * name and nothing else.
 *
 * Sampled against the live register, pairs already on that list:
 *
 *   council        pairs   >250m apart   median
 *   Wexford          319    216  (68%)    373 m
 *   Cork County      148     94  (64%)    415 m
 *   Meath            187    113  (60%)    483 m
 *   Wicklow           65     24  (37%)     99 m
 *   Fingal            50     17  (34%)      2 m
 *   Dublin City       29      0   (0%)      0 m
 *
 * In the rural councils the TYPICAL neighbour on that list was half a
 * kilometre away — a different farm, a different house, nothing to do with the
 * application being read.
 *
 * 250 m because Dublin City, where addresses are exact, has no pair beyond it
 * at all: the cap sits clear of ordinary geocoding jitter, and what it removes
 * in Meath or Wexford is a genuinely different site.
 *
 * It cannot fix everything. Where a council geocodes to the townland centroid
 * both records carry the same point — 31 of 95 multi-application address
 * strings sampled in Meath and Wicklow — and distance has nothing to say about
 * those. This removes what it can prove wrong, not what it cannot prove right.
 */
export const RELATED_MAX_KM = 0.25;

export function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function nearEnoughToRelate(app, other) {
  // A missing coordinate is not evidence of distance. The register does not
  // geocode everything, and an application that matched by address must not
  // disappear because of something we do not know about it.
  if (app?.lat == null || app?.lng == null || other?.lat == null || other?.lng == null) return true;
  return haversineKm(app.lat, app.lng, other.lat, other.lng) <= RELATED_MAX_KM;
}
