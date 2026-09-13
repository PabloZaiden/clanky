/**
 * CLI commands for direct execution on registered execution hosts.
 */

import {
  ExecutionHostDescriptorSchema,
  type ExecutionHostDescriptorInput,
} from "@/contracts/schemas";
import {
  executionHostRefsEqual,
  getExecutionHostSourceId,
  parseExecutionHostRef,
  serializeExecutionHostRef,
  type ExecutionHostRef,
} from "@/shared";
import type {
  CliCommandResult,
  WebAppCliCommandContext,
  WebAppCliCommandDefinition,
} from "@pablozaiden/webapp/cli";
import { parseExecCommandArgs, runCliExecRequest } from "./exec-command";
import {
  fetchCliApi,
  readCliResponseBody,
  responseErrorMessage,
  resolveCliApiAuth,
  type CliApiContext,
} from "./remote-api";
import type { ClankyCliContext } from "./mesh";

export interface ServerExecCommand {
  operation: "exec";
  server: string;
  cwd?: string;
  timeoutMs?: number;
  credentialToken?: string;
  command: string;
  args: string[];
}

function usageError(message: string): Error {
  return new Error(message);
}

export function parseServerCommandArgs(args: readonly string[]): ServerExecCommand {
  const [operation, ...operationArgs] = args;
  if (operation !== "exec") {
    throw usageError("Server command must be exec");
  }
  const parsed = parseExecCommandArgs(
    operationArgs,
    "server exec",
    "server",
    ["--credential-token"],
  );
  return {
    operation,
    server: parsed.target,
    cwd: parsed.cwd,
    timeoutMs: parsed.timeoutMs,
    credentialToken: parsed.options["--credential-token"],
    command: parsed.command,
    args: parsed.args,
  };
}

async function listExecutionHosts(
  input: CliApiContext,
  auth: Awaited<ReturnType<typeof resolveCliApiAuth>>,
  signal?: AbortSignal,
): Promise<ExecutionHostDescriptorInput[]> {
  const response = await fetchCliApi(input, auth, "/api/execution-hosts", { signal });
  const body = await readCliResponseBody(response);
  if (!response.ok) {
    throw new Error(responseErrorMessage(
      body,
      `Unable to list execution hosts (HTTP ${String(response.status)})`,
    ));
  }
  if (!Array.isArray(body)) {
    throw new Error("The execution-host list response is invalid");
  }
  const hosts: ExecutionHostDescriptorInput[] = [];
  for (const value of body) {
    const parsed = ExecutionHostDescriptorSchema.safeParse(value);
    if (parsed.success) {
      hosts.push(parsed.data);
    }
  }
  return hosts;
}

function parseReference(reference: string): ExecutionHostRef | undefined {
  try {
    return parseExecutionHostRef(reference);
  } catch {
    return undefined;
  }
}

function findExecutionHost(
  hosts: readonly ExecutionHostDescriptorInput[],
  reference: string,
): ExecutionHostDescriptorInput {
  const parsedReference = parseReference(reference);
  const matches = hosts.filter((host) => (
    host.name === reference
    || getExecutionHostSourceId(host.ref) === reference
    || serializeExecutionHostRef(host.ref) === reference
    || (parsedReference !== undefined && executionHostRefsEqual(host.ref, parsedReference))
  ));
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error(`Server reference is ambiguous: ${reference}`);
  }
  throw new Error(`Server not found: ${reference}`);
}

function executionHostExecPath(ref: ExecutionHostRef): string {
  return `/api/execution-hosts/${encodeURIComponent(ref.kind)}/${encodeURIComponent(
    getExecutionHostSourceId(ref),
  )}/exec`;
}

async function runServerExec(
  command: ServerExecCommand,
  input: CliApiContext,
  output: WebAppCliCommandContext<ClankyCliContext>,
  signal?: AbortSignal,
): Promise<CliCommandResult> {
  const auth = await resolveCliApiAuth(input);
  const hosts = await listExecutionHosts(input, auth, signal);
  const host = findExecutionHost(hosts, command.server);
  return await runCliExecRequest(
    input,
    auth,
    executionHostExecPath(host.ref),
    command,
    output,
    "server",
    signal,
    command.credentialToken === undefined
      ? undefined
      : { "x-clanky-ssh-credential-token": command.credentialToken },
  );
}

export async function runServerCommand(
  context: WebAppCliCommandContext<ClankyCliContext>,
): Promise<CliCommandResult> {
  const command = parseServerCommandArgs(context.args);
  const input: CliApiContext = {
    fetchFn: context.fetchFn,
    environment: context.environment,
    envPrefix: context.envPrefix,
    credentials: context.profiles.credentials(context.profile),
  };
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await runServerExec(command, input, context, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      return { exitCode: 130, error: "Server operation was aborted" };
    }
    return {
      exitCode: 1,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export function createServerCommand(): WebAppCliCommandDefinition<ClankyCliContext> {
  return {
    description: "Run a non-interactive command on a registered execution host.",
    usage: "server exec SERVER_OR_ID [--cwd PATH] [--timeout MS] [--credential-token TOKEN] -- COMMAND [ARGS...]",
    handler: runServerCommand,
  };
}
