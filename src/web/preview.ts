// Main-thread PDF preview rendering (pdfium wasm).

import type { PdfPreview } from "../types";
import { renderPdfPages, rgbaToDataUrl } from "./pdfium";
import { getFileBytes } from "./registry";

export async function renderWebPdfPreview(request: {
  input: string;
  maxPages?: number;
  pages?: number[];
  width?: number;
  quality?: number;
}): Promise<PdfPreview> {
  const bytes = getFileBytes(request.input);
  if (!bytes) {
    throw new Error("File is no longer available in this session");
  }

  const { pageCount, rendered } = await renderPdfPages(bytes, {
    targetWidth: Math.max(48, request.width ?? 180),
    maxPages: request.pages && request.pages.length > 0 ? undefined : request.maxPages,
    pageNumbers: request.pages,
  });
  const quality = Math.min(100, Math.max(1, request.quality ?? 72)) / 100;

  return {
    pageCount,
    pages: rendered.map((page) => ({
      pageNumber: page.pageNumber,
      width: page.width,
      height: page.height,
      dataUrl: rgbaToDataUrl(page.rgba, page.width, page.height, quality),
    })),
  };
}
