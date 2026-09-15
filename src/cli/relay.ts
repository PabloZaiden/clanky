import type {
  CliCommandResult,
  WebAppCliCommandDefinition,
} from "@pablozaiden/webapp/cli";
import { readRuntimeConfig } from "@pablozaiden/webapp/server";
import { startRelayServer } from "../core/mesh-relay-server";
import { resetStoppedMeshRelayPairing } from "../core/mesh-relay-store";
import type { ClankyCliContext } from "./mesh";

export type RelayCommand =
  | { operation: "serve" }
  | { operation: "pairing-reset" };

export function parseRelayCommandArgs(args: readonly string[]): RelayCommand {
  if (args.length === 0) {
    return { operation: "serve" };
  }
  if (args.length === 2 && args[0] === "pairing" && args[1] === "reset") {
    return { operation: "pairing-reset" };
  }
  throw new Error("Relay command must be `relay` or `relay pairing reset`.");
}

async function serveRelay(
  context: Parameters<
    NonNullable<WebAppCliCommandDefinition<ClankyCliContext>["handler"]>
  >[0],
): Promise<CliCommandResult> {
  const runtimeConfig = readRuntimeConfig({
    appName: "Clanky Relay",
    envPrefix: context.envPrefix,
    appDirectoryName: ".clanky",
    environment: context.environment,
  });
  const relay = await startRelayServer({
    runtimeConfig,
    controllerFingerprint:
      context.environment["CLANKY_RELAY_CONTROLLER_FINGERPRINT"],
  });
  let stopping = false;
  let resolveSignal!: () => void;
  const signaled = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const onSignal = (): void => {
    resolveSignal();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await signaled;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (!stopping) {
      stopping = true;
      await relay.stop(true);
    }
  }
  return { exitCode: 0 };
}

export async function runRelayCommand(
  context: Parameters<
    NonNullable<WebAppCliCommandDefinition<ClankyCliContext>["handler"]>
  >[0],
): Promise<CliCommandResult> {
  const command = parseRelayCommandArgs(context.args);
  if (command.operation === "pairing-reset") {
    const runtimeConfig = readRuntimeConfig({
      appName: "Clanky Relay",
      envPrefix: context.envPrefix,
      appDirectoryName: ".clanky",
      environment: context.environment,
    });
    resetStoppedMeshRelayPairing(runtimeConfig.dataDir);
    return {
      exitCode: 0,
      output: "Relay controller pairing and worker authorization reset.",
    };
  }
  return await serveRelay(context);
}

export function createRelayCommand(): WebAppCliCommandDefinition<ClankyCliContext> {
  return {
    description: "Run the transport-only Mesh relay.",
    usage: "relay [pairing reset]",
    handler: runRelayCommand,
  };
}
