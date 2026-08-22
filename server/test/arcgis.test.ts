import { describe, expect, it } from "vitest";
import { buildWhereClause, featureToRecord, type ArcgisFeature } from "../src/ingest/arcgis.js";
import { authorityIdForNationalName } from "../src/config/authorities.js";
import { normalizeStatus } from "../src/normalize.js";

/** Real record from the live service (2026-07-18), verbatim. */
const CARLOW_SAMPLE: ArcgisFeature = {
  attributes: {
    OBJECTID: 1,
    PlanningAuthority: "Carlow County Council",
    ApplicationNumber: "19382",
    DevelopmentDescription:
      "the erection of a storage shed for the storage of vintage machinery and all associated site works.",
    DevelopmentAddress: "Slyguff , Bagenalstown , Co Carlow",
    DevelopmentPostcode: "",
    ApplicationStatus: "APPLICATION FINALISED",
    ApplicationType: "PERMISSION",
    ApplicantForename: null,
    ApplicantSurname: null,
    Decision: "CONDITIONAL",
    ReceivedDate: 1569456000000,
    DecisionDate: 1596585600000,
    DecisionDueDate: 1596931200000,
    GrantDate: 1599436800000,
    FIRequestDate: 1574121600000,
    FIRecDate: 1594598400000,
    OneOffHouse: " ",
    LinkAppDetails: "http://www.eplanning.ie/CarlowCC/AppFileRefDetails/19382/0",
  },
  geometry: { x: -6.96, y: 52.7 },
};

describe("authorityIdForNationalName", () => {
  it("matches every covered authority including accent/hyphen variants", () => {
    expect(authorityIdForNationalName("Dublin City Council")).toBe("dublin-city");
    expect(authorityIdForNationalName("Fingal County Council")).toBe("fingal");
    expect(authorityIdForNationalName("Dun Laoghaire Rathdown County Council")).toBe("dlr");
    expect(authorityIdForNationalName("Dún Laoghaire-Rathdown County Council")).toBe("dlr");
    expect(authorityIdForNationalName("South Dublin County Council")).toBe("south-dublin");
    expect(authorityIdForNationalName("Kildare County Council")).toBe("kildare");
    expect(authorityIdForNationalName("Meath County Council")).toBe("meath");
    expect(authorityIdForNationalName("Wicklow County Council")).toBe("wicklow");
  });

  it("does not read Westmeath as Meath", () => {
    // The matcher was a raw substring, and "westmeath county council" contains
    // "meath" — every one of Westmeath's ~5,500 applications would have been
    // filed under Meath the moment Meath was added.
    expect(authorityIdForNationalName("Westmeath County Council")).toBeNull();
    // The same class of trap for anything else that ends in a covered name.
    expect(authorityIdForNationalName("North Tipperary County Council")).toBeNull();
  });
  it("rejects out-of-scope authorities", () => {
    expect(authorityIdForNationalName("Carlow County Council")).toBeNull();
    expect(authorityIdForNationalName("Leitrim County Council")).toBeNull();
  });
  it("resolves the three new Agile councils", () => {
    expect(authorityIdForNationalName("Cork City Council")).toBe("cork-city");
    expect(authorityIdForNationalName("Cork County Council")).toBe("cork-county");
    expect(authorityIdForNationalName("Wexford County Council")).toBe("wexford");
  });
});

describe("national dataset status vocabulary", () => {
  it("resolves FINALISED via the Decision field", () => {
    expect(normalizeStatus("APPLICATION FINALISED", "CONDITIONAL")).toBe("granted");
    expect(normalizeStatus("APPLICATION FINALISED", "UNCONDITIONAL")).toBe("granted");
    expect(normalizeStatus("APPLICATION FINALISED", "REFUSED")).toBe("refused");
    expect(normalizeStatus("DECISION MADE", "REFUSED")).toBe("refused");
  });
  it("does not assume an outcome when finalised has no decision", () => {
    expect(normalizeStatus("APPLICATION FINALISED", null)).toBe("unknown");
  });
});

describe("featureToRecord", () => {
  it("skips authorities outside the five (Carlow sample)", () => {
    expect(featureToRecord(CARLOW_SAMPLE)).toBeNull();
  });

  it("lets a decided appeal trump the council decision (3014/23 values)", () => {
    const feature: ArcgisFeature = {
      attributes: {
        ...CARLOW_SAMPLE.attributes,
        PlanningAuthority: "Dublin City Council",
        ApplicationNumber: "3014/23",
        ApplicationStatus: "Appeal Decided",
        Decision: "REFUSE PERMISSION",
        AppealRefNumber: "ABP-316177-23",
        AppealSubmittedDate: 1680480000000,
        AppealDecision: "GRANT PERMISSION",
        AppealDecisionDate: 1716336000000,
        LinkAppDetails: null,
      },
      geometry: { x: -6.26, y: 53.35 },
    };
    const rec = featureToRecord(feature, "2026-07-19T00:00:00Z")!;
    expect(rec.status).toBe("granted");
    expect(rec.decision).toBe("REFUSE PERMISSION");
    expect(rec.appeal_reference).toBe("ABP-316177-23");
    expect(rec.appeal_lodged_date).toBe("2023-04-03");
    expect(rec.appeal_decision).toBe("GRANT PERMISSION");
    expect(rec.appeal_decision_date).toBe("2024-05-22");
  });

  it("keeps the council grant when the appeal only MODIFIED conditions (24134 values)", () => {
    const feature: ArcgisFeature = {
      attributes: {
        ...CARLOW_SAMPLE.attributes,
        PlanningAuthority: "Kildare County Council",
        ApplicationNumber: "24134",
        ApplicationStatus: "APPLICATION FINALISED",
        Decision: "CONDITIONAL",
        AppealRefNumber: "ABP-320138-24",
        AppealSubmittedDate: 1720569600000,
        AppealDecision: "MODIFIED",
        AppealDecisionDate: 1729728000000,
        LinkAppDetails: null,
      },
      geometry: { x: -6.5188, y: 53.3684 },
    };
    const rec = featureToRecord(feature, "2026-07-20T00:00:00Z")!;
    // The board modified the conditions of a granted permission — still granted,
    // not "unknown".
    expect(rec.status).toBe("granted");
    expect(rec.appeal_decision).toBe("MODIFIED");
  });

  it("bakes a truncated 'declared invalid' decision as invalid (DCC 4497/23)", () => {
    const feature: ArcgisFeature = {
      attributes: {
        ...CARLOW_SAMPLE.attributes,
        PlanningAuthority: "Dublin City Council",
        ApplicationNumber: "4497/23",
        ApplicationStatus: "Decision Notice Issued",
        Decision: "APPLICATION DECLARED INVA",
        DecisionDate: 1695600000000,
        GrantDate: null,
        LinkAppDetails: null,
      },
      geometry: { x: -6.31, y: 53.31 },
    };
    const rec = featureToRecord(feature, "2026-07-21T00:00:00Z")!;
    expect(rec.status).toBe("invalid");
  });

  it("infers granted from a final grant date when the decision text is blank", () => {
    const feature: ArcgisFeature = {
      attributes: {
        ...CARLOW_SAMPLE.attributes,
        PlanningAuthority: "Dublin City Council",
        ApplicationNumber: "9999/23",
        ApplicationStatus: "Decision Notice Issued",
        Decision: null,
        GrantDate: 1599436800000,
        LinkAppDetails: null,
      },
      geometry: { x: -6.26, y: 53.35 },
    };
    const rec = featureToRecord(feature, "2026-07-21T00:00:00Z")!;
    expect(rec.status).toBe("granted");
    expect(rec.final_grant_date).toBe("2020-09-07");
  });

  it("maps the verified live schema for an in-scope authority", () => {
    const feature: ArcgisFeature = {
      attributes: {
        ...CARLOW_SAMPLE.attributes,
        PlanningAuthority: "Fingal County Council",
        ApplicationNumber: "F24A/0101",
        DevelopmentPostcode: "K67X2Y8",
        OneOffHouse: "Yes",
      },
      geometry: { x: -6.2181, y: 53.4597 },
    };
    const rec = featureToRecord(feature, "2026-07-18T00:00:00Z")!;
    expect(rec.authority_id).toBe("fingal");
    expect(rec.planning_reference).toBe("F24A/0101");
    expect(rec.status).toBe("granted"); // FINALISED + CONDITIONAL
    expect(rec.received_date).toBe("2019-09-26"); // epoch millis → ISO date
    expect(rec.decision_date).toBe("2020-08-05");
    expect(rec.final_grant_date).toBe("2020-09-07");
    expect(rec.further_info_requested_date).toBe("2019-11-19");
    expect(rec.eircode).toBe("K67 X2Y8"); // DevelopmentPostcode, formatted
    expect(rec.is_domestic_guess).toBe(1); // OneOffHouse=Yes
    // Fingal is Agile-hosted: a LinkAppDetails pointing anywhere else is
    // stale and gets replaced with the Agile portal fallback.
    expect(rec.source_url).toContain("planning.agileapplications.ie/fingal");
    expect(rec.lat).toBeCloseTo(53.4597);
    expect(rec.lng).toBeCloseTo(-6.2181);
  });

  it("drops geometry that is far outside the authority", () => {
    const feature: ArcgisFeature = {
      attributes: { ...CARLOW_SAMPLE.attributes, PlanningAuthority: "Kildare County Council" },
      geometry: { x: 2.35, y: 48.85 }, // Paris — projection mishap
    };
    const rec = featureToRecord(feature)!;
    expect(rec.lat).toBeNull();
    expect(rec.lng).toBeNull();
  });

  it("recognises every council's spelling of the one-off-house flag", () => {
    // Counted against the live feed: South Dublin writes "Yes", Kildare "One",
    // Fingal "Single House" (space-padded). Matching only Y/Yes dropped the
    // latter two, so ~5,600 one-off houses fell back to the description
    // heuristic for a signal the register had already given us.
    const flagged = (value: string) =>
      featureToRecord({
        attributes: {
          ...CARLOW_SAMPLE.attributes,
          PlanningAuthority: "Kildare County Council",
          // A description with no domestic wording, so the flag is what decides.
          DevelopmentDescription: "development at this site",
          OneOffHouse: value,
        },
        geometry: { x: -6.59, y: 53.38 },
      })!.is_domestic_guess;

    for (const yes of ["Y", "Yes", "One", "Single House", "Single House    ", " one "]) {
      expect(flagged(yes)).toBe(1);
    }
    for (const no of ["No", "", " ", "None", "Two"]) {
      expect(flagged(no)).toBe(0);
    }
  });

  it("never reads AreaofSite as hectares", () => {
    // Measured against true site geometry (300 samples per authority), four of
    // the five councils publish AreaofSite in square metres and only Kildare in
    // hectares. Reading the field as hectares made a 292 m² back garden read as
    // 292 hectares. Site area now comes from the site boundary — fetchAllSites
    // measures it — so nothing here may take the field at face value.
    const dublin: ArcgisFeature = {
      attributes: {
        ...CARLOW_SAMPLE.attributes,
        PlanningAuthority: "Dublin City Council",
        AreaofSite: 292.18, // square metres, whatever the field is named
      },
      geometry: { x: -6.26, y: 53.35 },
    };
    expect(featureToRecord(dublin)!.site_area_ha).toBeNull();

    const kildare: ArcgisFeature = {
      attributes: {
        ...CARLOW_SAMPLE.attributes,
        PlanningAuthority: "Kildare County Council",
        AreaofSite: 0.115, // hectares, for the same nominal field
      },
      geometry: { x: -6.59, y: 53.38 },
    };
    expect(featureToRecord(kildare)!.site_area_ha).toBeNull();
  });
});

describe("buildWhereClause", () => {
  it("uses tolerant LIKE matching and the received-date floor", () => {
    const where = buildWhereClause("2024-07-18");
    expect(where).toContain("PlanningAuthority LIKE '%Laoghaire%'");
    expect(where).toContain("PlanningAuthority LIKE '%South Dublin%'");
    expect(where).toContain("ReceivedDate >= TIMESTAMP '2024-07-18 00:00:00'");
    // LIKE has no word boundaries, so Meath carries an explicit exclusion —
    // otherwise the fetch drags every Westmeath application across the wire.
    expect(where).toContain("PlanningAuthority LIKE '%Meath%'");
    expect(where).toContain("PlanningAuthority NOT LIKE '%Westmeath%'");
  });
});
