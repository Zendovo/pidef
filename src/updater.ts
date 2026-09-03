import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { isTauriRuntime } from "./runtime";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "downloading"
  | "upToDate"
  | "available"
  | "installing"
  | "error";

export type UpdateState = {
  status: UpdateStatus;
  version: string | null;
  message: string | null;
};

let pendingUpdate: Update | null = null;

export async function checkForUpdates(): Promise<UpdateState> {
  if (!isTauriRuntime()) {
    return { status: "error", version: null, message: "Updates are available in the desktop app." };
  }

  try {
    pendingUpdate = null;
    const update = await check();
    if (!update) {
      return { status: "upToDate", version: null, message: null };
    }

    pendingUpdate = update;
    return {
      status: "available",
      version: update.version,
      message: update.body?.trim() || null,
    };
  } catch (error) {
    return { status: "error", version: null, message: humanizeUpdateError(error) };
  }
}

export async function installPendingUpdate(): Promise<UpdateState> {
  if (!pendingUpdate) {
    return { status: "idle", version: null, message: null };
  }

  try {
    await pendingUpdate.downloadAndInstall();
    await relaunch();
    return { status: "installing", version: pendingUpdate.version, message: null };
  } catch (error) {
    return { status: "error", version: null, message: humanizeUpdateError(error) };
  }
}

function humanizeUpdateError(error: unknown) {
  const raw = String(error);
  if (raw.includes("404") || raw.toLowerCase().includes("not found")) {
    return "No published release was found for this channel yet.";
  }
  if (raw.toLowerCase().includes("network")) {
    return "Could not reach the update server. Check your connection.";
  }
  return "Update check failed. Try again later.";
}
