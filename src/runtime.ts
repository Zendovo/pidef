import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { DependencySet, OperationOptions, PdfPreview } from "./types";
import { webDependencies, webOperationOptions } from "./web/deps";
import { executeWebJob } from "./web/engineClient";
import { renderWebPdfPreview } from "./web/preview";
import { getFileSize } from "./web/registry";
import type { WebJobRequest } from "./web/protocol";

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

  switch (command) {
    case "get_dependencies":
      return webDependencies() as T;

    case "get_operation_options":
      return webOperationOptions() as T;

    case "execute_job":
      return (await executeWebJob(
        (args as { request: WebJobRequest }).request,
      )) as T;

    case "get_pdf_preview":
      return (await renderWebPdfPreview(
        (args as {
          request: {
            input: string;
            maxPages?: number;
            pages?: number[];
            width?: number;
            quality?: number;
          };
        }).request,
      )) as T;

    case "get_file_size": {
      const size = getFileSize((args as { path: string }).path);
      if (size === undefined) {
        throw new Error("File is not available in this session");
      }
      return size as T;
    }

    case "set_appearance":
    case "set_native_sidebar_collapsed":
      return undefined as T;

    case "save_output":
      throw new Error("Output saving is handled by the platform layer");

    default:
      throw new Error(`${command} is not available in the browser runtime`);
  }
}
