import {
  Archive,
  FileArchive,
  FileImage,
  FileKey,
  FileLock,
  Files,
  Layers3,
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
  | "unlockPdf"
  | "protectPdf";

export type ToolDefinition = {
  id: ToolId;
  title: string;
  description: string;
  accent: string;
  badge: string;
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
    profile: "safe" | "balanced" | "small";
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
  profile: "balanced" as const,
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
    accent: "#3b82f6",
    needsMultipleInputs: true,
    outputHint: "/Users/hima/Desktop/merged.pdf",
    badge: "Lossless stitching",
    defaults: { ...commonDefaults, output: "" },
  },
  {
    id: "splitPdf",
    title: "Split PDF",
    description: "Extract page ranges into separate PDFs.",
    icon: Scissors,
    accent: "#8b5cf6",
    needsMultipleInputs: false,
    outputHint: "/Users/hima/Desktop/split-output-folder",
    badge: "Instant page splitter",
    defaults: { ...commonDefaults, ranges: "1, 2-3" },
  },
  {
    id: "organizePdf",
    title: "Organize PDF",
    description: "Reorder, duplicate, rotate, or remove pages.",
    icon: Layers3,
    accent: "#14b8a6",
    needsMultipleInputs: false,
    outputHint: "/Users/hima/Desktop/organized.pdf",
    badge: "Visual page ordering",
    defaults: { ...commonDefaults, ranges: "1,2,3" },
  },
  {
    id: "compressPdf",
    title: "Compress PDF",
    description: "Shrink file size with lossless or image-smart presets.",
    icon: Archive,
    accent: "#f59e0b",
    needsMultipleInputs: false,
    outputHint: "/Users/hima/Desktop/compressed.pdf",
    badge: "Smart image downsizing",
    defaults: commonDefaults,
  },
  {
    id: "pdfToJpg",
    title: "PDF to JPG",
    description: "Render PDF pages into high-quality JPG images.",
    icon: FileImage,
    accent: "#f43f5e",
    needsMultipleInputs: false,
    outputHint: "/Users/hima/Desktop/pdf-images",
    badge: "Export at any DPI",
    defaults: commonDefaults,
  },
  {
    id: "jpgToPdf",
    title: "JPG to PDF",
    description: "Turn ordered JPG images into one PDF.",
    icon: FileArchive,
    accent: "#06b6d4",
    needsMultipleInputs: true,
    outputHint: "/Users/hima/Desktop/images.pdf",
    badge: "Build PDFs from photos",
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
    badge: "Password-verified decrypt",
    defaults: commonDefaults,
  },
  {
    id: "protectPdf",
    title: "Protect PDF",
    description: "Encrypt a PDF and set basic permissions.",
    icon: FileLock,
    accent: "#6366f1",
    needsMultipleInputs: false,
    outputHint: "/Users/hima/Desktop/protected.pdf",
    badge: "256-bit encryption",
    defaults: commonDefaults,
  },
];

export const toolById = Object.fromEntries(tools.map((tool) => [tool.id, tool])) as Record<
  ToolId,
  ToolDefinition
>;
