# Local PDF Tool

A local-first desktop PDF utility built with Tauri, Vite, React, TypeScript, and Rust.

## V1 Features

- Merge PDF
- Split PDF
- Organize PDF
- Compress PDF
- PDF to JPG
- JPG to PDF
- PPT to PDF
- Word to PDF
- Unlock PDF
- Protect PDF

## Architecture

The Tauri command layer is intentionally thin. Core operation models, validation, dependency detection, and conversion orchestration live in `crates/pdf_tool_core` so the same code can later be reused by a CLI or MCP server.

## Local Development

Install JavaScript dependencies, then run the app:

```sh
npm install
npm run tauri dev
```

Build a standalone desktop app for your current platform:

```sh
npm run tauri build -- --bundles app
```

On macOS, the app is written to `target/release/bundle/macos/Local PDF Tool.app`. A raw executable is also available at `target/release/local-pdf-tool`.

Open the `.app` bundle for normal desktop behavior:

```sh
open "target/release/bundle/macos/Local PDF Tool.app"
```

Running `target/release/local-pdf-tool` directly launches it as a command-line executable, which can keep a terminal window attached.

To build platform installers/packages, run:

```sh
npm run tauri build
```

That creates the platform's default bundles under `target/release/bundle`. On this machine, the app bundle build succeeds; the optional DMG wrapper may need a normal non-sandboxed macOS packaging environment.

Core PDF operations expect local engines on `PATH`:

- `qpdf` for merge, split, organize, unlock, and protect.
- `gs` or `ghostscript` for compression.
- `pdftoppm` for PDF to JPG rendering in this scaffold.
- `soffice` or `libreoffice` for Word/PPT to PDF.

LibreOffice is optional. Word/PPT conversion is disabled in the UI when it is not detected.

On macOS with Homebrew:

```sh
brew install qpdf ghostscript poppler libreoffice
```

The desktop app checks normal shell `PATH` plus common macOS locations such as `/opt/homebrew/bin`, `/usr/local/bin`, and `/Applications/LibreOffice.app/Contents/MacOS`.
