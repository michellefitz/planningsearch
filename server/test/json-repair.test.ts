import { describe, expect, it } from "vitest";
import { closeAll, closeTruncatedJson } from "../../api/_ai/json.mjs";

/**
 * Meath 212214 — Trammon, Rathmolyon: a 206-hectare solar farm whose schedule
 * runs to fifteen long conditions. The extract was capped at 2,000 output
 * tokens, the array was cut off part-way through, and a truncated array parses
 * as nothing at all — so the sheet said "couldn't read the decision order"
 * over a decision that had been read perfectly well up to condition eleven.
 *
 * The cap is higher now, which moves the cliff rather than removing it: the
 * schedules that overrun it are exactly the ones worth reading.
 */
describe("closeTruncatedJson", () => {
  it("leaves complete JSON exactly as it is", () => {
    const whole = '{"summary":"Granted.","conditions":[{"number":1,"text":"A"}],"reasons":[]}';
    expect(closeTruncatedJson(whole)).toBe(whole);
    expect(JSON.parse(closeTruncatedJson(whole)).conditions).toHaveLength(1);
  });

  it("keeps the conditions that finished and drops the one that did not", () => {
    const cut =
      '{"summary":"Permission granted subject to conditions.","conditions":[' +
      '{"number":1,"title":"Compliance with plans","text":"Carried out in accordance with the plans."},' +
      '{"number":2,"title":"Period of validity","text":"Ten years from the date of this order."},' +
      '{"number":3,"title":"Decommissioning","text":"The permission shall be for a period of 35 ye';
    const parsed = JSON.parse(closeTruncatedJson(cut));
    expect(parsed.conditions).toHaveLength(2);
    expect(parsed.conditions[1].title).toBe("Period of validity");
    expect(parsed.summary).toBe("Permission granted subject to conditions.");
  });

  it("is not fooled by brackets inside condition wording", () => {
    // Real conditions are full of these: "(a)", "[sic]", "the period (35 years)".
    const cut =
      '{"conditions":[' +
      '{"number":1,"text":"(a) The surface water shall be infiltrated locally. (b) Any changes [to parking] shall comply."},' +
      '{"number":2,"text":"The permission shall be for a period (35 years) from';
    const parsed = JSON.parse(closeTruncatedJson(cut));
    expect(parsed.conditions).toHaveLength(1);
    expect(parsed.conditions[0].text).toContain("(b) Any changes [to parking]");
  });

  it("handles a cut inside an escaped string", () => {
    const cut = '{"conditions":[{"number":1,"text":"He said \\"no\\" to the';
    const parsed = JSON.parse(closeTruncatedJson(cut));
    /**
     * Nothing finished here, so the trailing condition is kept rather than
     * dropped — deliberately. Losing the only condition on a decision would
     * render as "no conditions", which is the one wrong thing this whole
     * feature exists to avoid; a condition that visibly trails off is not.
     */
    expect(parsed.conditions).toHaveLength(1);
    expect(parsed.conditions[0].text).toBe('He said "no" to the');
  });

  it("salvages nothing rather than inventing something", () => {
    const cut = '{"summary":"Permission is gran';
    const parsed = JSON.parse(closeTruncatedJson(cut));
    // The half-written summary is closed, not completed — and downstream
    // clipping and the usable-summary check handle a stub like this.
    expect(typeof parsed.summary).toBe("string");
  });

  it("survives a cut in the middle of the reasons array too", () => {
    const cut =
      '{"summary":"Refused.","conditions":[],"reasons":[' +
      '{"number":1,"text":"Traffic hazard."},{"number":2,"text":"Contrary to the';
    const parsed = JSON.parse(closeTruncatedJson(cut));
    expect(parsed.reasons).toHaveLength(1);
    expect(parsed.conditions).toEqual([]);
  });
});

describe("closeAll", () => {
  it("closes brackets innermost first", () => {
    expect(closeAll('{"a":[{"b":1')).toBe('{"a":[{"b":1}]}');
  });

  it("terminates a string the cut landed inside", () => {
    expect(JSON.parse(closeAll('{"a":"half'))).toEqual({ a: "half" });
  });

  it("leaves balanced text alone", () => {
    expect(closeAll('{"a":1}')).toBe('{"a":1}');
  });
});
