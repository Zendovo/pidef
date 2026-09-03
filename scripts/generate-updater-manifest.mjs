import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// Generates the Tauri updater manifest (latest.json) from a directory that
// contains the signed updater artifacts produced by `tauri build` with
// createUpdaterArtifacts enabled:
//   macOS:   <Name>.app.tar.gz + .sig
//   Windows: <Name>_<ver>_x64-setup.exe + .sig  (NSIS)
//
// Usage:
//   node scripts/generate-updater-manifest.mjs \
//     --artifacts ./release-artifacts \
//     --version 0.2.0 \
//     --download-base "https://github.com/Zendovo/pidef/releases/download/v0.2.0" \
//     [--notes "Release notes"] [--out ./latest.json]

const args = parseArgs(process.argv.slice(2));
const artifactsDir = resolve(requireArg(args, "artifacts"));
const version = requireArg(args, "version");
const downloadBase = requireArg(args, "download-base").replace(/\/$/, "");
const notes = args.notes || `Pidef ${version}`;
const outFile = resolve(args.out || join(artifactsDir, "latest.json"));

const files = listFiles(artifactsDir);

const platforms = {};

for (const [platformKey, matcher] of [
  ["darwin-aarch64", (name) => name.endsWith(".app.tar.gz") && name.includes("aarch64")],
  ["darwin-x86_64", (name) => name.endsWith(".app.tar.gz") && name.includes("x86_64")],
  [
    "windows-x86_64",
    (name) => name.endsWith("x64-setup.exe") && !name.endsWith(".zip"),
  ],
]) {
  const artifact = files.find(matcher);
  if (!artifact) {
    console.warn(`No updater artifact found for ${platformKey}; skipping.`);
    continue;
  }

  const signatureFile = files.find((name) => name === `${artifact}.sig`);
  if (!signatureFile) {
    throw new Error(`Missing signature file for ${artifact}`);
  }

  platforms[platformKey] = {
    signature: readFileSync(join(artifactsDir, signatureFile), "utf8").trim(),
    url: `${downloadBase}/${artifact}`,
  };
}

if (Object.keys(platforms).length === 0) {
  throw new Error(`No updater artifacts found in ${artifactsDir}`);
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

const { writeFileSync } = await import("node:fs");
writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${outFile} with platforms: ${Object.keys(platforms).join(", ")}`);

function listFiles(rootDir) {
  const found = [];
  for (const entry of readdirSync(rootDir)) {
    const path = join(rootDir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...listFiles(path).map((nested) => join(entry, nested)));
    } else {
      found.push(entry);
    }
  }
  return found;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) {
      if (value.includes("=")) {
        const [key, rest] = value.slice(2).split("=");
        parsed[key] = rest;
      } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
        parsed[value.slice(2)] = argv[index + 1];
        index += 1;
      } else {
        parsed[value.slice(2)] = true;
      }
    }
  }
  return parsed;
}

function requireArg(args, key) {
  if (!args[key]) {
    throw new Error(`Missing required --${key} argument`);
  }
  return args[key];
}
