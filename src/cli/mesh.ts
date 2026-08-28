import {
  runApiCliCommand,
  type CliCommandResult,
  type WebAppCliCommandDefinition,
  type WebAppCliCommandContext,
} from "@pablozaiden/webapp/cli";
import type { RouteCatalogEntry } from "@pablozaiden/webapp/server";

export interface ClankyCliContext {
  routeCatalog: readonly RouteCatalogEntry[];
}

export type MeshOperation =
  | "status"
  | "pair-start"
  | "pair-approve"
  | "pair-complete"
  | "pair-reject"
  | "revoke"
  | "rejoin";

export interface MeshCommand {
  operation: MeshOperation;
  endpoint?: string;
  requestId?: string;
  targetUserId?: string;
  linkId?: string;
  fingerprint?: string;
  reason?: string;
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
    if (inlineValue === undefined) {
      index += 1;
    }
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
  if (!operation) {
    throw usageError(
      "Mesh command must be status, revoke, rejoin, or pair",
    );
  }

  if (operation === "status") {
    const { positionals } = parseOptions(operationArgs, []);
    if (positionals.length > 0) {
      throw usageError(`Unexpected argument: ${positionals[0]}`);
    }
    return { operation };
  }

  if (operation === "revoke") {
    const { positionals } = parseOptions(operationArgs, []);
    return {
      operation,
      requestId: requireSinglePositional(
        positionals,
        "Mesh revoke requires one node ID",
      ),
    };
  }

  if (operation === "rejoin") {
    const { positionals, options } = parseOptions(operationArgs, ["--target-user-id"]);
    return {
      operation,
      endpoint: requireSinglePositional(
        positionals,
        "Mesh rejoin requires one target endpoint",
      ),
      targetUserId: options["--target-user-id"],
    };
  }

  if (operation !== "pair") {
    throw usageError(
      "Mesh command must be status, revoke, rejoin, or pair",
    );
  }

  const [pairOperation, ...pairArgs] = operationArgs;
  if (pairOperation === "start") {
    const { positionals, options } = parseOptions(pairArgs, ["--target-user-id"]);
    return {
      operation: "pair-start",
      endpoint: requireSinglePositional(
        positionals,
        "Mesh pair start requires one target endpoint",
      ),
      targetUserId: options["--target-user-id"],
    };
  }
  if (pairOperation === "approve") {
    const { positionals, options } = parseOptions(pairArgs, ["--link-id"]);
    return {
      operation: "pair-approve",
      requestId: requireSinglePositional(
        positionals,
        "Mesh pair approve requires one request ID",
      ),
      linkId: options["--link-id"],
    };
  }
  if (pairOperation === "complete") {
    const { positionals, options } = parseOptions(pairArgs, ["--fingerprint"]);
    if (positionals.length !== 1 || !options["--fingerprint"]) {
      throw usageError(
        "Mesh pair complete requires a request ID and --fingerprint",
      );
    }
    return {
      operation: "pair-complete",
      requestId: positionals[0],
      fingerprint: options["--fingerprint"],
    };
  }
  if (pairOperation === "reject") {
    const { positionals, options } = parseOptions(pairArgs, ["--reason"]);
    return {
      operation: "pair-reject",
      requestId: requireSinglePositional(
        positionals,
        "Mesh pair reject requires one request ID",
      ),
      reason: options["--reason"],
    };
  }
  throw usageError("Mesh pair command must be start, approve, complete, or reject");
}

export function buildMeshRequest(command: MeshCommand): {
  endpoint: string;
  method: string;
  payload?: string;
} {
  switch (command.operation) {
    case "status":
      return { endpoint: "/api/mesh/status", method: "GET" };
    case "pair-start":
      return {
        endpoint: "/api/mesh/pairing-requests",
        method: "POST",
        payload: JSON.stringify({
          targetEndpoint: command.endpoint,
          ...(command.targetUserId ? { targetLocalUserId: command.targetUserId } : {}),
        }),
      };
    case "pair-approve":
      return {
        endpoint: `/api/mesh/pairing-requests/${encodeURIComponent(command.requestId ?? "")}/approve`,
        method: "POST",
        payload: JSON.stringify(command.linkId ? { linkId: command.linkId } : {}),
      };
    case "pair-complete":
      return {
        endpoint: `/api/mesh/pairing-requests/${encodeURIComponent(command.requestId ?? "")}/complete`,
        method: "POST",
        payload: JSON.stringify({ fingerprint: command.fingerprint }),
      };
    case "pair-reject":
      return {
        endpoint: `/api/mesh/pairing-requests/${encodeURIComponent(command.requestId ?? "")}/reject`,
        method: "POST",
        payload: JSON.stringify(command.reason ? { reason: command.reason } : {}),
      };
    case "revoke":
      return {
        endpoint: "/api/mesh/members/revoke",
        method: "POST",
        payload: JSON.stringify({ nodeId: command.requestId }),
      };
    case "rejoin":
      return {
        endpoint: "/api/mesh/rejoin",
        method: "POST",
        payload: JSON.stringify({
          targetEndpoint: command.endpoint,
          ...(command.targetUserId ? { targetLocalUserId: command.targetUserId } : {}),
        }),
      };
  }
}

export async function runMeshCommand(
  context: WebAppCliCommandContext<ClankyCliContext>,
): Promise<CliCommandResult> {
  const command = parseMeshCommandArgs(context.args);
  const request = buildMeshRequest(command);
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
    description: "Inspect and manage linked mesh instances.",
    usage: "mesh <status|revoke|rejoin|pair> [options]",
    handler: runMeshCommand,
  };
}
