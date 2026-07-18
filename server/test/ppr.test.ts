import { describe, expect, it } from "vitest";
import { isSpecificAddress, normalizeAddress, parseCsv, parsePprCsv } from "../src/ingest/ppr.js";

describe("normalizeAddress", () => {
  it("matches planning and PPR spellings of the same address", () => {
    expect(normalizeAddress("28 Caragh Meadows , Naas , Co. Kildare")).toBe(
      normalizeAddress("28 Caragh Meadows, Naas")
    );
    expect(normalizeAddress("145 Oughterany Village , Kilcock , Co Kildare")).toBe(
      "145 OUGHTERANY VILLAGE KILCOCK"
    );
  });

  it("keeps Dublin postal districts (they distinguish addresses)", () => {
    expect(normalizeAddress("12 Griffith Road, Dublin 11")).toBe("12 GRIFFITH ROAD DUBLIN 11");
  });
});

describe("isSpecificAddress", () => {
  it("requires a house/unit number", () => {
    expect(isSpecificAddress(normalizeAddress("Hughestown, Moone, Kildare"))).toBe(false);
    expect(isSpecificAddress(normalizeAddress("28 Caragh Meadows, Naas"))).toBe(true);
  });
});

describe("parsePprCsv", () => {
  const CSV =
    'Date of Sale (dd/mm/yyyy),Address,County,Eircode,Price (€),Not Full Market Price,VAT Exclusive,Description of Property,Property Size Description\n' +
    '"05/01/2026","1 Beechtree Place, Curragh Farm, Ballymany","Kildare","","€409,691.63","No","Yes","New Dwelling house /Apartment",""\n' +
    '"03/02/2026","Bad Row Without Price","Kildare","","","No","No","Second-Hand",""\n';

  it("parses quoted fields with embedded commas, euro prices and dd/mm/yyyy dates", () => {
    const sales = parsePprCsv(CSV);
    expect(sales).toEqual([
      {
        date: "2026-01-05",
        price: 409692,
        address: "1 Beechtree Place, Curragh Farm, Ballymany",
        description: "New Dwelling house /Apartment",
        vatExclusive: true,
        notFullMarket: false,
      },
    ]);
  });

  it("handles escaped quotes in fields", () => {
    expect(parseCsv('"say ""hi""",b')).toEqual([['say "hi"', "b"]]);
  });
});
