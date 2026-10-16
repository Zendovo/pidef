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

export async function renderWebImageThumbnail(request: {
  path: string;
  width?: number;
}): Promise<string> {
  const bytes = getFileBytes(request.path);
  if (!bytes) {
    throw new Error("File is no longer available in this session");
  }
  const width = Math.min(640, Math.max(48, request.width ?? 160));
  const blob = new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
  const bitmap = await createImageBitmap(blob);
  const scale = width / Math.max(1, bitmap.width);
  const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
  const targetHeight = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Canvas 2D is not available");
  }
  context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.72);
}
