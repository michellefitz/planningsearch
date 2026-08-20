import { describe, expect, it } from "vitest";
import { documentLoadingShell } from "../../api/_documents/loading-page.mjs";

/**
 * The page a document link lands on while the document is still coming.
 *
 * A council document is fetched from their portal and, for the older scans,
 * decoded and re-assembled before a byte can be sent — seconds in which the
 * browser has nothing to paint and shows a blank white tab. This renders
 * immediately and then navigates itself to the document; a browser keeps
 * showing the current page until the next one starts painting, so the spinner
 * stays up for exactly as long as the wait.
 */
const HREF = "/api/applications/86270/files/13?open=1";

describe("the document waiting page", () => {
  const html = documentLoadingShell(HREF);

  it("says what it is waiting for, before anything else has loaded", () => {
    expect(html).toContain("Fetching the document from the council");
    // No stylesheet, script or image to fetch first — one response, painted.
    expect(html).not.toMatch(/<link\b|src=/);
  });

  it("moves the wording on rather than repeating itself", () => {
    expect(html).toContain("Still fetching");
    expect(html).toContain("Still going.");
    // Six seconds, then fifteen: long enough that a normal wait never sees
    // them, short enough that a stuck one does.
    expect(html).toContain(",6000)");
    expect(html).toContain(",15000)");
  });

  /** `replace`, so Back returns to the application rather than to a spinner
   *  that would only redirect forward again. */
  it("replaces itself rather than stacking a history entry", () => {
    expect(html).toContain("location.replace(");
    expect(html).not.toContain("location.assign(");
    expect(html).toContain(JSON.stringify(HREF));
  });

  it("leaves a way through without JavaScript", () => {
    expect(html).toMatch(/<noscript><p><a href="[^"]*">Open the document<\/a>/);
  });

  it("escapes the href it puts in the markup", () => {
    const nasty = documentLoadingShell('/f?a=1&b="x"');
    expect(nasty).toContain('href="/f?a=1&amp;b=&quot;x&quot;"');
  });

  it("renders in either theme rather than assuming a white page", () => {
    expect(html).toContain("color-scheme:light dark");
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain("prefers-reduced-motion:reduce");
  });

  it("stays small enough to arrive in one packet", () => {
    expect(Buffer.byteLength(html)).toBeLessThan(4000);
  });
});
