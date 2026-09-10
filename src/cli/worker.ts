import { resolve } from "node:path";
import {
  createManagedApiKey,
  listManagedApiKeys,
  revokeManagedApiKey,
  readWebAppConfig,
  webAppConfigPath,
} from "@pablozaiden/webapp/server";
import type {
  CliCommandResult,
  WebAppCliCommandDefinition,
} from "@pablozaiden/webapp/cli";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import { getWebAppServer } from "../server";
import { getDataDir } from "../persistence/database";
import {
  normalizeMeshInstanceName,
  setLocalMeshEndpoint,
  setLocalMeshInstanceName,
} from "../persistence/mesh-node-identity";
import {
  assertMeshEndpointAllowed,
  getMeshTransport,
  resolveAdvertisedMeshEndpoint,
} from "../core/mesh-transport-config";
import { meshManager } from "../core/mesh-manager";
import type { ClankyCliContext } from "./mesh";
import { createWorkerServiceCommand } from "./worker-service";
import {
  resolveWorkerSshAgentConfiguration,
  runWorkerSshAgentCommand,
} from "./worker-ssh-agent";
import { resolveWorkerRuntimeConfiguration } from "./worker-runtime";

interface WorkerBootstrapOptions {
  host: string;
  port: number;
  workerDirectory: string;
  meshEndpoint: string;
  instanceName: string;
  keyName: string;
  rotate: boolean;
  insecure: boolean;
}

function parseWorkerBootstrapArgs(args: readonly string[]): WorkerBootstrapOptions {
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
  let insecure = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--rotate") {
      rotate = true;
      continue;
    }
    if (arg === "--insecure") {
      insecure = true;
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
  if (!host) throw new Error("worker bootstrap requires --host");
  if (port === undefined) throw new Error("worker bootstrap requires --port");
  if (!workerDirectory) throw new Error("worker bootstrap requires --worker-directory");
  if (!meshEndpoint) throw new Error("worker bootstrap requires --mesh-endpoint");
  if (!instanceName) throw new Error("worker bootstrap requires --instance-name");
  const expectedTransport = insecure ? "http" : "https";
  if (getMeshTransport(meshEndpoint) !== expectedTransport) {
    throw new Error(
      `worker bootstrap requires an ${expectedTransport.toUpperCase()} --mesh-endpoint${insecure ? "" : " (or pass --insecure for HTTP)"}`,
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
    insecure,
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
        "worker-directory": options.workerDirectory,
        "worker-execution-enabled": true,
        insecure: options.insecure,
      },
    },
  };
  await Bun.write(webAppConfigPath(dataDir), `${JSON.stringify(next, null, 2)}\n`);
}

async function bootstrapWorker(
  context: Parameters<NonNullable<WebAppCliCommandDefinition<ClankyCliContext>["handler"]>>[0],
): Promise<CliCommandResult> {
  const options = parseWorkerBootstrapArgs(context.args);
  const app = await getWebAppServer({
    meshWorker: true,
    workerDirectory: options.workerDirectory,
    workerExecutionEnabled: true,
    insecure: options.insecure,
    workerEndpoint: options.meshEndpoint,
    rotateWorkerTls: options.rotate,
  });
  await persistWorkerBootstrapConfiguration(options);
  await setLocalMeshEndpoint(options.meshEndpoint);
  await setLocalMeshInstanceName(options.instanceName);
  let owner = app.store.getOwnerUser();
  if (!owner) {
    const now = new Date().toISOString();
    owner = {
      id: crypto.randomUUID(),
      username: "worker",
      role: "owner",
      passkeyConfigured: false,
      authVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    app.store.createUser(owner);
  }

  const existing = listManagedApiKeys(app.store, owner.id, "clanky-mesh-worker");
  if (existing.length > 0 && !options.rotate) {
    context.stdout.write(`${JSON.stringify({
      apiKey: null,
      keyId: existing[0]!.id,
      ownerId: owner.id,
      meshWorker: true,
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
  context.stdout.write(`${JSON.stringify({
    apiKey: created.token,
    keyId: created.key.id,
    ownerId: owner.id,
    meshWorker: true,
  })}\n`);
  return { exitCode: 0 };
}

interface WorkerJoinOptions {
  controllerEndpoint: string;
  enrollmentToken: string;
  controllerFingerprint: string;
}

function parseWorkerJoinArgs(args: readonly string[]): WorkerJoinOptions {
  const [operation, ...rest] = args;
  if (operation !== "join") {
    throw new Error("Worker command must be bootstrap, join, or service");
  }
  const values: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (
      arg !== "--controller"
      && arg !== "--token"
      && arg !== "--fingerprint"
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
  const controllerEndpoint = values["--controller"];
  const enrollmentToken = values["--token"];
  const controllerFingerprint = values["--fingerprint"];
  if (!controllerEndpoint) throw new Error("worker join requires --controller");
  if (!enrollmentToken) throw new Error("worker join requires --token");
  if (!controllerFingerprint) throw new Error("worker join requires --fingerprint");
  assertMeshEndpointAllowed(controllerEndpoint);
  return {
    controllerEndpoint,
    enrollmentToken,
    controllerFingerprint,
  };
}

async function joinWorker(
  context: Parameters<NonNullable<WebAppCliCommandDefinition<ClankyCliContext>["handler"]>>[0],
): Promise<CliCommandResult> {
  const options = parseWorkerJoinArgs(context.args);
  const runtime = resolveWorkerRuntimeConfiguration({
    environment: context.environment,
  });
  await getWebAppServer({
    meshWorker: true,
    workerDirectory: runtime.workerDirectory,
    workerExecutionEnabled: runtime.workerExecutionEnabled,
    insecure: runtime.insecure,
  });
  const grant = await meshManager.enrollWithController({
    controllerEndpoint: options.controllerEndpoint,
    enrollmentToken: options.enrollmentToken,
    expectedFingerprint: options.controllerFingerprint,
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
  throw new Error("Worker command must be bootstrap, join, service, or ssh-agent");
}

export function createWorkerCommand(): WebAppCliCommandDefinition<ClankyCliContext> {
  return {
    description: "Bootstrap and manage a Mesh worker.",
    usage: "worker <bootstrap|join|service|ssh-agent> [options]",
    handler: runWorkerCommand,
  };
}
