// Main-thread client for the job engine worker.

import type { JobResult } from "../types";
import {
  collectInputPaths,
  type EngineRequestMessage,
  type EngineResponseMessage,
  type WebJobRequest,
  type WebJobResponse,
} from "./protocol";
import { getFileBytes, registerFile } from "./registry";

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<
  number,
  { resolve: (value: WebJobResponse) => void; reject: (error: Error) => void }
>();

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<EngineResponseMessage>) => {
      const message = event.data;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.type === "result") {
        entry.resolve(message.result);
      } else {
        entry.reject(new Error(message.error));
      }
    };
    worker.onerror = (event) => {
      for (const entry of pending.values()) {
        entry.reject(new Error(event.message || "The processing engine crashed"));
      }
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

export async function executeWebJob(request: WebJobRequest): Promise<JobResult> {
  const files: Record<string, Uint8Array> = {};
  for (const path of collectInputPaths(request.operation)) {
    const bytes = getFileBytes(path);
    if (!bytes) {
      throw new Error(
        "A selected file is no longer available in this session. Add it again.",
      );
    }
    files[path] = bytes;
  }

  sequence += 1;
  const id = sequence;
  const response = await new Promise<WebJobResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const message: EngineRequestMessage = { type: "execute", id, request, files };
    ensureWorker().postMessage(message);
  });

  const outputs = response.outputs.map((output) =>
    registerFile(output.name, output.bytes),
  );

  return {
    id: request.id,
    outputs,
    warnings: response.warnings,
    inputBytes: response.inputBytes,
    outputBytes: response.outputBytes,
  };
}
