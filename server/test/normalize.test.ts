import { describe, expect, it } from "vitest";
import {
  deriveApplicationType,
  extractResidentialUnits,
  guessIsDomestic,
  normalizeApplicationType,
  normalizeStatus,
} from "../src/normalize.js";

describe("normalizeStatus", () => {
  it("maps vendor labels onto canonical statuses", () => {
    expect(normalizeStatus("New Application")).toBe("pending");
    expect(normalizeStatus("Further Information Requested")).toBe("further_info");
    expect(normalizeStatus("Decision Made", "Grant Permission")).toBe("granted");
    expect(normalizeStatus("REFUSED")).toBe("refused");
    expect(normalizeStatus("Application Withdrawn")).toBe("withdrawn");
    expect(normalizeStatus("Invalid Application")).toBe("invalid");
    expect(normalizeStatus("Appealed to An Bord Pleanala")).toBe("appealed");
  });

  it("falls back to the decision text when status is blank", () => {
    expect(normalizeStatus(null, "Refuse Permission")).toBe("refused");
    expect(normalizeStatus("", "Grant Permission")).toBe("granted");
  });

  it("reads an outcome embedded in a finalised status when the decision field is empty", () => {
    // e.g. Kildare after An Coimisiún Pleanála removed the conditions on appeal
    expect(normalizeStatus("Finalised Unconditional")).toBe("granted");
    expect(normalizeStatus("Finalised - Grant Permission")).toBe("granted");
    expect(normalizeStatus("Finalised Refused")).toBe("refused");
    // Decision field still wins when present
    expect(normalizeStatus("Finalised Unconditional", "Refuse Permission")).toBe("refused");
  });

  it("recognises Incomplete as its own status (not decided, not invalid)", () => {
    expect(normalizeStatus("Incomplete Application")).toBe("incomplete");
    expect(normalizeStatus("INCOMPLETE")).toBe("incomplete");
    // The 'complete' substring must not route it to the decided-opaque branch
    expect(normalizeStatus("Incomplete Application", null)).not.toBe("unknown");
    // A genuinely completed/closed case still defers to its decision
    expect(normalizeStatus("Application Complete", "Grant Permission")).toBe("granted");
  });

  it("lets a recorded decision supersede a stale not-yet-decided status stage", () => {
    // The national status field lags (SD22A/0440: still "Registered
    // Application" in 2026 though granted in 2023) — the decision on record wins.
    expect(normalizeStatus("Registered Application", "GRANT PERMISSION")).toBe("granted");
    expect(normalizeStatus("New Application", "Refuse Permission")).toBe("refused");
    expect(normalizeStatus("Further Information Requested", "GRANT PERMISSION")).toBe("granted");
    // A status naming a terminal outcome is not overridden by the decision…
    expect(normalizeStatus("Application Withdrawn", "GRANT PERMISSION")).toBe("withdrawn");
    // …and an appeal stage stands (appeal supersession is handled downstream).
    expect(normalizeStatus("Appealed to An Bord Pleanala", "Grant Permission")).toBe("appealed");
    // No decision on record: the stage stands.
    expect(normalizeStatus("Registered Application", null)).toBe("pending");
  });

  it("defers a 'decision notice issued' stage to the decision/outcome (DCC invalid case)", () => {
    // The stage word alone means nothing; the real outcome is in the decision.
    expect(normalizeStatus("Decision Notice Issued", "Application Declared Invalid")).toBe("invalid");
    expect(normalizeStatus("Decision Notice Issued", "Grant Permission")).toBe("granted");
    expect(normalizeStatus("Decision Notice Issued", "Refuse Permission")).toBe("refused");
    // Outcome embedded in the status text still reads when the decision is empty.
    expect(normalizeStatus("Notification of Decision to Grant Permission", null)).toBe("granted");
    // No outcome anywhere still can't be guessed.
    expect(normalizeStatus("Decision Notice Issued", null)).toBe("unknown");
  });

  it("treats the validation/assessment stage as pending, but a declared-invalid status as invalid", () => {
    // "Validation" is the live pre-assessment stage of a genuinely live
    // application (DLR ref REF10726, received days earlier, no decision), so
    // pending — not a "?" pin. A recorded decision still supersedes the stage,
    // and a real invalid is caught by the invalid keyword first.
    expect(normalizeStatus("Validation")).toBe("pending");
    expect(normalizeStatus("Validated")).toBe("pending");
    expect(normalizeStatus("Under Assessment")).toBe("pending");
    expect(normalizeStatus("Validation", "REFUSE PERMISSION")).toBe("refused");
    expect(normalizeStatus("Invalidated")).toBe("invalid");
    expect(normalizeStatus("Invalid")).toBe("invalid");
    expect(normalizeStatus("Application Declared Invalid")).toBe("invalid");
  });

  it("reads the truncated national decision text (…DECLARED INVA -> invalid)", () => {
    // The national Decision field is cut at ~24 chars: "APPLICATION DECLARED
    // INVALID" arrives as "APPLICATION DECLARED INVA" (DCC ref 4497/23).
    expect(normalizeStatus("Decision Notice Issued", "APPLICATION DECLARED INVA")).toBe("invalid");
    expect(normalizeStatus("Decision Notice Issued", "APPLICATION DECLARED INV")).toBe("invalid");
    // Grant/refuse keep their keyword at the start, so truncation doesn't hurt.
    expect(normalizeStatus("Decision Notice Issued", "GRANT PERMISSION FOR RET")).toBe("granted");
  });

  it("maps referral/assessment stages to pending", () => {
    // DLR "Referral" (D26B/0411/WEB) and SDCC "SAI Referral" (SD26B/0070W) are
    // live in-assessment stages, not "?".
    expect(normalizeStatus("Referral")).toBe("pending");
    expect(normalizeStatus("SAI Referral")).toBe("pending");
  });

  it("maps a part-grant/part-refuse decision to split", () => {
    expect(normalizeStatus("Decision", "SPLIT DECISION")).toBe("split");
    expect(normalizeStatus("Decision", "GRANT PERMISSION & REFUSE PERMISSION")).toBe("split");
    expect(normalizeStatus("Split Decision")).toBe("split");
    expect(normalizeStatus(null, "Part Grant, Part Refuse")).toBe("split");
    // A plain grant or refuse is unaffected.
    expect(normalizeStatus("Decision", "REFUSE PERMISSION")).toBe("refused");
    expect(normalizeStatus("Decision", "GRANT PERMISSION")).toBe("granted");
  });

  it("maps Section 5 declarations to exempt / not_exempt, not granted/refused", () => {
    // The exemption analogue of granted and refused — distinct outcomes so the
    // map and badges can colour them (green D / red D), still outside the
    // permission grant-rate buckets.
    expect(normalizeStatus("Decision", "DECLARED NOT EXEMPT")).toBe("not_exempt");
    expect(normalizeStatus("Decision", "DECLARED EXEMPT")).toBe("exempt");
    expect(normalizeStatus("Decision", "Declared Exempt & Declared Not Exempt")).toBe("split");
    // DLR phrases certificates with grant/refuse verbs — still exemption
    // outcomes, not permission grants/refusals.
    expect(normalizeStatus("Decision", "GRANT CERTIFICATE OF EXEMPTION")).toBe("exempt");
    expect(normalizeStatus("Decision", "GRANT CERT OF EXEMPTION (<=4 unit)")).toBe("exempt");
    expect(normalizeStatus("Decision", "REFUSE CERTIFICATE OF EXEMPTION")).toBe("not_exempt");
    expect(normalizeStatus("Decided", "Declared to be Development")).toBe("decided");
    // A truncated "declared invalid" is still invalid, not decided.
    expect(normalizeStatus("Decision", "APPLICATION DECLARED INVA")).toBe("invalid");
    // A normal permission decision is unaffected.
    expect(normalizeStatus("Decision", "GRANT PERMISSION")).toBe("granted");
  });

  it("never guesses on unrecognised labels", () => {
    expect(normalizeStatus("Something Novel")).toBe("unknown");
    expect(normalizeStatus("Application Finalised")).toBe("unknown");
    expect(normalizeStatus(null, null)).toBe("pending");
  });
});

describe("normalizeApplicationType", () => {
  it("maps common labels", () => {
    expect(normalizeApplicationType("Permission")).toBe("permission");
    expect(normalizeApplicationType("Retention Permission")).toBe("retention");
    expect(normalizeApplicationType("Outline Permission")).toBe("outline");
    expect(normalizeApplicationType("Extension of Duration")).toBe("extension_of_duration");
    expect(normalizeApplicationType("weird")).toBe("other");
  });

  // Every distinct ApplicationType observed in the national feed for the five
  // authorities since 2012 (surveyed 2026-07-28), plus the agile portal's
  // spelling, must classify — the register said "other" for 1,500+ of these.
  it("maps every observed national-feed value", () => {
    expect(normalizeApplicationType("Declaration of Exemption Sect. 5")).toBe("exemption_declaration");
    expect(normalizeApplicationType("Declaration of Exemption Section 5")).toBe("exemption_declaration");
    expect(normalizeApplicationType("Dec Under Section 5               ")).toBe("exemption_declaration");
    expect(normalizeApplicationType("Section 179A Social Housing Exemption")).toBe("council_development");
    expect(normalizeApplicationType("Application Under Part 8")).toBe("council_development");
    expect(normalizeApplicationType("Application Under Part 10")).toBe("council_development");
    expect(normalizeApplicationType("SDZ Application")).toBe("strategic");
    expect(normalizeApplicationType("SDZ Application Clonburris")).toBe("strategic");
    expect(normalizeApplicationType("Strategic Housing Development     ")).toBe("strategic");
    expect(normalizeApplicationType("SHD3-Application to ABP")).toBe("strategic");
    expect(normalizeApplicationType("LRD Application                   ")).toBe("strategic");
    expect(normalizeApplicationType("LRD3-Application")).toBe("strategic");
    expect(normalizeApplicationType("Strategic Infrastructure Application")).toBe("strategic");
    expect(normalizeApplicationType("Permission and Retention          ")).toBe("retention");
    expect(normalizeApplicationType("PERMISSION CONSEQUENT")).toBe("permission_consequent");
    expect(normalizeApplicationType("Perm.consequent on Grant of Outline Perm")).toBe("permission_consequent");
    expect(normalizeApplicationType("Permission & Perm. consq. on Grant of OP")).toBe("permission_consequent");
    expect(normalizeApplicationType("Permission on Foot of Outline Permission")).toBe("permission_consequent");
    expect(normalizeApplicationType("Perm. following Grant of Outline Perm.")).toBe("permission_consequent");
    expect(normalizeApplicationType("Further Extension of Duration of Permission")).toBe("extension_of_duration");
    expect(normalizeApplicationType("EXTENSION OF DURATION")).toBe("extension_of_duration");
    expect(normalizeApplicationType("TEMPORARY PERMISSION")).toBe("permission");
    // Part 5 certs and oddities stay "other" — no false positives.
    expect(normalizeApplicationType("Cert under Part 5 of 2000 Act as amended")).toBe("other");
    expect(normalizeApplicationType("Quarry Registration")).toBe("other");
    expect(normalizeApplicationType("Compliance with Conditions        ")).toBe("other");
    expect(normalizeApplicationType("N/A")).toBe("other");
  });
});

describe("deriveApplicationType", () => {
  it("uses the explicit type when it classifies", () => {
    expect(deriveApplicationType("Retention Permission", "anything")).toBe("retention");
    expect(deriveApplicationType("Permission", null)).toBe("permission");
  });

  it("infers from the description when the type field is blank", () => {
    expect(
      deriveApplicationType(null, "Permission for retention of a single storey rear extension")
    ).toBe("retention");
    expect(deriveApplicationType("", "Outline permission for a dwelling")).toBe("outline");
    expect(
      deriveApplicationType(null, "Extension of duration of planning permission reg. ref. 12/345")
    ).toBe("extension_of_duration");
    expect(deriveApplicationType(null, "Permission for a two storey dwelling")).toBe("permission");
  });

  it("does not mistake a retaining wall for a retention application", () => {
    expect(
      deriveApplicationType(null, "Permission for a retaining wall and new vehicular entrance")
    ).toBe("permission");
  });

  it("stays 'other' when nothing is inferable", () => {
    expect(deriveApplicationType(null, null)).toBe("other");
    expect(deriveApplicationType(null, "The development will consist of site works")).toBe("other");
  });
});

describe("guessIsDomestic", () => {
  it("flags typical domestic descriptions", () => {
    expect(
      guessIsDomestic("Construction of a single storey extension to the rear of the existing dwelling")
    ).toBe(true);
    expect(guessIsDomestic("Attic conversion with dormer window to the rear")).toBe(true);
  });

  it("rejects clearly non-domestic descriptions", () => {
    expect(
      guessIsDomestic("Construction of 48 no. residential units (24 houses, 24 apartments), a creche")
    ).toBe(false);
    expect(guessIsDomestic("Erection of an agricultural shed with slatted tank")).toBe(false);
  });

  it("handles empty input", () => {
    expect(guessIsDomestic(null)).toBe(false);
  });
});

describe("extractResidentialUnits", () => {
  it("counts units introduced with no./nr./x notation", () => {
    expect(extractResidentialUnits("Construction of 48 no. residential units and a creche")).toBe(48);
    expect(extractResidentialUnits("Demolition of shed and erection of 12 nr. houses")).toBe(12);
    expect(extractResidentialUnits("Permission for 6 x apartments over ground floor retail")).toBe(6);
  });

  it("takes the stated total over the breakdown", () => {
    expect(
      extractResidentialUnits("50 residential units comprising 30 houses and 20 apartments")
    ).toBe(50);
  });

  it("ignores bedrooms, storeys and demolition/existing clauses", () => {
    expect(extractResidentialUnits("Construction of a 4 bedroom two storey dwelling")).toBeNull();
    expect(extractResidentialUnits("Demolition of 3 houses and all associated site works")).toBeNull();
    expect(
      extractResidentialUnits("Demolition of 2 existing dwellings and construction of 9 no. dwellings")
    ).toBe(9);
  });

  it("returns null when no unit count is stated", () => {
    expect(extractResidentialUnits("Single storey extension to rear")).toBeNull();
    expect(extractResidentialUnits(null)).toBeNull();
    expect(extractResidentialUnits("")).toBeNull();
  });

  it('reads "No." with a capital N', () => {
    // The count regex was case-sensitive, so the abbreviation Irish
    // descriptions actually use went unrecognised: the count ran into
    // "No. houses", which is not a unit noun, and the scheme scored null.
    expect(extractResidentialUnits("10 No. houses")).toBe(10);
    expect(extractResidentialUnits("10 No houses")).toBe(10);
    expect(extractResidentialUnits("12 No. Apartments")).toBe(12);
    expect(extractResidentialUnits("4 NO. DWELLINGS")).toBe(4);
  });

  it("sees the unit noun behind house-type qualifiers", () => {
    // Real Kildare amendment (19833), which scored null: multi-unit schemes
    // name house types between the count and the noun. 10 approved houses are
    // replaced by 6 + 4 of two other types, so 10 is the scheme's size.
    expect(
      extractResidentialUnits(
        "the replacement of 10 No. previously approved house type G (three bedroom, two " +
          "storey houses) at 45-54 The Avenue, with 6 No. M1 type houses (three bedroom, two " +
          "storey houses) and 4 No. D and D1 type houses (four bedroom, two storey houses)."
      )
    ).toBe(10);
    expect(extractResidentialUnits("6 No. M1 type houses")).toBe(6);
    expect(extractResidentialUnits("block of 4 storeys containing 12 apartments")).toBe(12);
  });

  it("still refuses numbers that describe a unit rather than count them", () => {
    // The guard that makes the qualifier gap above safe. Each of these has a
    // unit noun within a few words of a number, and none of them is a count.
    expect(extractResidentialUnits("3 bedroom houses")).toBeNull();
    expect(extractResidentialUnits("a 4 bed dwelling")).toBeNull();
    expect(extractResidentialUnits("2 storey house")).toBeNull();
    expect(extractResidentialUnits("dwelling 10 metres from the house")).toBeNull();
    expect(extractResidentialUnits("5 no. car parking spaces")).toBeNull();
    expect(extractResidentialUnits("10 North Street")).toBeNull();
  });
});
