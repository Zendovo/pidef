# Bundled Engines

This directory is packaged into the Tauri app and is searched before system `PATH`.

Expected layout:

```text
resources/bin/
  manifest.json
  macos-aarch64/
    qpdf
    libpdfium.dylib
    LICENSES/
  macos-x86_64/
    qpdf
    libpdfium.dylib
    LICENSES/
  windows-x86_64/
    qpdf.exe
    pdfium.dll
    LICENSES/
  linux-x86_64/
    qpdf
    libpdfium.so
    LICENSES/
```

`qpdf` is used for structural PDF operations. `PDFium` is the bundled rendering engine for PDF-to-image export and future previews.

Do not commit downloaded engine binaries to the repository. Release builds should populate this directory before running `npm run tauri build`.

For macOS qpdf, run:

```sh
npm run build:qpdf
```

The qpdf source build requires CMake, Xcode command line tools, zlib, and libjpeg-compatible headers/libraries. The release build should run this in CI so end users never need those tools.
