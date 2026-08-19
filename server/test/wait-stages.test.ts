import { describe, expect, it } from "vitest";
import { stageMessage } from "../../web/src/loading";

/**
 * The wording a wait shows, and when. Verified in the browser for the file
 * list and the conditions — this pins the boundaries, which are the part a
 * browser test cannot reliably hit twice.
 */
const FILES: Array<[number, string]> = [
  [0, "Fetching the file list from Dublin City…"],
  [6, "Still fetching — Dublin City's portal is slow to answer."],
  [18, "Still going. The council's own site is the slow part here."],
];

describe("wait stages", () => {
  it("says something from the first frame", () => {
    expect(stageMessage(0, FILES)).toBe(FILES[0][1]);
  });

  it("moves on only once the wait has earned it", () => {
    expect(stageMessage(5, FILES)).toBe(FILES[0][1]);
    expect(stageMessage(6, FILES)).toBe(FILES[1][1]);
    expect(stageMessage(17, FILES)).toBe(FILES[1][1]);
    expect(stageMessage(18, FILES)).toBe(FILES[2][1]);
  });

  it("holds the last message rather than running out of things to say", () => {
    expect(stageMessage(600, FILES)).toBe(FILES[2][1]);
  });

  it("survives a single stage", () => {
    expect(stageMessage(99, [[0, "Checking…"]])).toBe("Checking…");
  });
});
