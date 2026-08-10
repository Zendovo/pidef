import type { ToolId } from "./tools";

export type DependencyInfo = {
  name: string;
  command: string;
  path: string | null;
  available: boolean;
  optional: boolean;
  source: "bundled" | "system" | "unavailable";
};

export type DependencySet = {
  qpdf: DependencyInfo;
  ghostscript: DependencyInfo;
  pdfRenderer: DependencyInfo;
  libreoffice: DependencyInfo;
};

export type OperationOptions = {
  tool: ToolId;
  requires: string[];
  unavailableReason: string | null;
};

export type JobResult = {
  id: string;
  outputs: string[];
  warnings: string[];
  inputBytes: number | null;
  outputBytes: number | null;
};

export type JobState = {
  id: string;
  tool: ToolId;
  title: string;
  status: "running" | "complete" | "failed";
  message: string;
  result?: JobResult;
};

export type PdfPreviewPage = {
  pageNumber: number;
  width: number;
  height: number;
  dataUrl: string;
};

export type PdfPreview = {
  pageCount: number;
  pages: PdfPreviewPage[];
};
