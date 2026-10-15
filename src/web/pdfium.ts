// PDFium wasm wrapper: renders PDF pages to RGBA buffers.
//
// The exported `renderPdfPages` works in both the main thread (previews) and
// the engine worker (PDF to JPG) because it only produces raw byte buffers.
// Canvas conversion lives with the callers (`rgbaToDataUrl`, `rgbaToJpegBytes`).

import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import pdfiumWasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";

const FPDFBitmap_BGRA = 4;
const FPDF_ANNOT = 0x01;
const FPDF_LCD_TEXT = 0x02;

export type RenderedPage = {
  pageNumber: number;
  width: number;
  height: number;
  rgba: Uint8Array;
};

let pdfiumPromise: Promise<WrappedPdfiumModule> | null = null;

export function loadPdfium(wasmBinaryOverride?: ArrayBuffer): Promise<WrappedPdfiumModule> {
  if (wasmBinaryOverride) {
    return initPdfium(wasmBinaryOverride);
  }
  if (!pdfiumPromise) {
    pdfiumPromise = (async () => {
      const response = await fetch(pdfiumWasmUrl);
      if (!response.ok) {
        throw new Error(`Could not load the PDF engine (${response.status})`);
      }
      return initPdfium(await response.arrayBuffer());
    })();
  }
  return pdfiumPromise;
}

async function initPdfium(wasmBinary: ArrayBuffer): Promise<WrappedPdfiumModule> {
  const module = await init({ wasmBinary });
  const maybeInit = (
    module as unknown as { PDFiumExt_Init?: () => void }
  ).PDFiumExt_Init;
  maybeInit?.();
  callOptional(module, "FPDF_InitLibrary");
  return module;
}

function heapU8(module: WrappedPdfiumModule): Uint8Array {
  return (module.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
}

// Some pdfium builds expose extension helpers that the wrapped typings do not
// name; access them dynamically and ignore absence.
function callOptional(module: WrappedPdfiumModule, name: string) {
  const target = module as unknown as Record<string, unknown>;
  const fn = target[name];
  if (typeof fn === "function") {
    (fn as () => void).call(target);
  }
}

export async function renderPdfPages(
  input: Uint8Array,
  options: {
    targetWidth?: number;
    dpi?: number;
    maxPages?: number;
    pageNumbers?: number[];
    password?: string;
  } = {},
): Promise<{ pageCount: number; rendered: RenderedPage[] }> {
  const module = await loadPdfium();
  const pdfium = module.pdfium;
  const heap = () => heapU8(module);

  const inputPtr = pdfium.wasmExports.malloc(input.byteLength || 1);
  heap().set(input, inputPtr);
  let documentHandle = 0;
  try {
    documentHandle = module.FPDF_LoadMemDocument64(
      inputPtr,
      input.byteLength,
      options.password ?? "",
    );
    if (!documentHandle) {
      throw new Error("Could not open the PDF (it may be encrypted or damaged)");
    }

    const pageCount = module.FPDF_GetPageCount(documentHandle);
    const wantedPages: number[] = [];
    if (options.pageNumbers && options.pageNumbers.length > 0) {
      for (const pageNumber of options.pageNumbers) {
        if (pageNumber >= 1 && pageNumber <= pageCount) {
          wantedPages.push(pageNumber);
        }
      }
    } else {
      const limit = options.maxPages
        ? Math.min(options.maxPages, pageCount)
        : pageCount;
      for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
        wantedPages.push(pageNumber);
      }
    }

    const rendered: RenderedPage[] = [];
    for (const pageNumber of wantedPages) {
      const page = module.FPDF_LoadPage(documentHandle, pageNumber - 1);
      if (!page) continue;
      try {
        const widthPt = module.FPDF_GetPageWidthF(page);
        const heightPt = module.FPDF_GetPageHeightF(page);
        const scale = options.targetWidth
          ? options.targetWidth / Math.max(widthPt, 1)
          : options.dpi
            ? options.dpi / 72
            : 1;
        const width = Math.max(1, Math.round(widthPt * scale));
        const height = Math.max(1, Math.round(heightPt * scale));
        const stride = width * 4;
        const size = stride * height;
        const bufferPtr = pdfium.wasmExports.malloc(size);
        try {
          const bitmap = module.FPDFBitmap_CreateEx(
            width,
            height,
            FPDFBitmap_BGRA,
            bufferPtr,
            stride,
          );
          if (!bitmap) {
            throw new Error("Could not allocate a render bitmap");
          }
          module.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
          module.FPDF_RenderPageBitmap(
            bitmap,
            page,
            0,
            0,
            width,
            height,
            0,
            FPDF_ANNOT | FPDF_LCD_TEXT,
          );
          const bgra = heap().subarray(bufferPtr, bufferPtr + size);
          const rgba = new Uint8Array(size);
          for (let index = 0; index < size; index += 4) {
            rgba[index] = bgra[index + 2];
            rgba[index + 1] = bgra[index + 1];
            rgba[index + 2] = bgra[index];
            rgba[index + 3] = 255;
          }
          module.FPDFBitmap_Destroy(bitmap);
          rendered.push({ pageNumber, width, height, rgba });
        } finally {
          pdfium.wasmExports.free(bufferPtr);
        }
      } finally {
        module.FPDF_ClosePage(page);
      }
    }

    return { pageCount, rendered };
  } finally {
    if (documentHandle) {
      module.FPDF_CloseDocument(documentHandle);
    }
    pdfium.wasmExports.free(inputPtr);
  }
}

// ---------------------------------------------------------------------------
// Canvas conversions
// ---------------------------------------------------------------------------

export function rgbaToDataUrl(
  rgba: Uint8Array,
  width: number,
  height: number,
  quality: number,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D is not available");
  }
  const image = context.createImageData(width, height);
  image.data.set(rgba);
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/jpeg", quality);
}

export async function rgbaToJpegBytes(
  rgba: Uint8Array,
  width: number,
  height: number,
  quality: number,
): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("OffscreenCanvas 2D is not available");
  }
  const image = context.createImageData(width, height);
  image.data.set(rgba);
  context.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Uint8Array(await blob.arrayBuffer());
}
