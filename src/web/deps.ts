// Dependency reporting for the web runtime. The PDF engine and renderer are
// part of the application bundle, so they are always available.

import { tools } from "../tools";
import type { DependencyInfo, DependencySet, OperationOptions } from "../types";

function bundled(name: string, command: string): DependencyInfo {
  return {
    name,
    command,
    path: command,
    available: true,
    optional: false,
    source: "bundled",
  };
}

export function webDependencies(): DependencySet {
  return {
    qpdf: bundled("qpdf", "qpdf (WebAssembly)"),
    pdfRenderer: bundled("PDFium", "pdfium (WebAssembly)"),
  };
}

export function webOperationOptions(): OperationOptions[] {
  return tools.map((tool) => ({
    tool: tool.id,
    requires: [],
    unavailableReason: null,
  }));
}
