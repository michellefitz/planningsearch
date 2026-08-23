import { describe, it, expect } from "vitest";
import { corkCsvRowToRecord } from "../src/ingest/cork-city-backfill.js";

const NOW = "2026-08-23T12:00:00.000Z";

describe("corkCsvRowToRecord", () => {
  it("maps a typical Cork CSV row to an ApplicationRecord", () => {
    const row = {
      _id: "1",
      PlanningAuthority: "Cork City Council",
      ApplicationNumber: "1938373",
      DevelopmentAddress: "Unit A, Thompson House, MacCurtain Street",
      Latitude: "56.25",
      Longitude: "-2.06",
      ApplicantSurname: "",
      ApplicantForename: "Brian",
      ApplicantAddress: "10 Gas Terrace",
      DevelopmentDescription: "Change of use from retail to restaurant",
      OneOffHouse: "",
      OneOffHouseKPI: "",
      NumResidentialUnits: "1",
      AreaOfSite: "",
      FloorArea: "",
      LandUseCode: "",
      ApplicationType: "PERMISSION",
      ApplicationStatus: "APPLICATION FINALISED",
      ReceivedDate: "2019-04-30T00:00:00",
      Decision: "CONDITIONAL",
      AppealStatus: "",
      AppealRefNum: "",
      AppealDecision: "",
      LinkAppDetails: "http://planning.corkcity.ie/AppFileRefDetails/1938373/0",
      WithdrawnDate: "",
      DecisionDueDate: "2019-07-30T00:00:00",
      FIRequestDate: "",
      FIRecDate: "",
      DecisionDate: "",
      GrantDate: "2019-09-03T00:00:00",
      ExpiryDate: "2024-10-15T00:00:00",
      AppealSubmittedDate: "",
      AppealDecisionDate: "",
      LGSDIUploadDate: "",
    };

    const rec = corkCsvRowToRecord(row, NOW);
    expect(rec).not.toBeNull();
    expect(rec!.authority_id).toBe("cork-city");
    expect(rec!.planning_reference).toBe("1938373");
    expect(rec!.description).toBe("Change of use from retail to restaurant");
    expect(rec!.received_date).toBe("2019-04-30");
    expect(rec!.final_grant_date).toBe("2019-09-03");
    expect(rec!.applicant_name).toBe("Brian");
    expect(rec!.num_residential_units).toBe(1);
    expect(rec!.source_url).toBe("http://planning.corkcity.ie/AppFileRefDetails/1938373/0");
    // Coordinates outside Cork bbox should be dropped
    expect(rec!.lat).toBeNull();
    expect(rec!.lng).toBeNull();
  });

  it("returns null for rows with no application number", () => {
    expect(corkCsvRowToRecord({ ApplicationNumber: "" }, NOW)).toBeNull();
  });

  it("handles withdrawn applications", () => {
    const row = {
      ApplicationNumber: "2200001",
      DevelopmentDescription: "New dwelling",
      DevelopmentAddress: "1 Main St, Cork",
      ApplicationStatus: "WITHDRAWN",
      Decision: "",
      ApplicationType: "PERMISSION",
      WithdrawnDate: "2022-03-15T00:00:00",
      GrantDate: "",
      AppealDecision: "",
      Latitude: "",
      Longitude: "",
      ApplicantForename: "",
      ApplicantSurname: "",
      LinkAppDetails: "",
      ReceivedDate: "2022-01-01T00:00:00",
      DecisionDueDate: "",
      FIRequestDate: "",
      FIRecDate: "",
      DecisionDate: "",
      ExpiryDate: "",
      AppealStatus: "",
      AppealRefNum: "",
      AppealSubmittedDate: "",
      AppealDecisionDate: "",
      NumResidentialUnits: "",
      FloorArea: "",
    };
    const rec = corkCsvRowToRecord(row, NOW);
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe("withdrawn");
  });

  it("extracts eircode from address", () => {
    const row = {
      ApplicationNumber: "2300001",
      DevelopmentAddress: "5 Lapp's Quay, Cork, T12 ABC1",
      DevelopmentDescription: "Office renovation",
      ApplicationStatus: "APPLICATION FINALISED",
      Decision: "GRANT",
      ApplicationType: "PERMISSION",
      WithdrawnDate: "",
      GrantDate: "2023-06-01T00:00:00",
      AppealDecision: "",
      Latitude: "",
      Longitude: "",
      ApplicantForename: "",
      ApplicantSurname: "",
      LinkAppDetails: "",
      ReceivedDate: "2023-01-01T00:00:00",
      DecisionDueDate: "",
      FIRequestDate: "",
      FIRecDate: "",
      DecisionDate: "",
      ExpiryDate: "",
      AppealStatus: "",
      AppealRefNum: "",
      AppealSubmittedDate: "",
      AppealDecisionDate: "",
      NumResidentialUnits: "",
      FloorArea: "",
    };
    const rec = corkCsvRowToRecord(row, NOW);
    expect(rec!.eircode).toBe("T12 ABC1");
  });

  it("falls back to portal URL when LinkAppDetails is empty", () => {
    const row = {
      ApplicationNumber: "2400001",
      DevelopmentDescription: "Shed",
      DevelopmentAddress: "Somewhere",
      ApplicationStatus: "PENDING",
      Decision: "",
      ApplicationType: "PERMISSION",
      WithdrawnDate: "",
      GrantDate: "",
      AppealDecision: "",
      Latitude: "",
      Longitude: "",
      ApplicantForename: "",
      ApplicantSurname: "",
      LinkAppDetails: "",
      ReceivedDate: "",
      DecisionDueDate: "",
      FIRequestDate: "",
      FIRecDate: "",
      DecisionDate: "",
      ExpiryDate: "",
      AppealStatus: "",
      AppealRefNum: "",
      AppealSubmittedDate: "",
      AppealDecisionDate: "",
      NumResidentialUnits: "",
      FloorArea: "",
    };
    const rec = corkCsvRowToRecord(row, NOW);
    expect(rec!.source_url).toContain("agileapplications.ie/corkcity");
    expect(rec!.source_url).toContain("2400001");
  });
});
