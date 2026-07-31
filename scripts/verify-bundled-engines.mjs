import { access, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = targetKey(process.platform, process.arch);

if (!target) {
  throw new Error(`Unsupported engine bundle target: ${process.platform}-${process.arch}`);
}

const targetDir = join(root, "src-tauri", "resources", "bin", target);
const required = [qpdfExecutableName(target), pdfiumLibraryName(target)];
const missing = [];

for (const file of required) {
  const path = join(targetDir, file);
  if (!(await exists(path))) missing.push(path);
}

if (missing.length > 0) {
  console.error("Missing bundled engine files:");
  for (const file of missing) console.error(`- ${file}`);
  console.error("\nRun `npm run prepare:engines` or provide QPDF_BIN=/path/to/qpdf for macOS release prep.");
  process.exit(1);
}

console.log(`Bundled engines are present for ${target}`);

async function exists(path) {
  try {
    await access(path);
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function targetKey(nodePlatform, nodeArch) {
  if (nodePlatform === "darwin" && nodeArch === "arm64") return "macos-aarch64";
  if (nodePlatform === "darwin" && nodeArch === "x64") return "macos-x86_64";
  if (nodePlatform === "win32" && nodeArch === "x64") return "windows-x86_64";
  if (nodePlatform === "linux" && nodeArch === "x64") return "linux-x86_64";
  return null;
}

function pdfiumLibraryName(targetKeyValue) {
  if (targetKeyValue.startsWith("windows")) return "pdfium.dll";
  if (targetKeyValue.startsWith("macos")) return "libpdfium.dylib";
  return "libpdfium.so";
}

function qpdfExecutableName(targetKeyValue) {
  return targetKeyValue.startsWith("windows") ? "qpdf.exe" : "qpdf";
}
