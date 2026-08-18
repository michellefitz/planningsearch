import { describe, expect, it } from "vitest";
import {
  eircodeKey,
  extractEircode,
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
    expect(normalizeAddress("12 Griffith Road, Dublin 11")).toBe("12 GRIFFITH RD DUBLIN 11");
  });

  it("strips an embedded Eircode so it doesn't defeat the address match", () => {
    expect(normalizeAddress("31 Mount Prospect Drive, Dublin 3, D03 WP89")).toBe(
      "31 MOUNT PROSPECT DR DUBLIN 3"
    );
  });

  // The register abbreviates, the planning registers spell out. 28 Gilford
  // Road is the case that surfaced it: two sales, €3.5m and €3m, filed under
  // "28 GILFORD RD" and matching nothing.
  it("reads the register's abbreviations and the council's long forms as one", () => {
    expect(normalizeAddress("28, Gilford Road, Sandymount, Dublin 4")).toBe(
      normalizeAddress("28 GILFORD RD, SANDYMOUNT, DUBLIN 4")
    );
    expect(normalizeAddress("46 Joyce Avenue, Foxrock, Dublin 18")).toBe(
      normalizeAddress("46 JOYCE AVE, FOXROCK, DUBLIN 18")
    );
    expect(normalizeAddress("12 Rockville Drive, Blackrock")).toBe(
      normalizeAddress("12 ROCKVILLE DR, BLACKROCK")
    );
    expect(normalizeAddress("26 Penrose Street, Ringsend")).toBe(
      normalizeAddress("26 PENROSE ST, RINGSEND")
    );
    expect(normalizeAddress("33 Leinster Square, Rathmines")).toBe(
      normalizeAddress("33 LEINSTER SQ, RATHMINES")
    );
    expect(normalizeAddress("Apartment 96, Marlborough Court")).toBe(
      normalizeAddress("APT 96, MARLBOROUGH COURT")
    );
    expect(normalizeAddress("20A Mountpleasant Avenue Lower, Ranelagh")).toBe(
      normalizeAddress("20A MOUNTPLEASANT AVE LWR, RANELAGH")
    );
  });

  // Folding to the short form is what keeps the one genuinely ambiguous word
  // safe: SAINT and STREET both become ST, but they sit in different places in
  // the address, so a saint's name never collides with a street's.
  it("does not confuse a saint with a street", () => {
    expect(normalizeAddress("1 St John's Road, Dublin 8")).toBe(
      normalizeAddress("1 SAINT JOHNS RD, DUBLIN 8")
    );
    expect(normalizeAddress("1 St John's Road, Dublin 8")).not.toBe(
      normalizeAddress("1 John Street, Dublin 8")
    );
  });

  // Apostrophes close up rather than splitting a word in two: "JOHN S" was
  // matching nothing.
  it("reads an apostrophe the same way whichever glyph is used", () => {
    expect(normalizeAddress("24, St Brigid's Road, Clondalkin")).toBe(
      normalizeAddress("24 ST BRIGIDS RD, CLONDALKIN")
    );
    expect(normalizeAddress("104, St Maelruan\u2019s Park, Tallaght")).toBe(
      normalizeAddress("104 ST MAELRUANS PARK, TALLAGHT")
    );
  });

  // Short forms the register barely uses are left alone: GR is Green as often
  // as Grove, and folding it would merge two streets in the same estate.
  it("leaves the ambiguous long tail of abbreviations alone", () => {
    expect(normalizeAddress("12 Elm Grove, Lucan")).not.toBe(normalizeAddress("12 Elm GR, Lucan"));
    expect(normalizeAddress("12 Elm Park, Lucan")).not.toBe(normalizeAddress("12 Elm PK, Lucan"));
  });
});

describe("extractEircode", () => {
  it("pulls an Eircode out of an address, or returns null", () => {
    expect(extractEircode("31 Mount Prospect Drive, Dublin 3, D03 WP89")).toBe("D03 WP89");
    expect(extractEircode("Apt 4, The Mill, D6W1234")).toBe("D6W 1234");
    expect(extractEircode("31 Mount Prospect Drive, Dublin 3")).toBeNull();
    expect(extractEircode(null)).toBeNull();
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

  it("recovers an Eircode embedded in the address when the field is blank (WEB2898/25)", () => {
    const hit = lookupPpr(index, {
      address_text: "31 Mount Prospect Drive, Dublin 3, W91 A1B2",
      eircode: null,
    });
    expect(hit?.[0].eircode).toBe("W91A1B2");
  });

  it("returns null for a townland-only address with no Eircode", () => {
    expect(lookupPpr(index, { address_text: "Hughestown, Moone", eircode: null })).toBeNull();
  });
});
