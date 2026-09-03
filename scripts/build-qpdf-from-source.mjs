import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = join(root, ".engine-cache");
const binRoot = join(root, "src-tauri", "resources", "bin");
const qpdfVersion = process.env.QPDF_VERSION || "12.3.2";

function requestedTarget() {
  const index = process.argv.indexOf("--target");
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const flag = process.argv.find((value) => value.startsWith("--target="));
  return flag ? flag.slice("--target=".length) : undefined;
}

const hostTarget = targetKey(process.platform, process.arch);
const target = requestedTarget() || hostTarget;

if (!hostTarget) {
  throw new Error(`Unsupported qpdf build host: ${process.platform}-${process.arch}`);
}
if (!target) {
  throw new Error(`Unsupported qpdf build target: ${process.platform}-${process.arch}`);
}

const crossDarwinTarget =
  target !== hostTarget && process.platform === "darwin" && target.startsWith("macos-");

await requireCommand("cmake");
await requireCommand("c++");

const sourceArchive = join(cacheRoot, `qpdf-${qpdfVersion}.tar.gz`);
const sourceDir = join(cacheRoot, `qpdf-${qpdfVersion}`);
const buildDir = join(cacheRoot, `qpdf-build-${target}`);
const targetDir = join(binRoot, target);

await mkdir(cacheRoot, { recursive: true });
await mkdir(targetDir, { recursive: true });

if (!(await exists(sourceArchive))) {
  const url = `https://github.com/qpdf/qpdf/releases/download/v${qpdfVersion}/qpdf-${qpdfVersion}.tar.gz`;
  console.log(`Downloading ${url}`);
  await download(url, sourceArchive);
}

await rm(sourceDir, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });
await mkdir(buildDir, { recursive: true });

await run("tar", ["-xzf", sourceArchive, "-C", cacheRoot]);

const cmakeArgs = [
  "-S",
  sourceDir,
  "-B",
  buildDir,
  "-DCMAKE_BUILD_TYPE=MinSizeRel",
  "-DCMAKE_FIND_LIBRARY_SUFFIXES=.a;.dylib",
  "-DBUILD_SHARED_LIBS=OFF",
  "-DBUILD_STATIC_LIBS=ON",
  "-DUSE_IMPLICIT_CRYPTO=OFF",
  "-DALLOW_CRYPTO_NATIVE=ON",
  "-DREQUIRE_CRYPTO_NATIVE=ON",
  "-DREQUIRE_CRYPTO_GNUTLS=OFF",
  "-DREQUIRE_CRYPTO_OPENSSL=OFF",
  "-DDEFAULT_CRYPTO=native",
  "-DBUILD_DOC=OFF",
  "-DINSTALL_EXAMPLES=OFF",
  "-DINSTALL_MANUAL=OFF",
  "-DINSTALL_PKGCONFIG=OFF",
  "-DINSTALL_CMAKE_PACKAGE=OFF",
];

if (crossDarwinTarget) {
  const arch = target === "macos-x86_64" ? "x86_64" : "arm64";
  cmakeArgs.push(`-DCMAKE_OSX_ARCHITECTURES=${arch}`);
  cmakeArgs.push(`-DCMAKE_SYSTEM_PROCESSOR=${arch}`);
  cmakeArgs.push(`-DCMAKE_OSX_DEPLOYMENT_TARGET=${process.env.MACOSX_DEPLOYMENT_TARGET || "10.15"}`);
}

await run("cmake", cmakeArgs);
await run("cmake", ["--build", buildDir, "--config", "MinSizeRel", "--target", "qpdf", "--parallel"]);

const builtQpdf = await findFirst(buildDir, qpdfExecutableName(target));
if (!builtQpdf) {
  throw new Error(`Could not find built qpdf executable under ${installDir}`);
}

const destination = join(targetDir, qpdfExecutableName(target));
await cp(builtQpdf, destination);
await chmod(destination, 0o755);
await bundleMacosDynamicLibraries(destination, targetDir);

console.log(`Bundled qpdf for ${target}: ${destination}`);

async function requireCommand(command) {
  try {
    await run(command, ["--version"], { quiet: true });
  } catch {
    throw new Error(
      `Missing required build command: ${command}. Install it in CI or your release-prep machine before running npm run build:qpdf.`,
    );
  }
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

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: options.quiet ? "ignore" : "inherit" });
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
    await access(path);
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

function qpdfExecutableName(targetKeyValue) {
  return targetKeyValue.startsWith("windows") ? "qpdf.exe" : "qpdf";
}

async function bundleMacosDynamicLibraries(executable, targetDir) {
  if (process.platform !== "darwin") return;

  const output = await capture("otool", ["-L", executable]);
  const dylibs = output
    .split("\n")
    .map((line) => line.trim().split(" ")[0])
    .filter((path) => path.startsWith("/opt/homebrew/") || path.startsWith("/usr/local/"));

  for (const dylib of dylibs) {
    const name = dylib.split("/").pop();
    const destination = join(targetDir, name);
    await rm(destination, { force: true });
    await copyFile(await realpath(dylib), destination);
    await chmod(destination, 0o755);
    await run("install_name_tool", ["-change", dylib, `@executable_path/${name}`, executable]);
  }
}

function capture(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} exited with code ${code}: ${stderr}`));
    });
  });
}
