// Platform abstraction so the shared UI works in both the Tauri desktop app
// and the browser build. Dialogs, file drops, and output saving differ; the
// command surface stays identical through `invokeCommand`.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { zipSync } from "fflate";
import { invokeCommand, isTauriRuntime } from "./runtime";
import { getFileBytes, registerBrowserFiles } from "./web/registry";

export type FileFilter = { name: string; extensions: string[] };

export const platformMode: "desktop" | "web" = isTauriRuntime() ? "desktop" : "web";

export const canReopenRecentFiles = () => platformMode === "desktop";

export async function pickFiles(options: {
  title: string;
  multiple: boolean;
  filters: FileFilter[];
}): Promise<string[]> {
  if (platformMode === "desktop") {
    const picked = await open({
      title: options.title,
      multiple: options.multiple,
      filters: options.filters,
      fileAccessMode: "scoped",
    });
    if (!picked) return [];
    return Array.isArray(picked) ? picked : [picked];
  }
  return pickWebFiles(options);
}

export async function saveFileOutput(
  source: string,
  options: { title: string; defaultName: string; filters: FileFilter[] },
): Promise<string | null> {
  if (platformMode === "desktop") {
    const destination = await save({
      title: options.title,
      defaultPath: options.defaultName,
      filters: options.filters,
    });
    if (!destination) return null;
    await invokeCommand("save_output", { source, destination });
    return destination;
  }

  const bytes = getFileBytes(source);
  if (!bytes) {
    throw new Error("The output is no longer available in this session.");
  }
  return saveWebBytes(options.defaultName, bytes, options.filters);
}

export async function saveMultiOutputs(
  sources: string[],
  options: { title: string; baseName: string },
): Promise<string | null> {
  if (platformMode === "desktop") {
    const folder = await open({
      title: `${options.title} — choose a folder`,
      directory: true,
      multiple: false,
      canCreateDirectories: true,
    });
    if (!folder || Array.isArray(folder)) return null;
    for (const source of sources) {
      const name = source.split(/[\\/]/).pop() ?? "output";
      await invokeCommand("save_output", {
        source,
        destination: `${folder}/${name}`,
      });
    }
    return folder;
  }

  for (const source of sources) {
    const bytes = getFileBytes(source);
    const name = source.split(/[\\/]/).pop() ?? "output";
    if (bytes) {
      await saveWebBytes(name, bytes, []);
    }
  }
  return `${sources.length} files`;
}

export async function saveZipOutputs(
  sources: string[],
  options: { title: string; zipName: string },
): Promise<string | null> {
  if (platformMode === "desktop") {
    const destination = await save({
      title: options.title,
      defaultPath: options.zipName,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!destination) return null;
    await invokeCommand("save_outputs_zip", { sources, destination });
    return destination;
  }

  const files: Record<string, Uint8Array> = {};
  for (const source of sources) {
    const bytes = getFileBytes(source);
    if (bytes) {
      files[source.split(/[\\/]/).pop() ?? "output.pdf"] = bytes;
    }
  }
  const zipped = zipSync(files, { level: 6 });
  return saveWebBytes(options.zipName, zipped, [{ name: "ZIP", extensions: ["zip"] }]);
}

export function subscribeToFileDrop(handlers: {
  onOver: () => void;
  onLeave: () => void;
  onDrop: (paths: string[]) => void;
}): () => void {
  if (platformMode === "desktop") {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          handlers.onOver();
          return;
        }
        if (event.payload.type === "drop") {
          if (event.payload.paths.length > 0) {
            handlers.onDrop(event.payload.paths);
          }
        }
        handlers.onLeave();
      })
      .then((value) => {
        if (cancelled) {
          value();
        } else {
          unlisten = value;
        }
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }

  const onDragOver = (event: DragEvent) => {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
      handlers.onOver();
    }
  };
  const onDragLeave = (event: DragEvent) => {
    if (event.relatedTarget === null) {
      handlers.onLeave();
    }
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) {
      handlers.onLeave();
      return;
    }
    void registerBrowserFiles(files).then((paths) => {
      handlers.onDrop(paths);
      handlers.onLeave();
    });
  };
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);
  return () => {
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("dragleave", onDragLeave);
    window.removeEventListener("drop", onDrop);
  };
}

// ---------------------------------------------------------------------------
// Web helpers
// ---------------------------------------------------------------------------

function pickWebFiles(options: {
  multiple: boolean;
  filters: FileFilter[];
}): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (options.multiple) {
      input.multiple = true;
    }
    const accept = options.filters.flatMap((filter) =>
      filter.extensions.map((extension) => `.${extension}`),
    );
    if (accept.length > 0) {
      input.accept = accept.join(",");
    }
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        resolve([]);
        return;
      }
      void registerBrowserFiles(files).then(resolve);
    };
    input.click();
  });
}

async function saveWebBytes(
  defaultName: string,
  bytes: Uint8Array,
  filters: FileFilter[],
): Promise<string | null> {
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (options: {
        suggestedName?: string;
        types?: { description: string; accept: Record<string, string[]> }[];
      }) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;

  if (picker) {
    try {
      const handle = await picker({
        suggestedName: defaultName,
        types: filters.map((filter) => ({
          description: filter.name,
          accept: {
            [mimeTypeFor(filter.extensions[0])]: filter.extensions.map(
              (extension) => `.${extension}`,
            ),
          },
        })),
      });
      const writable = await handle.createWritable();
      await writable.write(new Uint8Array(bytes));
      await writable.close();
      return handle.name;
    } catch (error) {
      if ((error as DOMException)?.name === "AbortError") {
        return null;
      }
      // Fall through to a plain download for other picker failures.
    }
  }

  downloadBytes(defaultName, bytes);
  return defaultName;
}

function mimeTypeFor(extension: string): string {
  switch (extension) {
    case "pdf":
      return "application/pdf";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

function downloadBytes(name: string, bytes: Uint8Array) {
  const blob = new Blob([new Uint8Array(bytes)]);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
