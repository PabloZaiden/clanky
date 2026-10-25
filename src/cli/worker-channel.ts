import { readFileSync } from "node:fs";
import { resolveAppDataDir, type RuntimeEnvironment } from "@pablozaiden/webapp/server";
import type { WebAppCliCommandContext, CliCommandResult } from "@pablozaiden/webapp/cli";
import type { WorkerReleaseChannel } from "@/shared/worker-update";
import { isAgentSettings } from "@/shared/settings";
import { DomainError } from "../domain/domain-error";
import { getWorkerChannelPath, parseWorkerChannel, writeWorkerChannel } from "../core/worker-channel";
import { CommandExecutorImpl } from "../core/remote-command-executor";
import { closeCommandExecutor } from "../core/command-executor";
import { getWorkerPathsForSupervisor } from "../core/provisioning/worker-assets";
import { prepareWorkerRuntimeAssets } from "../core/provisioning/worker-runtime-assets";
import { CLANKY_VERSION } from "../version";
import type { ClankyCliContext } from "./mesh";

const binaryChannel: WorkerReleaseChannel = CLANKY_VERSION.includes("-main-") ? "latest" : "stable";

function channelFile(environment: RuntimeEnvironment): string {
  const supervisor = environment["CLANKY_WORKER_SUPERVISOR"];
  return supervisor
    ? getWorkerPathsForSupervisor(supervisor).containerChannel
    : getWorkerChannelPath(resolveAppDataDir({ envPrefix: "CLANKY", environment }));
}

export function readConfiguredWorkerChannel(
  environment: RuntimeEnvironment,
): WorkerReleaseChannel | undefined {
  let raw: string;
  try {
    raw = readFileSync(channelFile(environment), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      const legacy = environment["CLANKY_WORKER_RELEASE_CHANNEL"];
      return legacy === "stable" || legacy === "latest" ? legacy : undefined;
    }
    throw new Error("Cannot read the saved worker release channel.", { cause: error });
  }
  return parseWorkerChannel(raw);
}

export function getEffectiveWorkerChannel(
  environment: RuntimeEnvironment,
): WorkerReleaseChannel | "prerelease" {
  return readConfiguredWorkerChannel(environment)
    ?? (environment["CLANKY_WORKER_RELEASE_CHANNEL"] === "prerelease"
      ? "prerelease"
      : binaryChannel);
}

export async function runWorkerChannelCommand(
  context: WebAppCliCommandContext<ClankyCliContext>,
): Promise<CliCommandResult> {
  if (context.args.length > 1) throw new Error("Usage: worker channel [stable|latest]");
  const requested = context.args[0];
  if (requested !== undefined) {
    const channel = parseWorkerChannel(requested);
    const executor = new CommandExecutorImpl({ directory: process.cwd() });
    try {
      const supervisor = context.environment["CLANKY_WORKER_SUPERVISOR"];
      if (supervisor) {
        const paths = getWorkerPathsForSupervisor(supervisor);
        const raw = await executor.readFile(paths.containerRuntime);
        let runtime: unknown;
        try {
          runtime = raw === null ? null : JSON.parse(raw);
        } catch (error) {
          throw new DomainError("workspace_runtime_assets_failed", "Cannot parse the workspace runtime configuration.", { cause: error });
        }
        if (!isAgentSettings(runtime)) {
          throw new DomainError("workspace_runtime_assets_failed", "The workspace runtime configuration is invalid.");
        }
        await prepareWorkerRuntimeAssets(executor, {
          paths,
          runtime,
          releaseChannel: channel,
          ...(binaryChannel === channel ? { installedChannel: channel } : {}),
        });
      } else {
        await writeWorkerChannel(executor, channelFile(context.environment), channel);
      }
    } finally {
      closeCommandExecutor(executor);
    }
  }
  context.stdout.write(`${JSON.stringify({ releaseChannel: getEffectiveWorkerChannel(context.environment) })}\n`);
  return { exitCode: 0 };
}
