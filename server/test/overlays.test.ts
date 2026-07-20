import { describe, expect, it } from "vitest";
import { classifyZone } from "../src/overlays.js";

describe("classifyZone", () => {
  it("maps common Irish zone objectives onto generalised groups", () => {
    expect(classifyZone("To protect and improve existing residential amenity")).toBe("residential");
    expect(classifyZone("New Residential")).toBe("residential");
    expect(classifyZone("Town Centre / Commercial")).toBe("commercial");
    expect(classifyZone("Retail Warehousing")).toBe("commercial");
    expect(classifyZone("Enterprise and Employment")).toBe("industrial");
    expect(classifyZone("General Industry")).toBe("industrial");
    expect(classifyZone("Community & Educational")).toBe("community");
    expect(classifyZone("Open Space and Recreation")).toBe("open_space");
    expect(classifyZone("Agricultural / Rural")).toBe("agriculture");
    expect(classifyZone("Mixed Use Development")).toBe("mixed");
    expect(classifyZone("Transport and Utilities")).toBe("infrastructure");
  });

  it("prefers mixed-use over its component keywords", () => {
    expect(classifyZone("Mixed Use (residential and commercial)")).toBe("mixed");
  });

  it("falls back to 'other' for unrecognised text", () => {
    expect(classifyZone("Objective XYZ")).toBe("other");
    expect(classifyZone("")).toBe("other");
  });
});
