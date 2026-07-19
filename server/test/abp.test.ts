import { describe, expect, it } from "vitest";
import {
  abpCaseNumber,
  abpCaseUrl,
  cleanDocTitle,
  parseAppealCase,
  parseAppealCaseDocuments,
  parseAppealCaseFields,
  pickAppealDocument,
} from "../src/abp.js";

describe("abpCaseNumber", () => {
  it("extracts the six-digit case number from every reference form", () => {
    expect(abpCaseNumber("ABP-319506-23")).toBe("319506");
    expect(abpCaseNumber("ACP-301000-21")).toBe("301000");
    expect(abpCaseNumber("PL29N.301702")).toBe("301702");
    expect(abpCaseNumber("TR17.310928")).toBe("310928");
    expect(abpCaseNumber("319506")).toBe("319506");
  });

  it("returns null when there is no six-digit group", () => {
    expect(abpCaseNumber("")).toBeNull();
    expect(abpCaseNumber(null)).toBeNull();
    expect(abpCaseNumber(undefined)).toBeNull();
    expect(abpCaseNumber("ABP-1234-05")).toBeNull();
  });
});

describe("abpCaseUrl", () => {
  it("builds a case-file deep link", () => {
    expect(abpCaseUrl("ABP-319506-23")).toBe(
      "https://www.pleanala.ie/en-ie/case/319506"
    );
    expect(abpCaseUrl("PL29N.301702")).toBe(
      "https://www.pleanala.ie/en-ie/case/301702"
    );
  });

  it("returns null for unparseable or missing references", () => {
    expect(abpCaseUrl(null)).toBeNull();
    expect(abpCaseUrl("no digits here")).toBeNull();
  });
});

describe("parseAppealCaseFields", () => {
  it("extracts label/value pairs from a definition list", () => {
    const html = `
      <dl>
        <dt>Case Reference</dt><dd>ABP-319506-23</dd>
        <dt>Local Authority</dt><dd>Fingal County Council</dd>
        <dt>Decision</dt><dd>Grant Permission</dd>
      </dl>`;
    const fields = parseAppealCaseFields(html);
    expect(fields).toEqual([
      { label: "Case Reference", value: "ABP-319506-23" },
      { label: "Local Authority", value: "Fingal County Council" },
      { label: "Decision", value: "Grant Permission" },
    ]);
  });

  it("extracts pairs from a two-column table and labelled cards", () => {
    const table = `<table><tr><th>Status</th><td>Decided</td></tr>
      <tr><td>Decision Date</td><td>10/03/2026</td></tr></table>`;
    expect(parseAppealCaseFields(table)).toEqual([
      { label: "Status", value: "Decided" },
      { label: "Decision Date", value: "10/03/2026" },
    ]);

    const cards = `<div class="field-name">Nature of Appeal</div><div class="field-value">Third Party</div>`;
    expect(parseAppealCaseFields(cards)).toEqual([
      { label: "Nature of Appeal", value: "Third Party" },
    ]);
  });

  it("de-duplicates, trims trailing colons, and skips noise", () => {
    const html = `
      <dl>
        <dt>Decision:</dt><dd>Refuse Permission</dd>
        <dt>Decision</dt><dd>ignored duplicate</dd>
        <dt></dt><dd>orphan value</dd>
      </dl>`;
    expect(parseAppealCaseFields(html)).toEqual([
      { label: "Decision", value: "Refuse Permission" },
    ]);
  });
});

describe("parseAppealCaseDocuments", () => {
  it("collects case-documentation links and resolves relative URLs", () => {
    const base = "https://www.pleanala.ie/en-ie/case/319506";
    const html = `
      <a href="/publicaccess/Case%20Documentation/319506/Inspector%20Report.pdf">Inspector's Report</a>
      <a href="https://www.pleanala.ie/files/board-direction.pdf">Board Direction</a>
      <a href="/en-ie/home">Home</a>`;
    const docs = parseAppealCaseDocuments(html, base);
    expect(docs).toEqual([
      {
        title: "Inspector's Report",
        url: "https://www.pleanala.ie/publicaccess/Case%20Documentation/319506/Inspector%20Report.pdf",
      },
      { title: "Board Direction", url: "https://www.pleanala.ie/files/board-direction.pdf" },
    ]);
  });

  it("parseAppealCase bundles fields and documents together", () => {
    const html = `<dl><dt>Status</dt><dd>Decided</dd></dl>
      <a href="/x/report.pdf">Report</a>`;
    const out = parseAppealCase(html, "https://www.pleanala.ie/en-ie/case/1");
    expect(out.fields).toHaveLength(1);
    expect(out.documents).toHaveLength(1);
  });
});

describe("cleanDocTitle", () => {
  it("strips trailing file-format/size clutter", () => {
    expect(cleanDocTitle("Inspectors Report (320/R320138.pdf, .PDF format 285KB)")).toBe(
      "Inspectors Report"
    );
    expect(cleanDocTitle("Board Order (2 MB)")).toBe("Board Order");
  });

  it("leaves clean titles and meaningful parentheses untouched", () => {
    expect(cleanDocTitle("Board Direction")).toBe("Board Direction");
    expect(cleanDocTitle("Observation (John Murphy)")).toBe("Observation (John Murphy)");
  });

  it("applies within document parsing", () => {
    const docs = parseAppealCaseDocuments(
      `<a href="/x/r320138.pdf">Inspectors Report (320/R320138.pdf, .PDF format 285KB)</a>`,
      "https://www.pleanala.ie/en-ie/case/320138"
    );
    expect(docs[0].title).toBe("Inspectors Report");
  });
});

describe("pickAppealDocument", () => {
  it("prefers a board-order / inspector document over other PDFs", () => {
    const docs = [
      { title: "Application Form", url: "https://x/form.pdf" },
      { title: "Board Order", url: "https://x/order.pdf" },
      { title: "Observation", url: "https://x/obs.pdf" },
    ];
    expect(pickAppealDocument(docs)?.title).toBe("Board Order");
  });

  it("falls back to the first PDF and skips non-PDFs", () => {
    expect(
      pickAppealDocument([
        { title: "Scanned map", url: "https://x/map.tiff" },
        { title: "Cover", url: "https://x/cover.pdf" },
      ])?.title
    ).toBe("Cover");
    expect(pickAppealDocument([{ title: "Notes", url: "https://x/notes.tiff" }])).toBeNull();
    expect(pickAppealDocument([])).toBeNull();
  });
});
