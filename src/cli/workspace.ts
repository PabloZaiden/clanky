import { dirname, posix as pathPosix } from "node:path";
import { mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  getAuthorizedHeaders,
  normalizeBaseUrl,
  refreshDeviceCredentials,
  resolveEnvironmentApiKeyAuth,
  type CliEnvironment,
  type DeviceCredentialsStore,
  type StoredDeviceCredentials,
} from "@pablozaiden/webapp/cli";
import type {
  CliCommandResult,
  WebAppCliCommandContext,
  WebAppCliCommandDefinition,
} from "@pablozaiden/webapp/cli";
import { WorkspaceExecResponseSchema } from "@/contracts/schemas";
import type { ClankyCliContext } from "./mesh";

export interface WorkspaceExecCommand {
  operation: "exec";
  workspace: string;
  cwd?: string;
  timeoutMs?: number;
  command: string;
  args: string[];
}

export interface WorkspaceDownloadCommand {
  operation: "download";
  workspace: string;
  remotePath: string;
  output?: string;
  force: boolean;
}

export type WorkspaceCommand = WorkspaceExecCommand | WorkspaceDownloadCommand;

interface WorkspaceSummary {
  id: string;
  name: string;
}

interface WorkspaceCliContext {
  fetchFn: typeof fetch;
  environment: CliEnvironment;
  envPrefix: string;
  credentials: DeviceCredentialsStore & {
    read(): Promise<StoredDeviceCredentials | undefined>;
  };
}

interface WorkspaceCliAuth {
  baseUrl: string;
  headers: Headers;
  source: "device" | "environment" | "anonymous";
  accessToken?: string;
}

interface BinaryCliOutput {
  write(chunk: string | Uint8Array): unknown;
  once?: (event: "drain", listener: () => void) => unknown;
}

function usageError(message: string): Error {
  return new Error(message);
}

function parseOptionValue(
  args: readonly string[],
  index: number,
  name: string,
  inlineValue?: string,
): { value: string; nextIndex: number } {
  const value = inlineValue ?? args[index + 1];
  if (!value || value.startsWith("--")) {
    throw usageError(`${name} requires a value`);
  }
  return {
    value,
    nextIndex: inlineValue === undefined ? index + 1 : index,
  };
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
      throw usageError(`Unknown workspace option: ${name}`);
    }
    if (options[name] !== undefined) {
      throw usageError(`${name} may only be specified once`);
    }
    const parsed = parseOptionValue(args, index, name, inlineValue);
    options[name] = parsed.value;
    index = parsed.nextIndex;
  }
  return { positionals, options };
}

function parseDownloadOptions(
  args: readonly string[],
): { positionals: string[]; output?: string; force: boolean } {
  const positionals: string[] = [];
  let output: string | undefined;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--force") {
      if (force) throw usageError("--force may only be specified once");
      force = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [rawName, inlineValue] = arg.split("=", 2);
    const name = rawName ?? arg;
    if (name !== "--output") {
      throw usageError(`Unknown workspace option: ${name}`);
    }
    if (output !== undefined) {
      throw usageError("--output may only be specified once");
    }
    const parsed = parseOptionValue(args, index, name, inlineValue);
    output = parsed.value;
    index = parsed.nextIndex;
  }
  return { positionals, output, force };
}

function parseTimeout(value: string): number {
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000) {
    throw usageError("--timeout must be an integer between 1 and 1800000");
  }
  return timeoutMs;
}

export function parseWorkspaceCommandArgs(args: readonly string[]): WorkspaceCommand {
  const [operation, ...operationArgs] = args;
  if (operation === "exec") {
    const separator = operationArgs.indexOf("--");
    if (separator < 0) {
      throw usageError("workspace exec requires -- before COMMAND");
    }
    const controls = operationArgs.slice(0, separator);
    const commandArgs = operationArgs.slice(separator + 1);
    const { positionals, options } = parseOptions(controls, ["--cwd", "--timeout"]);
    if (positionals.length !== 1 || !positionals[0]) {
      throw usageError("workspace exec requires one workspace ID or name");
    }
    const command = commandArgs[0];
    if (!command) {
      throw usageError("workspace exec requires a command after --");
    }
    return {
      operation,
      workspace: positionals[0],
      cwd: options["--cwd"],
      timeoutMs: options["--timeout"] === undefined
        ? undefined
        : parseTimeout(options["--timeout"]),
      command,
      args: commandArgs.slice(1),
    };
  }

  if (operation === "download") {
    const { positionals, output, force } = parseDownloadOptions(operationArgs);
    if (positionals.length !== 2 || !positionals[0] || !positionals[1]) {
      throw usageError("workspace download requires a workspace ID or name and a remote path");
    }
    return {
      operation,
      workspace: positionals[0],
      remotePath: positionals[1],
      output,
      force,
    };
  }

  throw usageError("workspace command must be exec or download");
}

async function resolveWorkspaceAuth(input: WorkspaceCliContext): Promise<WorkspaceCliAuth> {
  const stored = await input.credentials.read();
  if (stored) {
    const refreshed = await refreshDeviceCredentials({
      credentials: stored,
      store: input.credentials,
      fetchFn: input.fetchFn,
    });
    if (refreshed) {
      return {
        baseUrl: refreshed.baseUrl,
        headers: getAuthorizedHeaders(refreshed),
        source: "device",
        accessToken: refreshed.accessToken,
      };
    }
  }

  const environmentAuth = resolveEnvironmentApiKeyAuth({
    envPrefix: input.envPrefix,
    environment: input.environment,
  });
  if (environmentAuth) {
    const headers = new Headers();
    headers.set("authorization", `Bearer ${environmentAuth.apiKey}`);
    return {
      baseUrl: environmentAuth.baseUrl,
      headers,
      source: "environment",
    };
  }

  const rawBaseUrl = input.environment[`${input.envPrefix}_BASE_URL`] ?? "http://localhost:3000";
  return {
    baseUrl: normalizeBaseUrl(rawBaseUrl),
    headers: new Headers(),
    source: "anonymous",
  };
}

async function fetchWorkspaceApi(
  input: WorkspaceCliContext,
  auth: WorkspaceCliAuth,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const send = () => input.fetchFn(new URL(path, `${auth.baseUrl}/`), {
    ...init,
    headers: new Headers({
      ...Object.fromEntries(auth.headers.entries()),
      ...Object.fromEntries(new Headers(init.headers).entries()),
    }),
  });
  let response = await send();
  if (response.status === 401 && auth.source === "device" && auth.accessToken) {
    const stored = await input.credentials.read();
    const refreshed = stored
      ? await refreshDeviceCredentials({
        credentials: stored,
        store: input.credentials,
        forceRefresh: { rejectedAccessToken: auth.accessToken },
        fetchFn: input.fetchFn,
      })
      : undefined;
    if (refreshed) {
      auth.headers = getAuthorizedHeaders(refreshed);
      auth.accessToken = refreshed.accessToken;
      response = await send();
    }
  }
  return response;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function responseErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (typeof record["message"] === "string") return record["message"];
    if (typeof record["error"] === "string") return record["error"];
  }
  if (typeof body === "string" && body.trim()) return body.trim();
  return fallback;
}

async function resolveWorkspace(
  input: WorkspaceCliContext,
  auth: WorkspaceCliAuth,
  reference: string,
  signal?: AbortSignal,
): Promise<WorkspaceSummary> {
  const response = await fetchWorkspaceApi(input, auth, "/api/workspaces", { signal });
  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(responseErrorMessage(body, `Unable to list workspaces (HTTP ${String(response.status)})`));
  }
  if (!Array.isArray(body)) {
    throw new Error("The workspace list response is invalid");
  }
  const workspaces = body.filter((value): value is WorkspaceSummary => (
    Boolean(value)
    && typeof value === "object"
    && typeof (value as Record<string, unknown>)["id"] === "string"
    && typeof (value as Record<string, unknown>)["name"] === "string"
  ));
  const idMatch = workspaces.find((workspace) => workspace.id === reference);
  if (idMatch) return idMatch;
  const nameMatches = workspaces.filter((workspace) => workspace.name === reference);
  if (nameMatches.length === 1) return nameMatches[0]!;
  if (nameMatches.length > 1) {
    throw new Error(`Workspace name is ambiguous: ${reference}`);
  }
  throw new Error(`Workspace not found: ${reference}`);
}

function writeCliOutput(output: { write(chunk: string): unknown }, text: string): void {
  if (text) {
    output.write(text);
  }
}

async function runWorkspaceExec(
  command: WorkspaceExecCommand,
  input: WorkspaceCliContext,
  output: WebAppCliCommandContext<ClankyCliContext>,
  signal?: AbortSignal,
): Promise<CliCommandResult> {
  const auth = await resolveWorkspaceAuth(input);
  const workspace = await resolveWorkspace(input, auth, command.workspace, signal);
  const response = await fetchWorkspaceApi(
    input,
    auth,
    `/api/workspaces/${encodeURIComponent(workspace.id)}/exec`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: command.command,
        args: command.args,
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      }),
      signal,
    },
  );
  const body = await readResponseBody(response);
  if (!response.ok) {
    return {
      exitCode: 1,
      error: responseErrorMessage(body, `Workspace command failed (HTTP ${String(response.status)})`),
    };
  }
  const parsed = WorkspaceExecResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { exitCode: 1, error: "The workspace exec response is invalid" };
  }
  if (parsed.data.success !== (parsed.data.exitCode === 0)) {
    return { exitCode: 1, error: "The workspace exec response is inconsistent" };
  }
  writeCliOutput(output.stdout, parsed.data.stdout);
  writeCliOutput(output.stderr, parsed.data.stderr);
  return {
    exitCode: parsed.data.success ? 0 : parsed.data.exitCode,
  };
}

function defaultDownloadPath(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, "");
  const name = pathPosix.basename(trimmed);
  if (!name || name === "." || name === "/") {
    throw new Error("A local output path is required for this remote path");
  }
  return name;
}

async function writeResponseStreamToFile(
  stream: ReadableStream<Uint8Array>,
  writer: Bun.FileSink,
): Promise<void> {
  const reader = stream.getReader();
  let ended = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
    await writer.end();
    ended = true;
  } finally {
    if (!ended) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original download failure when cancelling the response stream.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released after cancellation.
    }
    if (!ended) {
      await writer.end();
    }
  }
}

async function writeResponseStreamToOutput(
  stream: ReadableStream<Uint8Array>,
  output: BinaryCliOutput,
): Promise<void> {
  const reader = stream.getReader();
  let ended = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      const canContinue = await output.write(value);
      if (canContinue === false && output.once) {
        await new Promise<void>((resolve) => {
          output.once!("drain", resolve);
        });
      }
    }
  } finally {
    if (!ended) {
      try {
        await reader.cancel();
      } catch {
        // The response stream may already be closed when output writing fails.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released after cancellation.
    }
  }
}

async function runWorkspaceDownload(
  command: WorkspaceDownloadCommand,
  input: WorkspaceCliContext,
  output: WebAppCliCommandContext<ClankyCliContext>,
  signal?: AbortSignal,
): Promise<CliCommandResult> {
  const auth = await resolveWorkspaceAuth(input);
  const workspace = await resolveWorkspace(input, auth, command.workspace, signal);
  const localPath = command.output ?? defaultDownloadPath(command.remotePath);

  if (localPath !== "-" && !command.force && await Bun.file(localPath).exists()) {
    return {
      exitCode: 1,
      error: `Refusing to overwrite existing file: ${localPath} (use --force)`,
    };
  }

  const url = new URL(
    `/api/workspaces/${encodeURIComponent(workspace.id)}/files/download`,
    `${auth.baseUrl}/`,
  );
  url.searchParams.set("path", command.remotePath);
  const response = await fetchWorkspaceApi(input, auth, url.pathname + url.search, { signal });
  if (!response.ok) {
    const body = await readResponseBody(response);
    return {
      exitCode: 1,
      error: responseErrorMessage(body, `Workspace download failed (HTTP ${String(response.status)})`),
    };
  }
  if (!response.body) {
    return { exitCode: 1, error: "The workspace download response has no body" };
  }

  if (localPath === "-") {
    await writeResponseStreamToOutput(
      response.body,
      output.stdout as unknown as BinaryCliOutput,
    );
    return { exitCode: 0 };
  }

  const directory = dirname(localPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${localPath}.clanky-download-${randomUUID()}.tmp`;
  let moved = false;
  try {
    await writeResponseStreamToFile(response.body, Bun.file(temporaryPath).writer());
    await rename(temporaryPath, localPath);
    moved = true;
    return { exitCode: 0 };
  } finally {
    if (!moved) {
      await rm(temporaryPath, { force: true });
    }
  }
}

export async function runWorkspaceCommand(
  context: WebAppCliCommandContext<ClankyCliContext>,
): Promise<CliCommandResult> {
  const command = parseWorkspaceCommandArgs(context.args);
  const input: WorkspaceCliContext = {
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
    if (command.operation === "exec") {
      return await runWorkspaceExec(command, input, context, controller.signal);
    }
    return await runWorkspaceDownload(command, input, context, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      return { exitCode: 130, error: "Workspace operation was aborted" };
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

export function createWorkspaceCommand(): WebAppCliCommandDefinition<ClankyCliContext> {
  return {
    description: "Execute commands and download files from a workspace host.",
    usage: "workspace <exec|download> ...",
    handler: runWorkspaceCommand,
  };
}
