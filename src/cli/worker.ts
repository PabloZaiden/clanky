import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { createManagedApiKey, listManagedApiKeys, revokeManagedApiKey } from "@/platform/server";
import { createLogger, readWebAppConfig, webAppConfigPath } from "@pablozaiden/webapp/server";
import type {
  CliCommandResult,
  WebAppCliCommandDefinition,
} from "@/platform/cli";
import type { CurrentUser } from "@/platform/contracts";
import { MESH_INSTANCE_NAME_MAX_LENGTH } from "@/shared/mesh";
import { getDataDir } from "../persistence/database";
import {
  normalizeMeshInstanceName,
  setLocalMeshEndpoint,
  setLocalMeshInstanceName,
} from "../persistence/mesh-node-identity";
import {
  getMeshTransport,
  resolveAdvertisedMeshEndpoint,
} from "../core/mesh-transport-config";
import { normalizeMeshEnrollmentTarget } from "../core/mesh-target-discovery";
import { meshTargetTlsTrust } from "../core/mesh-tls-trust";
import { meshManager } from "../core/mesh-manager";
import type { ClankyCliContext } from "./mesh";
import { createWorkerServiceCommand } from "./worker-service";
import {
  resolveWorkerSshAgentConfiguration,
  runWorkerSshAgentCommand,
} from "./worker-ssh-agent";
import { resolveWorkerRuntimeConfiguration } from "./worker-runtime";
import { runWorkerChannelCommand } from "./worker-channel";

const log = createLogger("cli:worker");

interface WorkerBootstrapOptions {
  host: string;
  port: number;
  workerDirectory: string;
  meshEndpoint: string | null;
  instanceName: string;
  keyName: string;
  rotate: boolean;
  relayOnly: boolean;
}

function isLoopbackHost(host: string): boolean {
  return [
    "127.0.0.1",
    "localhost",
    "::1",
    "[::1]",
  ].includes(host.trim().toLowerCase());
}

export function parseWorkerBootstrapArgs(
  args: readonly string[],
): WorkerBootstrapOptions {
  const [operation, ...rest] = args;
  if (operation !== "bootstrap") {
    throw new Error("Worker command must be bootstrap");
  }
  let keyName = "Mesh worker";
  let host: string | undefined;
  let port: number | undefined;
  let workerDirectory: string | undefined;
  let meshEndpoint: string | undefined;
  let instanceName: string | undefined;
  let rotate = false;
  let relayOnly = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--rotate") {
      rotate = true;
      continue;
    }
    if (arg === "--relay-only" || arg === "--outbound-only") {
      relayOnly = true;
      continue;
    }
    if (
      arg !== "--host"
      && arg !== "--port"
      && arg !== "--worker-directory"
      && arg !== "--mesh-endpoint"
      && arg !== "--instance-name"
      && arg !== "--name"
    ) {
      throw new Error(`Unknown worker option: ${String(arg)}`);
    }
    const value = rest[index + 1]?.trim();
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    if (arg === "--host") {
      host = value;
    } else if (arg === "--port") {
      if (!/^\d+$/.test(value)) {
        throw new Error("--port must be an integer between 0 and 65535");
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error("--port must be an integer between 0 and 65535");
      }
      port = parsed;
    } else if (arg === "--worker-directory") {
      workerDirectory = resolve(value);
    } else if (arg === "--mesh-endpoint") {
      meshEndpoint = resolveAdvertisedMeshEndpoint(value);
    } else if (arg === "--instance-name") {
      instanceName = normalizeMeshInstanceName(value);
    } else {
      keyName = value;
    }
    index += 1;
  }
  workerDirectory ??= resolve(homedir());
  instanceName ??= normalizeMeshInstanceName(
    hostname().replace(/\..*$/, "").slice(0, MESH_INSTANCE_NAME_MAX_LENGTH),
  );
  if (!host && port === undefined && !meshEndpoint) relayOnly = true;
  if (relayOnly) {
    if (meshEndpoint) {
      throw new Error("Outbound-only worker bootstrap does not accept --mesh-endpoint");
    }
    if (host && !isLoopbackHost(host)) {
      throw new Error("worker bootstrap --relay-only requires a loopback --host");
    }
    if (port !== undefined && port !== 0) {
      throw new Error("worker bootstrap --relay-only requires --port 0 when specified");
    }
    return {
      host: "127.0.0.1",
      port: 0,
      workerDirectory,
      meshEndpoint: null,
      instanceName,
      keyName,
      rotate,
      relayOnly: true,
    };
  }
  if (!host) {
    throw new Error("worker bootstrap requires --host for direct mode, or use --relay-only");
  }
  if (port === undefined) {
    throw new Error("worker bootstrap requires --port for direct mode, or use --relay-only");
  }
  if (!meshEndpoint) {
    throw new Error("worker bootstrap requires --mesh-endpoint for direct mode, or use --relay-only");
  }
  if (getMeshTransport(meshEndpoint) !== "https") {
    throw new Error(
      "worker bootstrap requires an HTTPS --mesh-endpoint",
    );
  }
  return {
    host,
    port,
    workerDirectory,
    meshEndpoint,
    instanceName,
    keyName,
    rotate,
    relayOnly: false,
  };
}

async function persistWorkerBootstrapConfiguration(
  options: WorkerBootstrapOptions,
): Promise<void> {
  const dataDir = getDataDir();
  const current = readWebAppConfig(dataDir);
  const next = {
    ...current,
    server: {
      ...current.server,
      host: options.host,
      port: options.port,
    },
    serve: {
      ...current.serve,
      options: {
        ...current.serve?.options,
        "mesh-worker": true,
        "relay-only": options.relayOnly,
        "worker-directory": options.workerDirectory,
        "worker-execution-enabled": true,
      },
    },
  };
  await Bun.write(webAppConfigPath(dataDir), `${JSON.stringify(next, null, 2)}\n`);
}

async function bootstrapWorker(
  context: Parameters<NonNullable<WebAppCliCommandDefinition<ClankyCliContext>["handler"]>>[0],
  printResult = true,
): Promise<CliCommandResult> {
  const options = parseWorkerBootstrapArgs(context.args);
  if (options.relayOnly) {
    await persistWorkerBootstrapConfiguration(options);
  }
  const { getWebAppServer } = await import("../server");
  const app = await getWebAppServer({
    meshWorker: true,
    workerDirectory: options.workerDirectory,
    workerExecutionEnabled: true,
    relayOnly: options.relayOnly,
    ...(options.meshEndpoint ? { workerEndpoint: options.meshEndpoint } : {}),
    rotateWorkerTls: options.rotate,
  });
  if (!options.relayOnly) {
    await persistWorkerBootstrapConfiguration(options);
  }
  if (options.meshEndpoint) {
    await setLocalMeshEndpoint(options.meshEndpoint);
  }
  await setLocalMeshInstanceName(options.instanceName);
  let owner = app.store.getOwnerUser();
  if (!owner) {
    const now = new Date().toISOString();
    owner = {
      id: crypto.randomUUID(),
      username: "worker",
      role: "owner",
      passkeyConfigured: false,
      authInitialized: true,
      authVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    app.store.createUser(owner);
  }

  const existing = listManagedApiKeys(app.store, owner.id, "clanky-mesh-worker");
  if (existing.length > 0 && !options.rotate) {
    if (printResult) context.stdout.write(`${JSON.stringify({
      apiKey: null,
      keyId: existing[0]!.id,
      ownerId: owner.id,
      meshWorker: true,
      relayOnly: options.relayOnly,
      alreadyBootstrapped: true,
    })}\n`);
    return { exitCode: 0 };
  }
  if (options.rotate) {
    for (const key of existing) {
      revokeManagedApiKey(app.store, key.id, owner.id);
    }
  }

  const currentUser: CurrentUser = {
    id: owner.id,
    username: owner.username,
    role: owner.role,
    isOwner: true,
    isAdmin: true,
  };
  const created = createManagedApiKey(app.store, currentUser, {
    name: options.keyName,
    scopes: ["*"],
    prefix: "clanky",
    managedBy: "clanky-mesh-worker",
  });
  if (printResult) context.stdout.write(`${JSON.stringify({
    apiKey: created.token,
    keyId: created.key.id,
    ownerId: owner.id,
    meshWorker: true,
    relayOnly: options.relayOnly,
  })}\n`);
  return { exitCode: 0 };
}

interface WorkerJoinOptions {
  target: string;
  enrollmentToken: string;
  controllerFingerprint: string;
  tlsCertificate?: string;
}

export function parseWorkerJoinArgs(args: readonly string[]): WorkerJoinOptions {
  const [operation, targetValue, ...rest] = args;
  if (operation !== "join") {
    throw new Error("Worker command must be bootstrap, join, or service");
  }
  if (!targetValue || targetValue.startsWith("--")) {
    throw new Error("worker join requires one target");
  }
  const values: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (
      arg !== "--token"
      && arg !== "--fingerprint"
      && arg !== "--controller-cert"
    ) {
      throw new Error(`Unknown worker option: ${String(arg)}`);
    }
    const value = rest[index + 1]?.trim();
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    values[arg] = value;
    index += 1;
  }
  const enrollmentToken = values["--token"];
  const controllerFingerprint = values["--fingerprint"];
  if (!enrollmentToken) throw new Error("worker join requires --token");
  if (!controllerFingerprint) throw new Error("worker join requires --fingerprint");
  let tlsCertificate: string | undefined;
  if (values["--controller-cert"] !== undefined) {
    const encoded = values["--controller-cert"]!;
    if (encoded.length > 48 * 1024 || Buffer.from(encoded, "base64").toString("base64") !== encoded) {
      throw new Error("--controller-cert must be a base64-encoded public PEM certificate (at most 32 KiB).");
    }
    tlsCertificate = Buffer.from(encoded, "base64").toString("utf8");
    meshTargetTlsTrust(normalizeMeshEnrollmentTarget(targetValue), tlsCertificate);
  }
  return {
    target: normalizeMeshEnrollmentTarget(targetValue),
    enrollmentToken,
    controllerFingerprint,
    tlsCertificate,
  };
}

async function joinWorker(
  context: Parameters<NonNullable<WebAppCliCommandDefinition<ClankyCliContext>["handler"]>>[0],
): Promise<CliCommandResult> {
  const options = parseWorkerJoinArgs(context.args);
  let runtime = resolveWorkerRuntimeConfiguration({
    environment: context.environment,
  });
  const persisted = readWebAppConfig(runtime.dataDir);
  if (persisted.serve?.options?.["mesh-worker"] !== true) {
    if (await Bun.file(join(runtime.dataDir, "clanky.db")).exists()) {
      throw new Error("worker join will not convert an existing controller data directory. Use a separate CLANKY_DATA_DIR or explicitly bootstrap this worker.");
    }
    const bootstrapped = await bootstrapWorker({ ...context, args: ["bootstrap", "--outbound-only"] }, false);
    if (bootstrapped.exitCode !== 0) return bootstrapped;
    runtime = resolveWorkerRuntimeConfiguration({ environment: context.environment });
  }
  const startedAt = performance.now();
  log.info("Initializing worker enrollment runtime");
  const { getWebAppServer } = await import("../server");
  await getWebAppServer({
    meshWorker: true,
    relayOnly: runtime.relayOnly,
    workerDirectory: runtime.workerDirectory,
    workerExecutionEnabled: runtime.workerExecutionEnabled,
  });
  log.info("Worker enrollment runtime initialized", {
    elapsedMs: Math.round(performance.now() - startedAt),
  });
  const grant = await meshManager.enrollWithController({
    target: options.target,
    enrollmentToken: options.enrollmentToken,
    expectedFingerprint: options.controllerFingerprint,
    tlsCertificate: options.tlsCertificate,
  });
  log.info("Worker enrollment completed", {
    elapsedMs: Math.round(performance.now() - startedAt),
  });
  context.stdout.write(`${JSON.stringify({
    controller: {
      nodeId: grant.controllerNodeId,
      instanceName: grant.controllerInstanceName,
      fingerprint: grant.controllerFingerprint,
      status: grant.grantStatus,
    },
  })}\n`);
  return { exitCode: 0 };
}

async function runWorkerCommand(
  context: Parameters<NonNullable<WebAppCliCommandDefinition<ClankyCliContext>["handler"]>>[0],
): Promise<CliCommandResult> {
  const [operation, ...rest] = context.args;
  if (operation === "service") {
    return await createWorkerServiceCommand().handler({ ...context, args: rest });
  }
  if (operation === "channel") {
    return await runWorkerChannelCommand({ ...context, args: rest });
  }
  if (operation === "bootstrap") {
    return await bootstrapWorker(context);
  }
  if (operation === "join") {
    return await joinWorker({ ...context, args: [operation, ...rest] });
  }
  if (operation === "ssh-agent") {
    if (process.platform !== "linux") {
      throw new Error("The worker SSH-agent command is supported on Linux only.");
    }
    const configuration = resolveWorkerSshAgentConfiguration({
      environment: context.environment,
      binaryPath: process.execPath,
    });
    return await runWorkerSshAgentCommand(
      { ...context, args: rest },
      configuration,
    );
  }
  throw new Error("Worker command must be bootstrap, join, channel, service, or ssh-agent");
}

export function createWorkerCommand(): WebAppCliCommandDefinition<ClankyCliContext> {
  return {
    description: "Bootstrap and manage a Mesh worker.",
    usage: [
      "worker <bootstrap|join|channel|service|ssh-agent> [options]",
      "",
      "The invitation selects a controller or relay; the worker connects outward in both cases.",
      "  clanky worker join HTTPS_TARGET --token TOKEN --fingerprint CONTROLLER_FINGERPRINT [--controller-cert BASE64_PUBLIC_PEM]",
      "Fresh join initializes an outbound-only worker. Install/start its service explicitly afterward.",
      "",
      "Bootstrap (optional before join):",
      "  clanky worker bootstrap [--worker-directory DIR] [--instance-name NAME] [--name KEY_NAME] [--rotate]",
      "  clanky worker bootstrap --outbound-only [--worker-directory DIR] [--instance-name NAME]",
      "",
      "Existing listener-based direct workers:",
      "  clanky worker bootstrap --host HOST --port PORT --mesh-endpoint HTTPS_URL [--worker-directory DIR] [--instance-name NAME] [--name KEY_NAME] [--rotate]",
      "",
      "Outbound-only mode uses a private loopback API and an ephemeral port; no public worker endpoint is needed.",
      "--relay-only is the existing name for outbound-only bootstrap and accepts either invitation target.",
      "Defaults: --worker-directory uses $HOME; --instance-name uses the short system hostname, capped at 64 characters.",
    ].join("\n"),
    handler: runWorkerCommand,
  };
}
