export type WebOperation =
  | { kind: "mergePdf"; inputs: string[] }
  | { kind: "splitPdf"; input: string; ranges: string; outputPattern: string }
  | {
      kind: "organizePdf";
      input: string;
      pages: { sourcePage: number; rotateDegrees: number }[];
    }
  | { kind: "compressPdf"; input: string; profile: "safe" | "balanced" | "small" }
  | {
      kind: "pdfToJpg";
      input: string;
      dpi: number;
      firstPage: number | null;
      lastPage: number | null;
      quality: number;
    }
  | {
      kind: "jpgToPdf";
      inputs: string[];
      pageSize: string;
      fitMode: string;
      marginMm: number;
    }
  | { kind: "pptToPdf" | "wordToPdf"; input: string }
  | { kind: "unlockPdf"; input: string; password: string }
  | {
      kind: "protectPdf";
      input: string;
      userPassword: string;
      ownerPassword: string;
      permissions: {
        allowPrinting: boolean;
        allowCopying: boolean;
        allowModification: boolean;
      };
    };

export type WebJobRequest = {
  id: string;
  operation: WebOperation;
};

export type WebJobResponse = {
  outputs: { name: string; bytes: Uint8Array }[];
  warnings: string[];
  inputBytes: number | null;
  outputBytes: number | null;
};

export type EngineRequestMessage = {
  type: "execute";
  id: number;
  request: WebJobRequest;
  files: Record<string, Uint8Array>;
};

export type EngineResponseMessage =
  | { type: "result"; id: number; result: WebJobResponse }
  | { type: "error"; id: number; error: string };

export function collectInputPaths(operation: WebOperation): string[] {
  switch (operation.kind) {
    case "mergePdf":
      return operation.inputs;
    case "jpgToPdf":
      return operation.inputs;
    default:
      return [operation.input];
  }
}
