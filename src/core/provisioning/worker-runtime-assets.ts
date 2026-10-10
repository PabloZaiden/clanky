/**
 * Publishes durable worker assets through the selected host, with rollback.
 */

import { posix as pathPosix } from "node:path";
import type { AgentSettings } from "@/shared";
import { DomainError } from "../../domain/domain-error";
import type { CommandExecutor } from "../command-executor";
import { buildRuntimeInstaller, buildWorkerLauncher, type WorkerPaths } from "./worker-assets";

function getExistingPrereleaseSelection(
  launcher: string | null | undefined,
): boolean | undefined {
  const assignment = launcher?.match(
    /^\s*(?:export\s+)?CLANKY_RELEASE_CHANNEL\s*=\s*(?:(['"])(stable|prerelease)\1|(stable|prerelease))\s*(?:#.*)?$/m,
  );
  const channel = assignment?.[2] ?? assignment?.[3];
  if (channel === "prerelease") return true;
  if (channel === "stable") return false;
  return undefined;
}

export async function prepareWorkerRuntimeAssets(
  executor: CommandExecutor,
  {
    paths,
    runtime,
    install = false,
    useClankyPrerelease,
  }: {
    paths: WorkerPaths;
    runtime: AgentSettings;
    install?: boolean;
    useClankyPrerelease?: boolean;
  },
): Promise<{ rollback: () => Promise<void> }> {
  const assetPaths = [
    pathPosix.join(paths.hostRoot, "install-runtime.sh"),
    pathPosix.join(paths.hostRoot, "runtime.json"),
    pathPosix.join(paths.hostRoot, "launcher.sh"),
  ] as const;
  const suffix = `.pending-${crypto.randomUUID()}`;
  const previous = await Promise.all(assetPaths.map(async (assetPath) => {
    if (!await executor.fileExists(assetPath)) return null;
    const content = await executor.readFile(assetPath);
    if (content === null) throw new DomainError("workspace_runtime_assets_failed", "Cannot read the previous workspace runtime configuration.");
    return content;
  }));
  const effectivePrereleaseSelection = useClankyPrerelease
    ?? getExistingPrereleaseSelection(previous[2])
    ?? false;
  const assets = [
    { path: assetPaths[0], content: buildRuntimeInstaller() },
    { path: assetPaths[1], content: JSON.stringify(runtime) },
    {
      path: assetPaths[2],
      content: buildWorkerLauncher(paths, effectivePrereleaseSelection),
    },
  ];
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
