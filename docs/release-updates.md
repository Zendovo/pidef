# Release, Packaging, and Updates

## Artifacts

| Target | Built by | Method |
| --- | --- | --- |
| macOS Apple Silicon (`macos-aarch64`) | GitHub Actions (`macos-latest`) or any Apple Silicon Mac | Native build, qpdf compiled from source |
| macOS Intel (`macos-x86_64`) | GitHub Actions (`macos-latest`) | Cross-compiled from an arm64 runner (no current Intel runners); qpdf via `CMAKE_OSX_ARCHITECTURES`, Swift via `SWIFT_TARGET` |
| Windows x64 (`windows-x86_64`) | GitHub Actions (`windows-latest`) | Native build; qpdf and PDFium fetched from official prebuilt releases |
| Linux x64 (`linux-x86_64`) | Not wired yet | Same pattern as Windows (official qpdf + PDFium prebuilts exist) |

Local builds on this machine:

```sh
npm run prepare:engines   # stages qpdf + PDFium for the host target
npm run package:release   # verify:engines + tauri build (dmg/app on macOS)
```

Cross-target engine staging (used by CI, also usable locally):

```sh
npm run build:qpdf -- --target macos-x86_64
node scripts/prepare-bundled-engines.mjs --target=macos-x86_64
node scripts/verify-bundled-engines.mjs --target=macos-x86_64
```

## CI workflow (`.github/workflows/release.yml`)

- `workflow_dispatch` or pushing a `v*` tag builds all three targets and uploads artifacts.
- On a tag push, a `publish` job downloads the artifacts, generates `latest.json`
  (`scripts/generate-updater-manifest.mjs`), and creates/updates a GitHub release.
- Each build job stages engines for its target first (`prepare-bundled-engines` +
  `build:qpdf` on macOS), then runs `tauri build --target <rust-target>` with
  `createUpdaterArtifacts` enabled, producing `.sig`-signed updater artifacts.

Required repository secret:

- `TAURI_SIGNING_PRIVATE_KEY` — contents of the updater signing key file.
  The local copy lives at `~/.tauri/pidef-updater.key` (never commit it).
  The matching public key is embedded in `src-tauri/tauri.conf.json`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — set to the key password, or to an
  empty value if the key was generated without one. Leaving it unset makes
  Tauri try to prompt for a password, which fails on CI.

Optional secrets (enable signed/notarized builds when present):

- `APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` — macOS Developer ID signing and
  notarization.
- Windows Authenticode: not wired yet; unsigned installers trigger SmartScreen
  warnings until a certificate is added.

## Update delivery

Pidef uses `tauri-plugin-updater`:

- Endpoint: `https://github.com/Zendovo/pidef/releases/latest/download/latest.json`
  (set in `tauri.conf.json > plugins.updater`).
- Release flow: tag `v0.2.1` → CI builds all targets → `publish` job uploads
  installers plus signed updater artifacts and `latest.json` to the release.
- In-app flow: Pidef checks the endpoint on launch (quiet) and from
  Settings → Updates. Downloading an update verifies the minisign signature
  against the embedded public key, then restarts into the new version.

Release checklist:

1. Update the version in `src-tauri/tauri.conf.json`, `package.json`, and the
   workspace `Cargo.toml` (they must match the tag).
2. Commit and tag: `git tag v0.2.1 && git push origin main --tags`.
3. Watch the Release workflow; the publish job attaches artifacts and
   `latest.json`.
4. Verify: the GitHub release shows `latest.json` and `.sig` files, and the
   installed app picks the update from Settings → Updates.

Key management:

- Back up `~/.tauri/pidef-updater.key` (password-protected is recommended;
  regenerate with `npm run tauri signer generate` and update
  `plugins.updater.pubkey` if you ever rotate it).
- Losing the private key means users cannot be updated to new builds; they
  would have to reinstall manually.

## Signing status (honest current state)

- **macOS artifacts are unsigned/notarized only if the Apple secrets are
  configured.** Unsigned apps require right-click → Open on first launch, and
  the macOS updater generally refuses to replace an unsigned bundle, so
  automatic updates on macOS need Developer ID signing + notarization.
- **Windows artifacts are unsigned** until an Authenticode certificate is
  configured; the updater still works because Tauri validates its own
  minisign signature on the installer.
