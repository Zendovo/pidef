import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { DependencyInfo, DependencySet, OperationOptions } from "./types";
import { tools, type ToolId } from "./tools";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauriRuntime = () => Boolean(window.__TAURI_INTERNALS__);

export async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime()) {
    return tauriInvoke<T>(command, args);
  }

  if (command === "get_dependencies") {
    return previewDependencies() as T;
  }

  if (command === "get_operation_options") {
    return previewOperationOptions() as T;
  }

  if (command === "set_appearance") {
    return undefined as T;
  }

  if (command === "get_pdf_preview") {
    return previewPdfPreview() as T;
  }

  throw new Error(`${command} is available in the Tauri desktop runtime`);
}

function previewPdfPreview() {
  return {
    pageCount: 6,
    pages: Array.from({ length: 6 }, (_, index) => ({
      pageNumber: index + 1,
      width: 180,
      height: 236,
      dataUrl: `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="236" viewBox="0 0 180 236"><rect width="180" height="236" rx="10" fill="#f8fafc"/><rect x="22" y="28" width="136" height="18" rx="4" fill="#cbd5e1"/><rect x="22" y="62" width="108" height="10" rx="3" fill="#e2e8f0"/><rect x="22" y="82" width="126" height="10" rx="3" fill="#e2e8f0"/><rect x="22" y="112" width="136" height="62" rx="7" fill="#dbeafe"/><text x="90" y="208" text-anchor="middle" font-family="system-ui" font-size="18" fill="#64748b">${index + 1}</text></svg>`,
      )}`,
    })),
  };
}

function previewDependencies(): DependencySet {
  return {
    qpdf: previewDependency("qpdf", "/Applications/Pidef.app/Contents/Resources/bin/qpdf"),
    ghostscript: previewDependency("Ghostscript", "/usr/local/bin/gs", "system"),
    pdfRenderer: previewDependency("PDFium", "/Applications/Pidef.app/Contents/Resources/bin/pdfium"),
    libreoffice: previewDependency("LibreOffice", "/Applications/LibreOffice.app"),
  };
}

function previewDependency(
  name: string,
  command: string,
  source: DependencyInfo["source"] = "bundled",
): DependencyInfo {
  return {
    name,
    command,
    path: command,
    available: true,
    optional: false,
    source,
  };
}

function previewOperationOptions(): OperationOptions[] {
  return tools.map((tool) => ({
    tool: tool.id as ToolId,
    requires: tool.id === "jpgToPdf" ? [] : ["preview runtime"],
    unavailableReason:
      tool.id === "compressPdf"
        ? "Compression is a planned in-house feature and is intentionally disabled for now"
        : null,
  }));
}
