# Release Packaging

Pidef packages as a Tauri desktop app with bundled PDF engines. Users should not need Homebrew, terminal setup, or system packages for core PDF workflows.

## Local Packaging

Run this for the quickest standalone app build on the current machine:

```sh
npm run prepare:engines
npm run package:app
```

The app bundle is written under `src-tauri/target/release/bundle/`.

Run this when you want Tauri to create the platform's configured installer/package targets:

```sh
npm run prepare:engines
npm run package:release
```

## Release Rules

- `npm run verify:engines` must pass before packaging.
- qpdf and PDFium are expected in `src-tauri/resources/bin/<platform>/`.
- Office conversion is intentionally not part of the release package yet.
- Compression remains a TODO until the in-house strategy is chosen.
- macOS signing/notarization, Windows signing, and Linux package signing should be added before public distribution.

## Current Platform Targets

- macOS Apple Silicon: prepared locally.
- macOS Intel: needs a matching qpdf binary and PDFium dylib.
- Windows x64: needs qpdf.exe and pdfium.dll in the Windows resource folder.
- Linux x64: needs qpdf and libpdfium.so in the Linux resource folder.
