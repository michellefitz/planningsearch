import { describe, it, expect } from "vitest";
import { kccFeatureToRecord } from "../src/ingest/kcc-backfill.js";

const NOW = "2026-08-22T12:00:00.000Z";

describe("kccFeatureToRecord", () => {
  it("maps a typical KCC feature to an ApplicationRecord", () => {
    const feature = {
      attributes: {
        File_Number: "23594",
        Description: "construction of a two storey dwelling house",
        Full_Address: "Teach Bohereen, Bawnogues, Straffan",
        Forename: "John",
        Surname: "Smith",
        Year: 2023,
        Status: "APPLICATION FINALISED",
        Application_Type: "PERMISSION",
        Decision: "GRANT",
        Received_Date: 1685577600000,
        Withdrawn_Date: null,
        Decision_Date: 1690848000000,
        Decision_Due_Date: 1690848000000,
        Grant_Date: 1693526400000,
        Expiry_Date: 1851292800000,
        Last_Date_For_Submissions: 1687392000000,
        ACP_Appeals: null,
        OBJECTID: 1,
      },
      geometry: { x: -6.65, y: 53.35 },
    };
    const rec = kccFeatureToRecord(feature, NOW);
    expect(rec).not.toBeNull();
    expect(rec!.authority_id).toBe("kildare");
    expect(rec!.planning_reference).toBe("23594");
    expect(rec!.status).toBe("granted");
    expect(rec!.decision).toBe("GRANT");
    expect(rec!.applicant_name).toBe("John Smith");
    expect(rec!.application_type).toBe("permission");
    expect(rec!.lat).toBeCloseTo(53.35);
    expect(rec!.lng).toBeCloseTo(-6.65);
    expect(rec!.submissions_by_date).not.toBeNull();
  });

  it("handles negative epoch dates (pre-1970)", () => {
    const feature = {
      attributes: {
        File_Number: "551702",
        Description: "RECONSTRUCTION OF HOUSE",
        Full_Address: null,
        Forename: "JOSEPH",
        Surname: "KINAHAN",
        Year: 1955,
        Status: "DECISION MADE",
        Application_Type: "PERMISSION",
        Decision: "GRANT",
        Received_Date: -473385600000,
        Withdrawn_Date: null,
        Decision_Date: -468374400000,
        Decision_Due_Date: -468374400000,
        Grant_Date: -465696000000,
        Expiry_Date: -308016000000,
        Last_Date_For_Submissions: null,
        ACP_Appeals: null,
        OBJECTID: 48616,
      },
      geometry: { x: -6.95, y: 52.95 },
    };
    const rec = kccFeatureToRecord(feature, NOW);
    expect(rec).not.toBeNull();
    expect(rec!.received_date).toBe("1955-01-01");
    expect(rec!.status).toBe("granted");
    expect(rec!.final_grant_date).toMatch(/^195/);
  });

  it("normalises 'EXTENTION OF DURATION' application type", () => {
    const feature = {
      attributes: {
        File_Number: "12345",
        Description: "extension of duration of planning permission",
        Full_Address: "Main St, Naas",
        Forename: null,
        Surname: null,
        Year: 2020,
        Status: "APPLICATION FINALISED",
        Application_Type: "EXTENTION OF DURATION",
        Decision: "GRANT",
        Received_Date: 1590000000000,
        Withdrawn_Date: null,
        Decision_Date: 1592000000000,
        Decision_Due_Date: null,
        Grant_Date: 1593000000000,
        Expiry_Date: null,
        Last_Date_For_Submissions: null,
        ACP_Appeals: null,
        OBJECTID: 2,
      },
      geometry: { x: -6.66, y: 53.22 },
    };
    const rec = kccFeatureToRecord(feature, NOW);
    expect(rec!.application_type).toBe("extension_of_duration");
  });

  it("marks withdrawn applications correctly", () => {
    const feature = {
      attributes: {
        File_Number: "99999",
        Description: "new dwelling",
        Full_Address: "Some Place, Kildare",
        Forename: null,
        Surname: null,
        Year: 2021,
        Status: "WITHDRAWN",
        Application_Type: "PERMISSION",
        Decision: null,
        Received_Date: 1609459200000,
        Withdrawn_Date: 1612137600000,
        Decision_Date: null,
        Decision_Due_Date: null,
        Grant_Date: null,
        Expiry_Date: null,
        Last_Date_For_Submissions: null,
        ACP_Appeals: null,
        OBJECTID: 3,
      },
      geometry: { x: -6.9, y: 53.1 },
    };
    const rec = kccFeatureToRecord(feature, NOW);
    expect(rec!.status).toBe("withdrawn");
  });

  it("drops features outside the Kildare bbox", () => {
    const feature = {
      attributes: {
        File_Number: "88888",
        Description: "test",
        Full_Address: null,
        Forename: null,
        Surname: null,
        Year: 2020,
        Status: "NEW APPLICATION",
        Application_Type: "PERMISSION",
        Decision: null,
        Received_Date: 1590000000000,
        Withdrawn_Date: null,
        Decision_Date: null,
        Decision_Due_Date: null,
        Grant_Date: null,
        Expiry_Date: null,
        Last_Date_For_Submissions: null,
        ACP_Appeals: null,
        OBJECTID: 4,
      },
      geometry: { x: -10.0, y: 51.0 },
    };
    const rec = kccFeatureToRecord(feature, NOW);
    expect(rec).not.toBeNull();
    expect(rec!.lat).toBeNull();
    expect(rec!.lng).toBeNull();
  });

  it("returns null for features with no reference", () => {
    const feature = {
      attributes: {
        File_Number: null,
        Description: "test",
        Full_Address: null,
        Forename: null,
        Surname: null,
        Year: 2020,
        Status: "NEW APPLICATION",
        Application_Type: "PERMISSION",
        Decision: null,
        Received_Date: 1590000000000,
        Withdrawn_Date: null,
        Decision_Date: null,
        Decision_Due_Date: null,
        Grant_Date: null,
        Expiry_Date: null,
        Last_Date_For_Submissions: null,
        ACP_Appeals: null,
        OBJECTID: 5,
      },
      geometry: { x: -6.7, y: 53.2 },
    };
    expect(kccFeatureToRecord(feature, NOW)).toBeNull();
  });
});
