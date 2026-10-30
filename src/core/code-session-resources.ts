/**
 * Durable ownership and execution-host cleanup for private VS Code resources.
 */

import { posix as paths } from "node:path";
import type { CodePreviewCleanup } from "@/shared/preview";
import type { CommandExecutor } from "./command-executor";
import { DomainError } from "../domain/domain-error";
import { CODE_PROCESS_CLEANUP } from "./code-process-supervision";

type OwnedCodeSession = Extract<CodePreviewCleanup, { kind: "owned" }>;

function requireOwnership(executor: CommandExecutor, id: string, ownership: CodePreviewCleanup): OwnedCodeSession {
  if (ownership.kind !== "owned") {
    throw new DomainError("code_cleanup_failed", "The saved VS Code resource ownership is invalid; cleanup requires intervention.");
  }
  if (executor.pathStyle !== ownership.pathStyle || !/^[a-f0-9-]{36}$/.test(id)
    || !paths.isAbsolute(ownership.temporaryDirectory)
    || paths.normalize(ownership.temporaryDirectory) !== ownership.temporaryDirectory
    || paths.basename(ownership.temporaryDirectory) !== `clanky-code-${id}`) {
    throw new DomainError("code_cleanup_failed", "VS Code resource ownership does not match this execution host.");
  }
  return ownership;
}

export async function prepareCodeSession(options: {
  executor: CommandExecutor;
  id: string;
  directory: string;
  persist: (ownership: CodePreviewCleanup) => Promise<void>;
}): Promise<OwnedCodeSession> {
  const { executor, id, directory } = options;
  const temporaryRoot = await executor.getEnvironmentVariable("TMPDIR") || "/tmp";
  if (!paths.isAbsolute(temporaryRoot)) throw new DomainError("code_start_failed", "The host temporary directory must be absolute.");
  const ownership = requireOwnership(executor, id, {
    kind: "owned", directory, pathStyle: executor.pathStyle,
    temporaryDirectory: paths.join(temporaryRoot, `clanky-code-${id}`),
  });
  // Commit the reservation before any directory, credential or process exists.
  await options.persist(ownership);
  const result = await executor.exec("sh", [
        "-c", 'umask 077; mkdir -- "$CLANKY_CODE_DIRECTORY" && printf "%s" "$CLANKY_CODE_OWNER" > "$CLANKY_CODE_DIRECTORY/owner"',
      ], { cwd: directory, timeout: 5_000, logFailures: false, env: { CLANKY_CODE_DIRECTORY: ownership.temporaryDirectory, CLANKY_CODE_OWNER: id } });
  if (!result.success) throw new DomainError("code_start_failed", "Unable to create a private VS Code session directory.");
  return ownership;
}

export async function cleanupCodeSession(options: {
  executor: CommandExecutor;
  id: string;
  ownership: CodePreviewCleanup;
}): Promise<void> {
  const { executor, id } = options;
  const ownership = requireOwnership(executor, id, options.ownership);
  const directory = ownership.temporaryDirectory;
  if (await executor.directoryExists(directory)) {
    const owner = await executor.readFile(paths.join(directory, "owner"));
    if (owner !== id) {
      // A crash between mkdir and writing ownership can leave only an empty
      // reservation. rmdir cannot remove unrelated/nonempty resources.
      if (owner === null) {
        const removed = await executor.exec("rmdir", ["--", directory], { timeout: 5_000, logFailures: false });
        if (removed.success) return;
      }
      throw new DomainError("code_cleanup_failed", "VS Code temporary-directory ownership could not be confirmed.");
    }
  }
  const result = await executor.exec("bash", ["-c", CODE_PROCESS_CLEANUP, "clanky-code-cleanup", paths.join(directory, "process")], {
    timeout: 5_000, logFailures: false,
  });
  if (!result.success) throw new DomainError("code_cleanup_failed", "VS Code process-tree cleanup could not be confirmed.");
  if (await executor.directoryExists(directory)
    && !(await executor.deletePath(directory, { kind: "directory", recursive: true }))) {
    throw new DomainError("code_cleanup_failed", "Unable to remove the VS Code session directory.");
  }
}
