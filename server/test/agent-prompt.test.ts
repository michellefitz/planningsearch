import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../src/agent/prompt.js";

describe("SYSTEM_PROMPT", () => {
  it("carries the core rules", () => {
    expect(SYSTEM_PROMPT).toMatch(/\[app:id:/);            // card token format
    expect(SYSTEM_PROMPT).toMatch(/never predict/i);        // evidence-not-prediction
    expect(SYSTEM_PROMPT).toMatch(/boilerplate/i);          // condition triage
    expect(SYSTEM_PROMPT).toMatch(/eircode/i);              // clarify vague locations
    expect(SYSTEM_PROMPT).toMatch(/An Coimisiún Pleanála/); // appeals context
  });
});
