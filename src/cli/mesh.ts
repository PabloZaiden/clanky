import {
  runApiCliCommand,
  type CliCommandResult,
  type WebAppCliCommandContext,
  type WebAppCliCommandDefinition,
} from "@pablozaiden/webapp/cli";
import type { RouteCatalogEntry } from "@pablozaiden/webapp/server";
import type { MeshEnrollmentRoute } from "@/contracts/schemas/mesh";

export interface ClankyCliContext {
  routeCatalog: readonly RouteCatalogEntry[];
}

export type MeshOperation =
  | "status"
  | "enroll"
  | "enrollment-token-create"
  | "revoke"
  | "relay-bootstrap-info"
  | "relay-pair"
  | "relay-status"
  | "relay-unpair";

export interface MeshCommand {
  operation: MeshOperation;
  endpoint?: string;
  workerNodeId?: string;
  fingerprint?: string;
  token?: string;
  name?: string;
  ttlSeconds?: number;
  relayUrl?: string;
  route?: MeshEnrollmentRoute;
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
  if (operation === "enroll") {
    const { positionals, options } = parseOptions(operationArgs, ["--token", "--fingerprint"]);
    const token = options["--token"];
    const fingerprint = options["--fingerprint"] ?? process.env["CLANKY_MESH_CONTROLLER_FINGERPRINT"];
    if (!token) throw usageError("Mesh enroll requires --token");
    if (!fingerprint) {
      throw usageError("Mesh enroll requires --fingerprint or CLANKY_MESH_CONTROLLER_FINGERPRINT");
    }
    return {
      operation,
      endpoint: requireSinglePositional(positionals, "Mesh enroll requires one target"),
      token,
      fingerprint,
    };
  }
  if (operation === "enrollment-token") {
    const [tokenOperation, ...tokenArgs] = operationArgs;
    if (tokenOperation !== "create") {
      throw usageError("Mesh enrollment-token command must be create");
    }
    const { positionals, options } = parseOptions(
      tokenArgs,
      ["--name", "--ttl-seconds", "--route"],
    );
    if (positionals.length > 0) throw usageError(`Unexpected argument: ${positionals[0]}`);
    const ttlSeconds = options["--ttl-seconds"]
      ? Number.parseInt(options["--ttl-seconds"], 10)
      : undefined;
    if (ttlSeconds !== undefined && !Number.isInteger(ttlSeconds)) {
      throw usageError("--ttl-seconds must be an integer");
    }
    const route = options["--route"];
    if (route !== undefined && route !== "direct" && route !== "relay") {
      throw usageError("--route must be direct or relay");
    }
    return {
      operation: "enrollment-token-create",
      name: options["--name"],
      ttlSeconds,
      route,
    };
  }
  if (operation === "relay") {
    const [relayOperation, ...relayArgs] = operationArgs;
    const { positionals } = parseOptions(relayArgs, []);
    if (relayOperation === "pair") {
      return {
        operation: "relay-pair",
        relayUrl: requireSinglePositional(
          positionals,
          "Mesh relay pair requires one relay URL",
        ),
      };
    }
    if (
      relayOperation === "status"
      || relayOperation === "unpair"
      || relayOperation === "bootstrap-info"
    ) {
      if (positionals.length > 0) {
        throw usageError(`Unexpected argument: ${positionals[0]}`);
      }
      return {
        operation: relayOperation === "status"
          ? "relay-status"
          : relayOperation === "unpair"
            ? "relay-unpair"
            : "relay-bootstrap-info",
      };
    }
    throw usageError(
      "Mesh relay command must be bootstrap-info, pair, status, or unpair",
    );
  }
  throw usageError(
    "Mesh command must be status, enroll, enrollment-token, relay, or revoke",
  );
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
          target: command.endpoint,
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
          ...(command.route ? { route: command.route } : {}),
        }),
      };
    case "revoke":
      return {
        endpoint: "/api/mesh/workers/revoke",
        method: "POST",
        payload: JSON.stringify({ workerNodeId: command.workerNodeId }),
      };
    case "relay-bootstrap-info":
    case "relay-status":
      return { endpoint: "/api/mesh/relay", method: "GET" };
    case "relay-pair":
      return {
        endpoint: "/api/mesh/relay",
        method: "POST",
        payload: JSON.stringify({ relayUrl: command.relayUrl }),
      };
    case "relay-unpair":
      return { endpoint: "/api/mesh/relay", method: "DELETE" };
  }
}

export async function runMeshCommand(
  context: WebAppCliCommandContext<ClankyCliContext>,
): Promise<CliCommandResult> {
  const command = parseMeshCommandArgs(context.args);
  const request = buildMeshRequest(command);
  const result = await runApiCliCommand({
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
    ...(command.operation === "relay-bootstrap-info"
      ? { responseFormat: "body" as const }
      : {}),
  });
  if (command.operation !== "relay-bootstrap-info" || result.exitCode !== 0) {
    return result;
  }
  let body: unknown;
  try {
    body = JSON.parse(result.output ?? "") as unknown;
  } catch {
    return {
      exitCode: 1,
      error: "Controller relay bootstrap information was not valid JSON.",
    };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      exitCode: 1,
      error: "Controller relay bootstrap information was invalid.",
    };
  }
  const record = body as Record<string, unknown>;
  const fingerprint = record["controllerFingerprint"];
  const environment = record["bootstrapEnvironment"];
  if (typeof fingerprint !== "string" || typeof environment !== "string") {
    return {
      exitCode: 1,
      error: "Controller relay bootstrap information was incomplete.",
    };
  }
  return {
    exitCode: 0,
    output: `Controller fingerprint: ${fingerprint}\n${environment}`,
  };
}

export function createMeshCommand(): WebAppCliCommandDefinition<ClankyCliContext> {
  return {
    description: "Enroll workers and manage the controller Mesh relay.",
    usage: "mesh <status|enroll|enrollment-token|relay|revoke> [options]",
    handler: runMeshCommand,
  };
}
