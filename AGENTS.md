# Agent Handoff

## Project

Pidef is a local-first desktop PDF utility built with Tauri 2, Vite, React, TypeScript, and Rust. The product goal is to provide a local version of common iLovePDF-style workflows across macOS, Windows, and Linux while keeping the app lightweight, open source, and permissively licensed.

The durable operation layer should stay in Rust under `crates/pdf_tool_core` so future CLI or MCP integrations can reuse the same job APIs. Tauri should remain a thin adapter over that core.

## Current Architecture

- `src/`: React/TypeScript frontend.
- `src/styles.css`: main app styling.
- `src-tauri/`: Tauri shell, native commands, packaging configuration, and bundled engine resources.
- `crates/pdf_tool_core/`: operation models, validation, dependency detection, PDF/image operations, preview/rendering orchestration.
- `scripts/`: release/build helpers for bundled engines.
- `docs/`: release/dependency notes and screenshots.

## Product Direction

The user wants a practical desktop tool, not a developer utility. Avoid asking for typed input paths. Use native file pickers, drag and drop, Save As dialogs, previews, and clear completion states.

Core V1 operations:

- Merge PDF
- Split PDF
- Organize PDF
- Compress PDF
- PDF to JPG
- JPG to PDF
- Unlock PDF
- Protect PDF

Office conversion (Word/PPT to PDF) was cut to keep the bundle lean; the
LibreOffice detection/conversion code was removed entirely.

## Current Feature State

- Merge/split/organize/protect/unlock use bundled or detected `qpdf`.
- PDF previews and PDF-to-JPG use bundled or detected PDFium.
- JPG-to-PDF is implemented in Rust.
- Organize UI has thumbnails plus reorder, rotate, delete, and duplicate interactions.
- Outputs are generated into a temp location, then users choose where to save via Save As.
- History/recent files exist locally in the app UI.
- Compression is still planned/disabled.

## Recent UX Decisions

- Home screen is an editorial Command Center: EB Garamond (bundled) display type with Inter UI type, warm Editorial Air (light) / Nocturne Editorial (dark) palettes from the Stitch "Modern PDF Workspace Redesign" project, atmospheric gradient orbs, a hero drop card with pill CTA, and 3-column tinted tool plates with per-tool badges. Tool accents were remapped to match the Stitch screens.
- Sidebar stays visible on startup.
- Sidebar has a Home tab above a `TOOLS` separator.
- Jobs were renamed/reworked toward History; avoid showing technical temp paths.
- Only the Pidef brand and main operation/page headings should use serif italic styling.
- Home tool cards are neutral plates with per-tool tinted icon chips and uppercase accent badges; hover tints the border, lifts the card, and accents the arrow. The home drop plate is a surface card with a pill CTA, and tool drop areas displace their existing gradient on hover.
- Light and dark contrast have been actively tuned; keep checking both themes visually.

## Current Worktree State

There is an uncommitted change in `src/styles.css` from the latest light-mode polish pass. It improves:

- Settings page segmented theme control contrast in light mode.
- Command Center operation card brightness, borders, hover states, and text contrast in light mode.

Before starting larger work, inspect and commit or adjust that change.

## Storage Cleanup Note

The repo was cleaned because the machine was running low on storage:

- `target` was removed via `cargo clean`.
- `dist` was removed.
- `.engine-cache` was removed.

This means future release packaging may require regenerating engines with `npm run prepare:engines`.

## Licensing Direction

The project currently uses MIT in workspace metadata. The user wants Pidef to remain open source and permissive.

Avoid bundling Ghostscript unless the licensing strategy changes or a commercial Artifex license is obtained. The preferred compression path is currently:

1. Keep Pidef MIT/permissive.
2. Implement qpdf-based compression first.
3. Consider custom JPEG/image optimization later.
4. Do not require users to install Ghostscript as the main UX.

Useful compression notes:

- qpdf can do structural optimization, object streams, stream recompression, and some image optimization depending on version/options.
- qpdf does not do broad deduplication of duplicate resources/images/fonts.
- A custom permissive compressor could start with qpdf structural rewrite plus JPEG-only recompression/downsampling for `/DCTDecode` image XObjects.
- For V1 custom compression, skip PNG-like `/FlateDecode` image streams, masks, soft masks, indexed color spaces, JPX, JBIG2, and CCITT to avoid corrupting visuals.

## Recommended Next Steps

1. Review and commit the current `src/styles.css` light-mode polish.
2. Implement compression V1 using qpdf-only presets:
   - Safe: structural rewrite/object streams/recompression.
   - Balanced: safe plus conservative image optimization where qpdf supports it.
   - Small: stronger image optimization with honest quality wording.
   - Report original size, output size, and percent reduction.
3. Add a real `LICENSE` and `THIRD_PARTY_NOTICES.md`.
4. Add an in-app About/Licenses view before any release.
5. Recreate bundled engine cache and verify release packaging.
6. Build a small fixture suite for real PDFs, including encrypted, image-heavy, rotated, scanned, and text-heavy files.

## Web Build

Pidef also runs fully client-side in the browser from the same repo and UI:

- `crates/pdf_tool_core_wasm` (wasm-bindgen) exports the custom algorithms
  (JPG-to-PDF, QDF image optimizer) and the qpdf argument/spec builders, so
  CLI semantics stay defined once in Rust. Rebuild with `npm run build:wasm`
  (wasm-pack); the generated package is committed under `src/generated/`.
- `src/web/` holds the browser engine: `engine.worker.ts` runs jobs with
  qpdf wasm (`@neslinesli93/qpdf-wasm`) + the core wasm + PDFium wasm
  (`@embedpdf/pdfium`); previews render on the main thread via `pdfium.ts`.
- `src/platform.ts` abstracts dialogs, file drops, and output saving
  (Tauri dialog/save_output on desktop; file input, File System Access API
  with download fallback in the browser). Browser files live in an in-memory
  registry (`src/web/registry.ts`) with synthetic `/pidef/<id>/<name>` paths.
- Recent files are hidden on web (no durable file handles).
- `npm run dev` + a browser exercises the web runtime; `npm run e2e:web`
  (needs `npm run dev` or `npm run preview` running) drives merge, compress,
  split, and save flows through Playwright and fails on console errors.

## Common Commands

```sh
npm install
npm run tauri dev
npm run build
npm test
cargo check --manifest-path src-tauri/Cargo.toml
npm run prepare:engines
npm run package:release
```

After the storage cleanup, expect `npm run prepare:engines` to be needed before release builds that depend on bundled qpdf/PDFium assets.

## Working Preferences

- Keep UI dense, quiet, and functional.
- Prefer native desktop interactions over text instructions.
- Do not expose debug/runtime details unless tucked behind an info affordance.
- Do not show temp output paths to users.
- Keep changes scoped and avoid unrelated refactors.
- Use qpdf/PDFium bundled resources where possible so users do not need Homebrew or command-line tools.
