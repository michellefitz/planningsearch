import { describe, expect, it } from "vitest";
import {
  houseNumbers,
  idfOver,
  queryHouseNumbers,
  relevanceScore,
} from "../../api/_search/relevance.mjs";

/**
 * Real Dublin City rows from the search that prompted this. Typing "22 Rathgar
 * Road" returned the house itself at ranks 13 and 14, behind eleven addresses
 * that had nothing to do with number 22 — every one of them an application
 * filed in 2022, whose reference ends "/22" and scored higher for it than the
 * address did for being the address.
 */
const ROWS = [
  { id: 1, planning_reference: "3952/22", address_text: "22 Rathgar Road, Dublin 6", description: "Protected structure: permission and retention permission" },
  { id: 2, planning_reference: "4034/22", address_text: "22, Rathgar Road, Dublin 6", description: "Protected structure: the development will consist of" },
  { id: 3, planning_reference: "4989/23", address_text: "22 Rathgar Road, Dublin 6", description: "Protected structure: permission for widening of vehicular access" },
  { id: 4, planning_reference: "2235/19", address_text: "17A/18, Rathgar Road, Dublin 6", description: "Change of use permission at 17a/18 Rathgar Road" },
  { id: 5, planning_reference: "3922/20", address_text: "Land at Orwell Mews, to the rear of 30 Orwell Road, Rathgar, Dublin 6", description: "Permission for a mews dwelling" },
  { id: 6, planning_reference: "2214/21", address_text: "Site at Garville Road, to rear of 139 Rathgar Road, Dublin 6", description: "Permission for a dwelling" },
  { id: 7, planning_reference: "4222/24", address_text: "Site to the rear of 26 Highfield Road, Rathgar, Dublin 6", description: "Permission for a dwelling" },
  { id: 8, planning_reference: "4513/22", address_text: "56 Orwell Road, Rathgar, Dublin 6, D06 K7R8", description: "Permission for an extension" },
  { id: 9, planning_reference: "3066/21", address_text: "22, Brighton Road, Rathgar, Dublin 6", description: "Permission for an extension" },
  { id: 10, planning_reference: "3379/19", address_text: "189 & 190, Rathgar Road, Dublin 6", description: "Permission for works" },
  { id: 11, planning_reference: "5147/22", address_text: "Rear of 138, Rathgar Road Rathgar, Dublin 6", description: "Permission for a dwelling" },
];

const haystack = (a: { planning_reference?: string; address_text?: string; description?: string }) =>
  [a.planning_reference, a.address_text, a.description].filter(Boolean).join(" • ").toLowerCase();

function rank(q: string, rows = ROWS) {
  const tokens = q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
  const idf = idfOver(rows, tokens, haystack);
  const wanted = queryHouseNumbers(q);
  return rows
    .map((a) => ({ a, s: relevanceScore(a, tokens, idf, wanted) }))
    .sort((x, y) => y.s - x.s)
    .map((x) => x.a.planning_reference);
}

describe("house numbers", () => {
  it("reads the number an address opens with", () => {
    expect(houseNumbers("22 Rathgar Road, Dublin 6")).toEqual(["22"]);
    expect(houseNumbers("22, Rathgar Road, Dublin 6")).toEqual(["22"]);
    expect(houseNumbers("No. 1A, Rathgar Place, Rathmines")).toEqual(["1a"]);
  });

  it("keeps pairs and ranges whole", () => {
    expect(houseNumbers("77A-78 Rathgar Road")).toEqual(["77a", "78"]);
    expect(houseNumbers("122 & 123, Rathgar Road")).toEqual(["122", "123"]);
    expect(houseNumbers("17A/18, Rathgar Road")).toEqual(["17a", "18"]);
  });

  it("steps over a flat number to reach the house", () => {
    expect(houseNumbers("Apt 4, 22 Main Street")).toEqual(["22"]);
  });

  /** The back garden of 139 is not number 139 — it is filed under its own
   *  frontage, and returning it for "139 Rathgar Road" is a different site. */
  it("does not read a number the address merely refers to", () => {
    expect(houseNumbers("Site at Garville Road, to rear of 139 Rathgar Road")).toEqual([]);
    expect(houseNumbers("Rear of 138, Rathgar Road")).toEqual([]);
  });

  it("does not read a postal district as a door number", () => {
    expect(queryHouseNumbers("22 Rathgar Road, Dublin 6")).toEqual(["22"]);
    expect(queryHouseNumbers("Rathgar Road, Dublin 6")).toEqual([]);
  });
});

describe("ranking an address search", () => {
  it("puts the house itself first, and every application on it", () => {
    expect(rank("22 Rathgar Road").slice(0, 3).sort()).toEqual(["3952/22", "4034/22", "4989/23"]);
  });

  /** Choosing the geocoded suggestion types the district for you; it used to
   *  push the house out of the first fifteen results entirely. */
  it("survives the district the suggestion appends", () => {
    expect(rank("22 Rathgar Road, Dublin 6").slice(0, 3).sort()).toEqual([
      "3952/22",
      "4034/22",
      "4989/23",
    ]);
  });

  it("does not let a 2022 reference stand in for house number 22", () => {
    const order = rank("22 Rathgar Road");
    expect(order.indexOf("3952/22")).toBeLessThan(order.indexOf("4513/22"));
    expect(order.indexOf("4989/23")).toBeLessThan(order.indexOf("2235/19"));
  });

  it("does not match a different house on the same street", () => {
    const order = rank("22 Rathgar Road");
    for (const other of ["3379/19", "5147/22", "2214/21"]) {
      expect(order.indexOf("4034/22")).toBeLessThan(order.indexOf(other));
    }
  });

  /** Number 22 on a different street is not the address that was typed. */
  it("does not match the same number on a different street", () => {
    const order = rank("22 Rathgar Road");
    expect(order.indexOf("4034/22")).toBeLessThan(order.indexOf("3066/21"));
  });

  it("still finds a reference typed on its own", () => {
    expect(rank("3952")[0]).toBe("3952/22");
    expect(rank("4034/22")[0]).toBe("4034/22");
  });

  it("ranks the street ahead of rows that only mention it", () => {
    const order = rank("Rathgar Road");
    expect(order.indexOf("3379/19")).toBeLessThan(order.indexOf("4513/22"));
  });
});
