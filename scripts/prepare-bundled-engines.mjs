import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binRoot = join(root, "src-tauri", "resources", "bin");
const cacheRoot = join(root, ".engine-cache");

const pdfiumVersion = "chromium/7881";

const platform = process.platform;
const arch = process.arch;
const target = targetKey(platform, arch);

if (!target) {
  throw new Error(`Unsupported engine bundle target: ${platform}-${arch}`);
}

await mkdir(join(binRoot, target), { recursive: true });
await preparePdfium(target);
await prepareQpdf(target);

console.log(`Prepared bundled engines for ${target}`);

async function preparePdfium(targetKeyValue) {
  const asset = pdfiumAsset(targetKeyValue);
  if (!asset) {
    console.warn(`No PDFium asset mapping for ${targetKeyValue}`);
    return;
  }

  const archive = join(cacheRoot, `${pdfiumVersion.replace("/", "-")}-${asset}`);
  await mkdir(cacheRoot, { recursive: true });

  if (!(await exists(archive))) {
    const url = `https://github.com/bblanchon/pdfium-binaries/releases/download/${encodeURIComponent(
      pdfiumVersion,
    )}/${asset}`;
    console.log(`Downloading ${url}`);
    await download(url, archive);
  }

  const extractDir = join(cacheRoot, `${pdfiumVersion.replace("/", "-")}-${asset.replace(/\.tgz$/, "")}`);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await run("tar", ["-xzf", archive, "-C", extractDir]);

  const library = await findFirst(extractDir, pdfiumLibraryName(targetKeyValue));
  if (!library) {
    throw new Error(`Could not find PDFium library in ${archive}`);
  }

  const destination = join(binRoot, targetKeyValue, pdfiumLibraryName(targetKeyValue));
  await cp(library, destination);
  await chmod(destination, 0o755);
}

async function prepareQpdf(targetKeyValue) {
  const envName = `QPDF_BIN_${targetKeyValue.toUpperCase().replaceAll("-", "_")}`;
  const qpdfSource = process.env[envName] || process.env.QPDF_BIN;

  if (qpdfSource) {
    const destination = join(binRoot, targetKeyValue, qpdfExecutableName(targetKeyValue));
    await cp(qpdfSource, destination);
    await chmod(destination, 0o755);
    return;
  }

  if (targetKeyValue === "linux-x86_64") {
    await prepareQpdfFromZip(
      targetKeyValue,
      "https://github.com/qpdf/qpdf/releases/download/v12.3.2/qpdf-12.3.2-bin-linux-x86_64.zip",
    );
    return;
  }

  if (targetKeyValue === "windows-x86_64") {
    await prepareQpdfFromZip(
      targetKeyValue,
      "https://github.com/qpdf/qpdf/releases/download/v12.3.2/qpdf-12.3.2-msvc64.zip",
    );
    return;
  }

  console.warn(
    `qpdf was not bundled for ${targetKeyValue}. Provide ${envName}=/path/to/qpdf when preparing release engines.`,
  );
}

async function prepareQpdfFromZip(targetKeyValue, url) {
  const archive = join(cacheRoot, url.split("/").pop());
  await mkdir(cacheRoot, { recursive: true });

  if (!(await exists(archive))) {
    console.log(`Downloading ${url}`);
    await download(url, archive);
  }

  const extractDir = join(cacheRoot, archive.split("/").pop().replace(/\.zip$/, ""));
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await run("unzip", ["-q", archive, "-d", extractDir]);

  const executable = await findFirst(extractDir, qpdfExecutableName(targetKeyValue));
  if (!executable) {
    throw new Error(`Could not find qpdf executable in ${archive}`);
  }

  const destination = join(binRoot, targetKeyValue, qpdfExecutableName(targetKeyValue));
  await cp(executable, destination);
  await chmod(destination, 0o755);
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  await mkdir(dirname(destination), { recursive: true });
  const hash = createHash("sha256");
  const file = createWriteStream(destination);
  const stream = new TransformStream({
    transform(chunk, controller) {
      hash.update(chunk);
      controller.enqueue(chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body.pipeThrough(stream)), file);
  console.log(`${destination} sha256=${hash.digest("hex")}`);
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function findFirst(rootDir, fileName) {
  const entries = await readdir(rootDir);
  for (const entry of entries) {
    const path = join(rootDir, entry);
    const info = await stat(path);
    if (info.isDirectory()) {
      const nested = await findFirst(path, fileName);
      if (nested) return nested;
    } else if (entry === fileName) {
      return path;
    }
  }
  return null;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
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

function pdfiumAsset(targetKeyValue) {
  return {
    "macos-aarch64": "pdfium-mac-arm64.tgz",
    "macos-x86_64": "pdfium-mac-x64.tgz",
    "windows-x86_64": "pdfium-win-x64.tgz",
    "linux-x86_64": "pdfium-linux-x64.tgz",
  }[targetKeyValue];
}

function pdfiumLibraryName(targetKeyValue) {
  if (targetKeyValue.startsWith("windows")) return "pdfium.dll";
  if (targetKeyValue.startsWith("macos")) return "libpdfium.dylib";
  return "libpdfium.so";
}

function qpdfExecutableName(targetKeyValue) {
  return targetKeyValue.startsWith("windows") ? "qpdf.exe" : "qpdf";
}
