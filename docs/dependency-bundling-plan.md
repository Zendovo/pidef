# Dependency Bundling Plan

## Goal

Ship Local PDF Tool as a consumer desktop app that works out of the box for core PDF workflows. Users should not need Homebrew, package managers, shell setup, or command-line knowledge.

## Distribution Strategy

- Bundle the core PDF engines inside the app package.
- Resolve bundled tools from Tauri resources before checking system `PATH`.
- Keep system detection only as a developer fallback, not as the normal user path.
- Keep Office conversion optional because bundling LibreOffice would make the base installer too large.

## V1 Engine Decisions

| Capability | Engine | Bundle by default | Notes |
| --- | --- | --- | --- |
| Merge PDF | qpdf | Yes | Apache 2.0, small, reliable. |
| Split PDF | qpdf | Yes | Use bundled binary. |
| Organize PDF | qpdf | Yes | Page selection/reorder remains command backed initially. |
| Unlock PDF | qpdf | Yes | Only with user-provided password. |
| Protect PDF | qpdf | Yes | Use qpdf encryption flags. |
| PDF preview/thumbnails | PDFium | Yes | Bundled renderer. |
| PDF to JPG | PDFium | Yes | Implemented through Rust PDFium binding. |
| JPG to PDF | In-house Rust | Yes | Already implemented without external engine. |
| Word to PDF | LibreOffice | No | Optional engine/add-on. |
| PPT to PDF | LibreOffice | No | Optional engine/add-on. |
| Compress PDF | TODO | No | Needs product and technical research. |

## Size Expectations

Current macOS `.app` is about 8.7 MB.

Estimated compressed impact:

- qpdf: low single-digit MB if packaged as a native binary plus required shared libraries.
- PDFium: roughly 6-15 MB per architecture depending on release format and whether a universal binary is used.
- Core app with qpdf + PDFium: likely 20-50 MB compressed.
- LibreOffice: roughly 291 MB installer download, with a much larger installed footprint.
- Ghostscript: skip; size is around 60 MB in package form and licensing is not a good default fit.

## Licensing Position

- qpdf is acceptable to bundle under Apache 2.0.
- PDFium is acceptable as the rendering engine; include license notices for the binary distribution.
- Poppler should not be part of the distribution path because GPL creates product licensing constraints.
- Ghostscript should not be bundled unless the project intentionally complies with AGPL or obtains a commercial Artifex license.
- LibreOffice can be optional, but the app must include proper notices if a managed add-on/download flow is added.

## Implementation Plan

1. Add a `resources/bin/<platform>/<arch>/` layout for bundled engines. Started with `src-tauri/resources/bin`.
2. Update dependency detection to prefer Tauri resource paths before system paths. Done in the Tauri command layer and core dependency detector.
3. Replace the current `pdftoppm` PDF-to-JPG implementation with PDFium. Done for PDF-to-JPG export.
4. Add a build-time verification script that fails packaging if required bundled engines are missing.
5. Add a runtime diagnostics panel showing whether each engine is bundled, detected externally, optional, or unavailable.
6. Keep LibreOffice conversion disabled by default unless a local LibreOffice install or future managed add-on is detected.

## Compression TODO

Compression needs a separate design pass before implementation.

Research questions:

- How much size reduction can qpdf-only optimization provide across real-world PDFs?
- Can PDFium expose enough image metadata/extraction for a high-quality image downsample pipeline?
- Should aggressive compression rebuild image-heavy documents with our Rust PDF writer?
- Which quality presets map cleanly to user expectations: small, balanced, high quality, custom?
- How do we preserve text/searchability, metadata, outlines, annotations, and forms?

Until this is resolved, v1 compression should either be marked experimental or limited to safe qpdf structural optimization.

## Acceptance Criteria

- A fresh user can install and run the app without Homebrew or command-line setup.
- Merge, split, organize, unlock, protect, preview, PDF-to-JPG, and JPG-to-PDF work with bundled resources.
- Word/PPT tools clearly explain that Office conversion requires an optional LibreOffice engine.
- The app never tells consumer users to install developer package managers.
- Build output includes required third-party license notices.
