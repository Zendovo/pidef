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

  throw new Error(`${command} is available in the Tauri desktop runtime`);
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
