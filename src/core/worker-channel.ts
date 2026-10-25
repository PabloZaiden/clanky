import { posix, win32 } from "node:path";
import type { WorkerReleaseChannel } from "@/shared/worker-update";
import { DomainError } from "../domain/domain-error";
import type { CommandExecutor } from "./command-executor";

export function getWorkerChannelPath(
  root: string,
  pathStyle: "posix" | "win32" = process.platform === "win32" ? "win32" : "posix",
): string {
  return (pathStyle === "win32" ? win32 : posix).join(root, "update-channel");
}

export function parseWorkerChannel(raw: string): WorkerReleaseChannel {
  const channel = raw.trim();
  if (channel === "stable" || channel === "latest") return channel;
  throw new DomainError("worker_release_channel_invalid", "The saved worker channel must be stable or latest.");
}

export async function writeWorkerChannel(
  executor: CommandExecutor,
  filePath: string,
  channel: WorkerReleaseChannel,
): Promise<void> {
  const staged = `${filePath}.pending-${crypto.randomUUID()}`;
  let operationError: unknown;
  try {
    if (!await executor.writeFile(staged, `${channel}\n`)) {
      throw new DomainError("worker_release_channel_save_failed", "Cannot stage the worker release channel.");
    }
    const result = await executor.movePath(staged, filePath, { overwrite: true });
    if (!result.success) {
      throw new DomainError("worker_release_channel_save_failed", "Cannot save the worker release channel.");
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      if (await executor.fileExists(staged)
        && !await executor.deletePath(staged, { kind: "file", recursive: false })) {
        throw new Error("Cannot delete the staged channel file.");
      }
    } catch (error) {
      throw new DomainError("worker_release_channel_save_failed", "Cannot remove the staged worker release channel.", {
        cause: operationError === undefined ? error : new AggregateError([operationError, error]),
      });
    }
  }
}
