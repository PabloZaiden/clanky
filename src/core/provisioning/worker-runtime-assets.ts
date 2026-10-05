/**
 * Publishes durable worker assets through the selected host, with rollback.
 */

import { posix as pathPosix } from "node:path";
import type { AgentSettings } from "@/shared";
import { DomainError } from "../../domain/domain-error";
import type { CommandExecutor } from "../command-executor";
import { buildRuntimeInstaller, buildWorkerLauncher, type WorkerPaths } from "./worker-assets";

export async function prepareWorkerRuntimeAssets(
  executor: CommandExecutor,
  { paths, runtime, install = false }: { paths: WorkerPaths; runtime: AgentSettings; install?: boolean },
): Promise<{ rollback: () => Promise<void> }> {
  const assets = [
    { path: pathPosix.join(paths.hostRoot, "install-runtime.sh"), content: buildRuntimeInstaller() },
    { path: pathPosix.join(paths.hostRoot, "runtime.json"), content: JSON.stringify(runtime) },
    { path: pathPosix.join(paths.hostRoot, "launcher.sh"), content: buildWorkerLauncher(paths) },
  ];
  const suffix = `.pending-${crypto.randomUUID()}`;
  const previous = await Promise.all(assets.map(async (asset) => {
    if (!await executor.fileExists(asset.path)) return null;
    const content = await executor.readFile(asset.path);
    if (content === null) throw new DomainError("workspace_runtime_assets_failed", "Cannot read the previous workspace runtime configuration.");
    return content;
  }));
  const rollback = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (let index = 0; index < assets.length; index++) {
      const asset = assets[index]!;
      try {
        const original = previous[index];
        if (original === null) {
          if (await executor.fileExists(asset.path) && !await executor.deletePath(asset.path, { kind: "file", recursive: false })) {
            throw new Error("Failed to remove new runtime assets");
          }
        } else {
          await atomicWrite(executor, { path: asset.path, content: original!, suffix });
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Workspace runtime asset rollback failed.");
  };
  let published = false;
  let operationError: unknown;
  try {
    for (const asset of assets) {
      if (!await executor.writeFile(`${asset.path}${suffix}`, asset.content)) {
        throw new DomainError("workspace_runtime_assets_failed", "Cannot stage workspace runtime assets.");
      }
    }
    if (install) {
      const result = await executor.exec("sh", [`${assets[0]!.path}${suffix}`, `${assets[1]!.path}${suffix}`], {
        timeout: 300_000, longRunning: true, logFailures: false,
      });
      if (!result.success) {
        throw new DomainError("workspace_runtime_install_failed", "The selected workspace runtime could not be installed.", {
          details: { adapter: runtime.adapter, diagnostic: result.stderr.trim().slice(-4000) },
        });
      }
    }
    for (const asset of assets) {
      published = true;
      const moved = await executor.movePath(`${asset.path}${suffix}`, asset.path, { overwrite: true });
      if (!moved.success) throw new DomainError("workspace_runtime_assets_failed", "Cannot publish workspace runtime assets.");
    }
    return { rollback };
  } catch (error) {
    operationError = error;
    if (published) {
      try { await rollback(); }
      catch (rollbackError) {
        operationError = new DomainError("workspace_runtime_rollback_failed", "Workspace runtime publication and rollback failed.", {
          cause: new AggregateError([error, rollbackError]),
        });
        throw operationError;
      }
    }
    throw error;
  } finally {
    const results = await Promise.allSettled(assets.map(async (asset) => {
      const staged = `${asset.path}${suffix}`;
      if (await executor.fileExists(staged) && !await executor.deletePath(staged, { kind: "file", recursive: false })) {
        throw new Error("Cannot remove a staged workspace runtime asset");
      }
    }));
    const errors: unknown[] = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) {
      throw new DomainError("workspace_runtime_assets_failed", "Cannot clean up staged workspace runtime assets.", {
        cause: new AggregateError(operationError === undefined ? errors : [operationError, ...errors]),
      });
    }
  }
}

async function atomicWrite(executor: CommandExecutor, { path, content, suffix }: { path: string; content: string; suffix: string }): Promise<void> {
  if (!await executor.writeFile(`${path}${suffix}`, content)) throw new Error("Cannot stage runtime asset rollback");
  const moved = await executor.movePath(`${path}${suffix}`, path, { overwrite: true });
  if (!moved.success) throw new Error("Cannot restore runtime assets");
}
