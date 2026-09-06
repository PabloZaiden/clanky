import {
  createManagedApiKey,
  listManagedApiKeys,
  revokeManagedApiKey,
} from "@pablozaiden/webapp/server";
import type {
  CliCommandResult,
  WebAppCliCommandDefinition,
} from "@pablozaiden/webapp/cli";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import { getWebAppServer } from "../server";
import type { ClankyCliContext } from "./mesh";
import { createWorkerServiceCommand } from "./worker-service";

interface WorkerBootstrapOptions {
  username: string;
  keyName: string;
  rotate: boolean;
}

function parseWorkerBootstrapArgs(args: readonly string[]): WorkerBootstrapOptions {
  const [operation, ...rest] = args;
  if (operation !== "bootstrap") {
    throw new Error("Worker command must be bootstrap");
  }
  let username = "worker";
  let keyName = "Mesh worker";
  let rotate = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--rotate") {
      rotate = true;
      continue;
    }
    if (arg !== "--username" && arg !== "--name") {
      throw new Error(`Unknown worker option: ${String(arg)}`);
    }
    const value = rest[index + 1]?.trim();
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    if (arg === "--username") {
      username = value;
    } else {
      keyName = value;
    }
    index += 1;
  }
  return { username, keyName, rotate };
}

async function bootstrapWorker(
  context: Parameters<NonNullable<WebAppCliCommandDefinition<ClankyCliContext>["handler"]>>[0],
): Promise<CliCommandResult> {
  const options = parseWorkerBootstrapArgs(context.args);
  const app = await getWebAppServer();
  let owner = app.store.getOwnerUser();
  if (!owner) {
    const now = new Date().toISOString();
    owner = {
      id: crypto.randomUUID(),
      username: options.username,
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
  throw new Error("Worker command must be bootstrap or service");
}

export function createWorkerCommand(): WebAppCliCommandDefinition<ClankyCliContext> {
  return {
    description: "Bootstrap and manage a Mesh worker.",
    usage: "worker <bootstrap|service> [options]",
    handler: runWorkerCommand,
  };
}
