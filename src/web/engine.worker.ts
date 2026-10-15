// Job engine worker: executes operations with qpdf wasm + the Rust core wasm
// + PDFium wasm, mirroring the argument construction and pipeline order of
// `crates/pdf_tool_core/src/operations.rs`.

import createQpdfModule from "@neslinesli93/qpdf-wasm";
import qpdfWasmUrl from "@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url";
import {
  compress_arguments_for,
  jpg_to_pdf,
  loadCoreWasm,
  optimize_qdf,
  organize_page_specs,
  profile_image_settings,
  protect_arguments_for,
  qpdf_ranges,
} from "./coreWasm";
import { renderPdfPages, rgbaToJpegBytes } from "./pdfium";
import type {
  EngineRequestMessage,
  EngineResponseMessage,
  WebJobResponse,
  WebOperation,
} from "./protocol";

type QpdfRun = {
  args: string[];
  files: Record<string, Uint8Array>;
  outputs: string[];
};

let runCounter = 0;

async function runQpdf(
  run: QpdfRun,
): Promise<{ outputs: Record<string, Uint8Array>; warnings: string[] }> {
  const logs: string[] = [];
  const createModule = createQpdfModule as unknown as (
    overrides: Record<string, unknown>,
  ) => Promise<QpdfModule>;
  // This emscripten build resolves its wasm through locateFile; point it at
  // the bundled asset instead of the worker-relative path.
  const module = await createModule({
    locateFile: (file: string) => (file.endsWith(".wasm") ? qpdfWasmUrl : file),
    print: (line: string) => logs.push(line),
    printErr: (line: string) => logs.push(line),
  });

  for (const [path, bytes] of Object.entries(run.files)) {
    try {
      ensureDirectory(module, path);
      module.FS.writeFile(path, bytes);
    } catch (error) {
      const detail = error as { name?: string; message?: string };
      throw new Error(
        `Could not stage ${path}: ${detail?.message ?? detail?.name ?? "unknown error"}`,
      );
    }
  }
  for (const output of run.outputs) {
    ensureDirectory(module, output);
  }

  let exitCode = 0;
  try {
    exitCode = module.callMain(run.args);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (typeof status === "number") {
      exitCode = status;
    } else {
      let detail: string;
      try {
        detail =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : JSON.stringify(error) ?? String(error);
      } catch {
        detail = String(error);
      }
      const tail = logs.slice(-8).join("\n");
      throw new Error(`PDF engine failed: ${detail}${tail ? `\n${tail}` : ""}`);
    }
  }

  const outputs: Record<string, Uint8Array> = {};
  for (const path of run.outputs) {
    try {
      outputs[path] = module.FS.readFile(path);
    } catch {
      // Missing outputs are handled by the caller.
    }
  }

  const produced = run.outputs.every((path) => path in outputs);
  if (!produced) {
    const details = logs.filter((line) => line.trim()).join("\n");
    throw new Error(details || `PDF engine exited with code ${exitCode}`);
  }

  const warnings =
    exitCode === 3
      ? logs
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];
  return { outputs, warnings };
}

type QpdfModule = {
  FS: {
    mkdir: (path: string) => void;
    writeFile: (path: string, data: Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
  };
  callMain: (args: string[]) => number;
};

// This emscripten build ships only the core FS calls (no mkdirTree), so
// directories are created segment by segment.
function ensureDirectory(module: QpdfModule, filePath: string) {
  const segments = filePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .slice(0, -1);
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    try {
      module.FS.mkdir(current);
    } catch {
      // Already exists; writeFile will surface real problems.
    }
  }
}

function scratchPath(name: string): string {
  runCounter += 1;
  return `/work/${runCounter}/${name}`;
}

async function executeJob(
  request: { id: string; operation: WebOperation },
  files: Record<string, Uint8Array>,
): Promise<WebJobResponse> {
  await loadCoreWasm();
  const inputBytes = sumBytes(files);

  switch (request.operation.kind) {
    case "mergePdf": {
      const { inputs } = request.operation;
      if (inputs.length === 0) {
        throw new Error("At least one input file is required");
      }
      const output = scratchPath("merged.pdf");
      const args = ["--empty", "--pages"];
      for (const input of inputs) {
        args.push(input, "1-z");
      }
      args.push("--", output);
      const run = await runQpdf({ args, files, outputs: [output] });
      return singleOutput("merged.pdf", run.outputs[output], run.warnings, inputBytes);
    }

    case "splitPdf": {
      const { input, ranges, outputPattern } = request.operation;
      const groups = qpdf_ranges(ranges);
      const outputs: { name: string; bytes: Uint8Array }[] = [];
      const warnings: string[] = [];
      for (let index = 0; index < groups.length; index += 1) {
        const range = groups[index];
        const name = outputPattern
          .replace("{n}", String(index + 1))
          .replace("{range}", range);
        const output = scratchPath(name);
        const run = await runQpdf({
          args: ["--empty", "--pages", input, range, "--", output],
          files,
          outputs: [output],
        });
        warnings.push(...run.warnings);
        outputs.push({ name, bytes: run.outputs[output] });
      }
      return {
        outputs,
        warnings,
        inputBytes,
        outputBytes: outputs.reduce((total, item) => total + item.bytes.length, 0),
      };
    }

    case "organizePdf": {
      const { input, pages } = request.operation;
      if (pages.length === 0) {
        throw new Error("At least one page is required");
      }
      const specs = organize_page_specs(
        new Uint32Array(pages.map((page) => page.sourcePage)),
        new Int16Array(pages.map((page) => page.rotateDegrees)),
      );
      const output = scratchPath("organized.pdf");
      const args = ["--empty", "--pages"];
      for (const spec of specs) {
        args.push(input, spec);
      }
      args.push("--", output);
      const run = await runQpdf({ args, files, outputs: [output] });
      return singleOutput("organized.pdf", run.outputs[output], run.warnings, inputBytes);
    }

    case "compressPdf": {
      const { input, profile } = request.operation;
      return compressJob(request.id, input, profile, files, inputBytes);
    }

    case "pdfToJpg": {
      const { input, dpi, firstPage, lastPage, quality } = request.operation;
      const bytes = requireFile(files, input);
      const rendered = await renderPdfPages(bytes, { dpi });
      const first = Math.max(1, firstPage ?? 1);
      const last = Math.min(lastPage ?? rendered.pageCount, rendered.pageCount);
      if (first > last) {
        throw new Error("invalid PDF page range");
      }
      const outputs: { name: string; bytes: Uint8Array }[] = [];
      for (const page of rendered.rendered) {
        if (page.pageNumber < first || page.pageNumber > last) continue;
        const name = `page-${String(page.pageNumber).padStart(4, "0")}.jpg`;
        const jpeg = await rgbaToJpegBytes(
          page.rgba,
          page.width,
          page.height,
          Math.min(100, Math.max(1, quality)) / 100,
        );
        outputs.push({ name, bytes: jpeg });
      }
      return {
        outputs,
        warnings: [],
        inputBytes,
        outputBytes: outputs.reduce((total, item) => total + item.bytes.length, 0),
      };
    }

    case "jpgToPdf": {
      const { inputs, pageSize, fitMode, marginMm } = request.operation;
      if (inputs.length === 0) {
        throw new Error("At least one input file is required");
      }
      const images = inputs.map((input) => requireFile(files, input));
      const pdf = jpg_to_pdf(images, pageSize, fitMode, marginMm);
      return singleOutput("images.pdf", new Uint8Array(pdf), [], inputBytes);
    }

    case "unlockPdf": {
      const { input, password } = request.operation;
      const output = scratchPath("unlocked.pdf");
      try {
        const run = await runQpdf({
          args: [`--password=${password}`, "--decrypt", input, output],
          files,
          outputs: [output],
        });
        return singleOutput("unlocked.pdf", run.outputs[output], run.warnings, inputBytes);
      } catch (error) {
        if (String(error).toLowerCase().includes("password")) {
          throw new Error("invalid password or encrypted file could not be opened");
        }
        throw error;
      }
    }

    case "protectPdf": {
      const { input, userPassword, ownerPassword, permissions } = request.operation;
      const output = scratchPath("protected.pdf");
      const encryptArgs = protect_arguments_for(
        userPassword,
        ownerPassword,
        permissions.allowPrinting,
        permissions.allowCopying,
        permissions.allowModification,
      );
      const run = await runQpdf({
        args: [...encryptArgs, "--", input, output],
        files,
        outputs: [output],
      });
      return singleOutput("protected.pdf", run.outputs[output], run.warnings, inputBytes);
    }

    case "pptToPdf":
    case "wordToPdf": {
      throw new Error("Office conversion is only available in the desktop app");
    }
  }
}

async function compressJob(
  _id: string,
  input: string,
  profile: "safe" | "balanced" | "small",
  files: Record<string, Uint8Array>,
  inputBytes: number | null,
): Promise<WebJobResponse> {
  const warnings: string[] = [];
  const staged = scratchPath("optimize-source.pdf");
  await runQpdf({
    args: [
      "--qdf",
      "--object-streams=disable",
      "--decode-level=generalized",
      "--",
      input,
      staged,
    ],
    files,
    outputs: [staged],
  }).then((stageRun) => {
    Object.assign(files, stageRun.outputs);
  });

  let stagedBytes = requireFile(files, staged);
  const settings = profile_image_settings(profile);
  if (settings) {
    try {
      const optimized = optimize_qdf(
        stagedBytes,
        settings.target_dpi,
        settings.trigger_dpi,
        settings.jpeg_quality,
      );
      stagedBytes = new Uint8Array(optimized.bytes);
      if (optimized.changed > 0) {
        warnings.push(
          `Downsampled ${optimized.changed} image${
            optimized.changed === 1 ? "" : "s"
          } to about ${Math.round(settings.target_dpi)} DPI`,
        );
      }
    } catch (error) {
      warnings.push(`Image optimization skipped: ${error}`);
    }
    files[staged] = stagedBytes;
  }

  const presetArgs = compress_arguments_for(profile);
  const fullOutput = scratchPath("candidate-preset.pdf");
  const fullRun = await runQpdf({
    args: [...presetArgs, "--", staged, fullOutput],
    files,
    outputs: [fullOutput],
  });
  warnings.push(...fullRun.warnings);

  let best = fullRun.outputs[fullOutput];
  const original = requireFile(files, input);

  if (inputBytes !== null && best.byteLength >= inputBytes) {
    const conservativeOutput = scratchPath("candidate-conservative.pdf");
    try {
      const conservativeArgs = compress_arguments_for("safe");
      const conservativeRun = await runQpdf({
        args: [...conservativeArgs, "--", input, conservativeOutput],
        files,
        outputs: [conservativeOutput],
      });
      const conservative = conservativeRun.outputs[conservativeOutput];
      if (conservative.byteLength < inputBytes) {
        best = conservative;
        warnings.push(...conservativeRun.warnings);
      }
    } catch (error) {
      if (!String(error).toLowerCase().includes("password")) {
        warnings.push(`Structural fallback skipped: ${error}`);
      }
    }
  }

  if (inputBytes !== null && best.byteLength >= inputBytes) {
    warnings.push(
      "This PDF is already well optimized; the original was kept unchanged.",
    );
    best = original;
  }

  return {
    outputs: [{ name: "compressed.pdf", bytes: best }],
    warnings,
    inputBytes,
    outputBytes: best.byteLength,
  };
}

function singleOutput(
  name: string,
  bytes: Uint8Array,
  warnings: string[],
  inputBytes: number | null,
): WebJobResponse {
  return {
    outputs: [{ name, bytes }],
    warnings,
    inputBytes,
    outputBytes: bytes.byteLength,
  };
}

function requireFile(files: Record<string, Uint8Array>, path: string): Uint8Array {
  const bytes = files[path];
  if (!bytes) {
    throw new Error("A required file is no longer available. Add it again.");
  }
  return bytes;
}

function sumBytes(files: Record<string, Uint8Array>): number | null {
  const values = Object.values(files);
  if (values.length === 0) return null;
  return values.reduce((total, bytes) => total + bytes.byteLength, 0);
}

self.onmessage = async (event: MessageEvent<EngineRequestMessage>) => {
  const message = event.data;
  if (message.type !== "execute") return;

  try {
    const result = await executeJob(message.request, message.files);
    const response: EngineResponseMessage = { type: "result", id: message.id, result };
    self.postMessage(response);
  } catch (error) {
    const response: EngineResponseMessage = {
      type: "error",
      id: message.id,
      error: String((error as Error)?.message ?? error),
    };
    self.postMessage(response);
  }
};
