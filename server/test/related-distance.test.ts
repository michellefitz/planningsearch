import { describe, expect, it } from "vitest";
import { nearEnoughToRelate, RELATED_MAX_KM } from "../../api/_related/distance.mjs";

/**
 * Why the same-address list needs a distance cap.
 *
 * Outside the cities an application's "address" is a townland — "Riggins,
 * Dunshaughlin, County Meath" — with no house number and usually no Eircode,
 * so everything in the townland normalises to one key and the "other
 * applications at this address" list filled with properties that share a name
 * and nothing else.
 *
 * Sampled against the live register, pairs already on that list:
 *
 *   Wexford      319 pairs, 216 (68%) more than 250 m apart, median 373 m
 *   Cork County  148 pairs,  94 (64%)                        median 415 m
 *   Meath        187 pairs, 113 (60%)                        median 483 m
 *   Dublin City   29 pairs,   0  (0%)                        median   0 m
 *
 * Dublin City having no pair beyond 250 m is what sets the cap: it is clear of
 * ordinary geocoding jitter where addresses are exact.
 */
const at = (lat: number, lng: number) => ({ lat, lng });

describe("nearEnoughToRelate", () => {
  it("keeps two records of the same property", () => {
    // Same point, and a few metres of jitter either way.
    expect(nearEnoughToRelate(at(53.4185, -6.539), at(53.4185, -6.539))).toBe(true);
    expect(nearEnoughToRelate(at(53.4185, -6.539), at(53.4187, -6.5392))).toBe(true);
  });

  it("drops the far side of a townland", () => {
    // Laragh East, Wicklow: two applications sharing an address string, 1.57 km
    // apart. Drumlargan, Kilcock: three spanning 1.08 km.
    expect(nearEnoughToRelate(at(53.0, -6.3), at(53.0141, -6.3))).toBe(false); // ~1.57 km
    expect(nearEnoughToRelate(at(53.4, -6.7), at(53.4097, -6.7))).toBe(false); // ~1.08 km
  });

  it("cuts where the sampled data says to", () => {
    expect(RELATED_MAX_KM).toBe(0.25);
    // 0.36 km — Riggins, Dunshaughlin, four applications — is out.
    expect(nearEnoughToRelate(at(53.5, -6.5), at(53.50324, -6.5))).toBe(false);
    // 0.16 km — Painestown, Beauparc — stays: a large rural site is plausible.
    expect(nearEnoughToRelate(at(53.5, -6.5), at(53.50144, -6.5))).toBe(true);
  });

  it("never drops an application for having no coordinates", () => {
    /**
     * A missing coordinate is not evidence of distance. The register does not
     * geocode everything, and an application that matched by address must not
     * disappear because of what we do not know about it.
     */
    expect(nearEnoughToRelate(at(53.4, -6.5), { lat: null, lng: null })).toBe(true);
    expect(nearEnoughToRelate({ lat: null, lng: null }, at(53.4, -6.5))).toBe(true);
    expect(nearEnoughToRelate({ lat: 53.4, lng: null }, at(53.4, -6.5))).toBe(true);
  });

  it("is symmetric", () => {
    const a = at(53.0, -6.3);
    const b = at(53.0141, -6.3);
    expect(nearEnoughToRelate(a, b)).toBe(nearEnoughToRelate(b, a));
  });
});
