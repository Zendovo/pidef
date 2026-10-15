import { describe, expect, it } from "vitest";
import { tools } from "./tools";

describe("tool dashboard", () => {
  it("contains every v1 tool", () => {
    expect(tools.map((tool) => tool.id)).toEqual([
      "mergePdf",
      "splitPdf",
      "organizePdf",
      "compressPdf",
      "pdfToJpg",
      "jpgToPdf",
      "unlockPdf",
      "protectPdf",
    ]);
  });
});
