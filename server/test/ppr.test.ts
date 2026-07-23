import { describe, expect, it } from "vitest";
import {
  eircodeKey,
  isSpecificAddress,
  lookupPpr,
  normalizeAddress,
  parseCsv,
  parsePprCsv,
  type PprIndex,
  type PprSale,
} from "../src/ingest/ppr.js";

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

describe("eircodeKey", () => {
  it("normalises real Eircodes and rejects junk", () => {
    expect(eircodeKey("W91 A1B2")).toBe("W91A1B2");
    expect(eircodeKey("w91a1b2")).toBe("W91A1B2");
    expect(eircodeKey("D6W 1234")).toBe("D6W1234");
    expect(eircodeKey("2.")).toBeNull();
    expect(eircodeKey("")).toBeNull();
    expect(eircodeKey(null)).toBeNull();
  });
});

describe("parsePprCsv", () => {
  const CSV =
    'Date of Sale (dd/mm/yyyy),Address,County,Eircode,Price (€),Not Full Market Price,VAT Exclusive,Description of Property,Property Size Description\n' +
    '"05/01/2026","1 Beechtree Place, Curragh Farm, Ballymany","Kildare","W91 A1B2","€409,691.63","No","Yes","New Dwelling house /Apartment",""\n' +
    '"03/02/2026","Bad Row Without Price","Kildare","","","No","No","Second-Hand",""\n';

  it("parses quoted fields with embedded commas, euro prices, dates and eircode", () => {
    const sales = parsePprCsv(CSV);
    expect(sales).toEqual([
      {
        date: "2026-01-05",
        price: 409692,
        address: "1 Beechtree Place, Curragh Farm, Ballymany",
        description: "New Dwelling house /Apartment",
        vatExclusive: true,
        notFullMarket: false,
        eircode: "W91A1B2",
      },
    ]);
  });

  it("handles escaped quotes in fields", () => {
    expect(parseCsv('"say ""hi""",b')).toEqual([['say "hi"', "b"]]);
  });
});

describe("lookupPpr", () => {
  const sale = (over: Partial<PprSale>): PprSale => ({
    date: "2022-05-01",
    price: 400000,
    address: "Apt 5, The Mill, Naas",
    description: null,
    vatExclusive: false,
    notFullMarket: false,
    eircode: null,
    ...over,
  });
  const index: PprIndex = {
    byAddress: new Map([["12 CARAGH MEADOWS NAAS", [sale({ address: "12 Caragh Meadows, Naas" })]]]),
    byEircode: new Map([["W91A1B2", [sale({ eircode: "W91A1B2" })]]]),
  };

  it("matches on Eircode first (works where the address wouldn't)", () => {
    const hit = lookupPpr(index, { address_text: "Apt 5, The Mill, Naas", eircode: "W91 A1B2" });
    expect(hit?.[0].eircode).toBe("W91A1B2");
  });

  it("falls back to a specific address when there is no Eircode", () => {
    expect(lookupPpr(index, { address_text: "12 Caragh Meadows, Naas", eircode: null })).toHaveLength(1);
  });

  it("returns null for a townland-only address with no Eircode", () => {
    expect(lookupPpr(index, { address_text: "Hughestown, Moone", eircode: null })).toBeNull();
  });
});
