import {
  Archive,
  FileArchive,
  FileImage,
  FileKey,
  FileLock,
  FileOutput,
  Files,
  Layers3,
  Presentation,
  Scissors,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type ToolId =
  | "mergePdf"
  | "splitPdf"
  | "organizePdf"
  | "compressPdf"
  | "pdfToJpg"
  | "jpgToPdf"
  | "pptToPdf"
  | "wordToPdf"
  | "unlockPdf"
  | "protectPdf";

export type ToolDefinition = {
  id: ToolId;
  title: string;
  description: string;
  accent: string;
  icon: LucideIcon;
  needsMultipleInputs: boolean;
  outputHint: string;
  defaults: {
    input: string;
    inputs: string;
    output: string;
    ranges: string;
    outputPattern: string;
    dpi: number;
    quality: number;
    profile: "screen" | "ebook" | "printer" | "prepress";
    pageSize: string;
    fitMode: string;
    marginMm: number;
  };
};

const commonDefaults = {
  input: "",
  inputs: "",
  output: "",
  ranges: "1",
  outputPattern: "split-{n}-{range}.pdf",
  dpi: 200,
  quality: 90,
  profile: "ebook" as const,
  pageSize: "auto",
  fitMode: "fit",
  marginMm: 0,
};

export const tools: ToolDefinition[] = [
  {
    id: "mergePdf",
    title: "Merge PDF",
    description: "Combine multiple PDFs into one ordered file.",
    icon: Files,
    accent: "#2563eb",
    needsMultipleInputs: true,
    outputHint: "/Users/hima/Desktop/merged.pdf",
    defaults: { ...commonDefaults, output: "" },
  },
  {
    id: "splitPdf",
    title: "Split PDF",
    description: "Extract page ranges into separate PDFs.",
    icon: Scissors,
    accent: "#b45309",
    needsMultipleInputs: false,
    outputHint: "/Users/hima/Desktop/split-output-folder",
    defaults: { ...commonDefaults, ranges: "1, 2-3" },
  },
  {
    id: "organizePdf",
    title: "Organize PDF",
    description: "Reorder, duplicate, rotate, or remove pages.",
    icon: Layers3,
    accent: "#047857",
    needsMultipleInputs: false,
    outputHint: "/Users/hima/Desktop/organized.pdf",
    defaults: { ...commonDefaults, ranges: "1,2,3" },
  },
  {
    id: "compressPdf",
    title: "Compress PDF",
    description: "Create a smaller PDF using quality profiles.",
    icon: Archive,
    accent: "#7c3aed",
    needsMultipleInputs: false,
    outputHint: "/Users/hima/Desktop/compressed.pdf",
    defaults: commonDefaults,
  },
  {
    id: "pdfToJpg",
    title: "PDF to JPG",
    description: "Render PDF pages into high-quality JPG images.",
    icon: FileImage,
    accent: "#db2777",
    needsMultipleInputs: false,
    outputHint: "/Users/hima/Desktop/pdf-images",
    defaults: commonDefaults,
  },
  {
    id: "jpgToPdf",
    title: "JPG to PDF",
    description: "Turn ordered JPG images into one PDF.",
    icon: FileArchive,
    accent: "#0891b2",
    needsMultipleInputs: true,
    outputHint: "/Users/hima/Desktop/images.pdf",
    defaults: commonDefaults,
  },
  {
    id: "pptToPdf",
    title: "PPT to PDF",
    description: "Convert presentations locally through LibreOffice.",
    icon: Presentation,
    accent: "#dc2626",
    needsMultipleInputs: false,
    outputHint: "/Users/hima/Desktop/slides.pdf",
    defaults: commonDefaults,
  },
  {
    id: "wordToPdf",
    title: "Word to PDF",
    description: "Convert documents locally through LibreOffice.",
    icon: FileOutput,
    accent: "#1d4ed8",
    needsMultipleInputs: false,
    outputHint: "/Users/hima/Desktop/document.pdf",
    defaults: commonDefaults,
  },
  {
    id: "unlockPdf",
    title: "Unlock PDF",
    description: "Decrypt a PDF when you know the password.",
    icon: FileKey,
    accent: "#ca8a04",
    needsMultipleInputs: false,
    outputHint: "/Users/hima/Desktop/unlocked.pdf",
    defaults: commonDefaults,
  },
  {
    id: "protectPdf",
    title: "Protect PDF",
    description: "Encrypt a PDF and set basic permissions.",
    icon: FileLock,
    accent: "#4338ca",
    needsMultipleInputs: false,
    outputHint: "/Users/hima/Desktop/protected.pdf",
    defaults: commonDefaults,
  },
];

export const toolById = Object.fromEntries(tools.map((tool) => [tool.id, tool])) as Record<
  ToolId,
  ToolDefinition
>;
