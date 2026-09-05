import {
  runApiCliCommand,
  type CliCommandResult,
  type WebAppCliCommandContext,
  type WebAppCliCommandDefinition,
} from "@pablozaiden/webapp/cli";
import type { RouteCatalogEntry } from "@pablozaiden/webapp/server";

export interface ClankyCliContext {
  routeCatalog: readonly RouteCatalogEntry[];
}

export type MeshOperation =
  | "status"
  | "enroll"
  | "enrollment-token-create"
  | "revoke"
  | "update-worker";

export interface MeshCommand {
  operation: MeshOperation;
  endpoint?: string;
  workerNodeId?: string;
  fingerprint?: string;
  token?: string;
  name?: string;
  ttlSeconds?: number;
}

function usageError(message: string): Error {
  return new Error(message);
}

function parseOptions(
  args: readonly string[],
  allowedOptions: readonly string[],
): { positionals: string[]; options: Record<string, string> } {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [rawName, inlineValue] = arg.split("=", 2);
    const name = rawName ?? arg;
    if (!allowedOptions.includes(name)) {
      throw usageError(`Unknown mesh option: ${name}`);
    }
    if (options[name] !== undefined) {
      throw usageError(`${name} may only be specified once`);
    }
    const value = inlineValue ?? args[index + 1];
    if (!value || value.startsWith("--")) {
      throw usageError(`${name} requires a value`);
    }
    options[name] = value;
    if (inlineValue === undefined) index += 1;
  }
  return { positionals, options };
}

function requireSinglePositional(positionals: readonly string[], message: string): string {
  if (positionals.length !== 1 || !positionals[0]) {
    throw usageError(message);
  }
  return positionals[0];
}

export function parseMeshCommandArgs(args: readonly string[]): MeshCommand {
  const [operation, ...operationArgs] = args;
  if (operation === "status") {
    const { positionals } = parseOptions(operationArgs, []);
    if (positionals.length > 0) throw usageError(`Unexpected argument: ${positionals[0]}`);
    return { operation };
  }
  if (operation === "revoke") {
    const { positionals } = parseOptions(operationArgs, []);
    return {
      operation,
      workerNodeId: requireSinglePositional(positionals, "Mesh revoke requires one worker node ID"),
    };
  }
  if (operation === "update-worker") {
    const { positionals } = parseOptions(operationArgs, []);
    return {
      operation,
      workerNodeId: requireSinglePositional(positionals, "Mesh update-worker requires one worker node ID"),
    };
  }
  if (operation === "enroll") {
    const { positionals, options } = parseOptions(operationArgs, ["--token", "--fingerprint"]);
    const token = options["--token"] ?? process.env["CLANKY_MESH_ENROLLMENT_TOKEN"];
    const fingerprint = options["--fingerprint"] ?? process.env["CLANKY_MESH_CONTROLLER_FINGERPRINT"];
    if (!token) throw usageError("Mesh enroll requires --token or CLANKY_MESH_ENROLLMENT_TOKEN");
    if (!fingerprint) {
      throw usageError("Mesh enroll requires --fingerprint or CLANKY_MESH_CONTROLLER_FINGERPRINT");
    }
    return {
      operation,
      endpoint: requireSinglePositional(positionals, "Mesh enroll requires one controller endpoint"),
      token,
      fingerprint,
    };
  }
  if (operation === "enrollment-token") {
    const [tokenOperation, ...tokenArgs] = operationArgs;
    if (tokenOperation !== "create") {
      throw usageError("Mesh enrollment-token command must be create");
    }
    const { positionals, options } = parseOptions(tokenArgs, ["--name", "--ttl-seconds"]);
    if (positionals.length > 0) throw usageError(`Unexpected argument: ${positionals[0]}`);
    const ttlSeconds = options["--ttl-seconds"]
      ? Number.parseInt(options["--ttl-seconds"], 10)
      : undefined;
    if (ttlSeconds !== undefined && !Number.isInteger(ttlSeconds)) {
      throw usageError("--ttl-seconds must be an integer");
    }
    return {
      operation: "enrollment-token-create",
      name: options["--name"],
      ttlSeconds,
    };
  }
  throw usageError("Mesh command must be status, enroll, enrollment-token, revoke, or update-worker");
}

export function buildMeshRequest(command: MeshCommand): {
  endpoint: string;
  method: string;
  payload?: string;
} {
  switch (command.operation) {
    case "status":
      return { endpoint: "/api/mesh/status", method: "GET" };
    case "enroll":
      return {
        endpoint: "/api/mesh/enroll",
        method: "POST",
        payload: JSON.stringify({
          controllerEndpoint: command.endpoint,
          enrollmentToken: command.token,
          expectedControllerFingerprint: command.fingerprint,
        }),
      };
    case "enrollment-token-create":
      return {
        endpoint: "/api/mesh/enrollment-tokens",
        method: "POST",
        payload: JSON.stringify({
          ...(command.name ? { name: command.name } : {}),
          ...(command.ttlSeconds !== undefined ? { ttlSeconds: command.ttlSeconds } : {}),
        }),
      };
    case "revoke":
      return {
        endpoint: "/api/mesh/workers/revoke",
        method: "POST",
        payload: JSON.stringify({ workerNodeId: command.workerNodeId }),
      };
    case "update-worker":
      return {
        endpoint: `/api/mesh/workers/${encodeURIComponent(command.workerNodeId!)}/update`,
        method: "POST",
      };
  }
}

export async function runMeshCommand(
  context: WebAppCliCommandContext<ClankyCliContext>,
): Promise<CliCommandResult> {
  const request = buildMeshRequest(parseMeshCommandArgs(context.args));
  return await runApiCliCommand({
    args: [
      request.endpoint,
      "--method",
      request.method,
      ...(request.payload === undefined ? [] : ["--payload", request.payload]),
    ],
    catalog: context.appContext.routeCatalog,
    credentials: context.profiles.credentials(context.profile),
    envPrefix: context.envPrefix,
    environment: context.environment,
    fetchFn: context.fetchFn,
  });
}

export function createMeshCommand(): WebAppCliCommandDefinition<ClankyCliContext> {
  return {
    description: "Enroll and manage Mesh workers.",
    usage: "mesh <status|enroll|enrollment-token|revoke|update-worker> [options]",
    handler: runMeshCommand,
  };
}
