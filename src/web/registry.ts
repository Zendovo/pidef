// In-memory file registry for the web build. Browser files get synthetic
// paths shaped like `/pidef/<id>/<name>` so the shared UI's path-based
// helpers (basename, extension) keep working unchanged.

export type StoredFile = {
  name: string;
  bytes: Uint8Array;
};

const files = new Map<string, StoredFile>();

export function registerFile(name: string, bytes: Uint8Array): string {
  const path = `/pidef/${crypto.randomUUID()}/${name}`;
  files.set(path, { name, bytes });
  return path;
}

export async function registerBrowserFiles(fileList: File[]): Promise<string[]> {
  const paths: string[] = [];
  for (const file of fileList) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    paths.push(registerFile(file.name, bytes));
  }
  return paths;
}

export function getFileBytes(path: string): Uint8Array | undefined {
  return files.get(path)?.bytes;
}

export function getFileSize(path: string): number | undefined {
  return files.get(path)?.bytes.byteLength;
}
