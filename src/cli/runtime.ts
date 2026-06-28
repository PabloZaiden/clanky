import { hostname } from "os";
import { startServer } from "../server";
import { formatClankyVersion, CLANKY_VERSION } from "../version";
import {
  getCliRequestAuthContext,
  getAuthorizedHeaders,
  normalizeBaseUrlValue,
  normalizeCookieHeaderValue,
  refreshStoredCredentials,
  runAuthCommand,
  runStatusCommand,
  type AuthCommandOptions,
  type StatusCommandOptions,
  type CliRequestAuthContext,
} from "./auth";
import {
  findApiEndpoint,
  formatSchema,
  listApiEndpoints,
  normalizeApiEndpointPath,
} from "./api-catalog";
import { runUpdateCommand, type CliUpdateDependencies, type UpdateCommandOptions } from "./update";
import { runWsCommand, type CliWsDependencies, type WsCommandOptions } from "./ws";
import { runPreviewCommand, type CliPreviewDependencies, type PreviewCommandOptions } from "./preview";

type CliHelpEntry = {
  name: string;
  description: string;
  usage: string[];
};

const CLI_HELP_ENTRIES: CliHelpEntry[] = [
  {
    name: "help",
    description: "Show the CLI help and available commands.",
    usage: ["clanky help"],
  },
  {
    name: "serve",
    description: "Start the Clanky web/API server.",
    usage: ["clanky serve"],
  },
  {
    name: "version",
    description: "Print the current clanky version.",
    usage: ["clanky version"],
  },
  {
    name: "update",
    description: "Check for or install newer Clanky release binaries.",
    usage: ["clanky update [--check] [--version <version>]"],
  },
  {
    name: "auth",
    description: "Authenticate against a Clanky server and store credentials.",
    usage: ["clanky auth <base-url> [--client-id <client-id>] [--cookies <cookie-header>]"],
  },
  {
    name: "status",
    description: "Show the current authentication status for a server.",
    usage: ["clanky status [base-url]"],
  },
  {
    name: "api",
    description: "List API endpoints or send an authenticated API request.",
    usage: [
      "clanky api",
      "clanky api <endpoint> [--method <method>] [--payload <json>]",
    ],
  },
  {
    name: "schema",
    description: "Show the request schema metadata for an API endpoint.",
    usage: ["clanky schema <endpoint>"],
  },
  {
    name: "ws",
    description: "Stream live WebSocket events for tasks, chats, SSH, or provisioning.",
    usage: [
      "clanky ws [base-url] [--task-id <id>] [--chat-id <id>] [--ssh-session-id <id>] [--ssh-server-session-id <id>] [--provisioning-job-id <id>]",
    ],
  },
  {
    name: "preview",
    description: "Start a local CLI-owned live preview for a workspace service.",
    usage: [
      "clanky preview --workspace <id-or-name> --port <remote-port> [--remote-host <host>] [--host <local-host>] [--local-port <port>] [--path <path>] [--open]",
    ],
  },
];

const CLI_USAGE = [
  "Usage:",
  ...CLI_HELP_ENTRIES.flatMap((entry) => entry.usage.map((usageLine) => `  ${usageLine}`)),
].join("\n");

const CLI_COMMAND_WIDTH = CLI_HELP_ENTRIES.reduce(
  (maxWidth, entry) => Math.max(maxWidth, entry.name.length),
  0,
);

const CLI_COMMANDS = [
  "Commands:",
  ...CLI_HELP_ENTRIES.map((entry) => `  ${entry.name.padEnd(CLI_COMMAND_WIDTH)} ${entry.description}`),
].join("\n");
const CLI_HELP = [formatClankyVersion("clanky"), "", CLI_USAGE, "", CLI_COMMANDS].join("\n");

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const DEFAULT_CLIENT_ID = "clanky";

type CliOutputDependencies = {
  out?: (message: string) => void;
  err?: (message: string) => void;
};

export type CliCommand =
  | {
    action: "help";
    exitCode: number;
  }
  | {
      action: "serve";
    }
  | {
      action: "version";
    }
  | ({
      action: "update";
    } & UpdateCommandOptions)
  | ({
      action: "auth";
    } & AuthCommandOptions)
  | ({
    action: "status";
  } & StatusCommandOptions)
  | {
    action: "api";
    endpoint?: string;
    method: string;
    payload?: string;
  }
  | {
     action: "schema";
     endpoint: string;
   }
  | ({
      action: "ws";
    } & WsCommandOptions)
  | ({
      action: "preview";
    } & PreviewCommandOptions);

export type MainCommand = CliCommand;

export interface CliRuntimeDependencies extends CliOutputDependencies {
  fetchFn?: typeof fetch;
  getHostname?: () => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  startServerFn?: () => Promise<unknown>;
  runCliFn?: typeof runCli;
  updateDependencies?: Partial<CliUpdateDependencies>;
  wsDependencies?: Partial<CliWsDependencies>;
  previewDependencies?: Partial<CliPreviewDependencies>;
}

interface CliParseDependencies {
  getHostname?: () => string;
}

function createUsageError(message: string): Error {
  return new Error(`${message}\n\n${CLI_USAGE}`);
}

function isHelpToken(value?: string): boolean {
  return value === "help" || value === "--help" || value === "-h";
}

function parseOptionValue(option: string, rawValue?: string): string {
  if (!rawValue?.trim() || rawValue.startsWith("--")) {
    throw createUsageError(`Missing value for ${option}`);
  }
  return rawValue.trim();
}

function getDefaultClientId(getHostname: () => string = hostname): string {
  const localHostname = getHostname().trim();
  return localHostname || DEFAULT_CLIENT_ID;
}

function parsePortOption(name: string, value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw createUsageError(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

function normalizePreviewPathOption(value: string | undefined): string {
  const trimmed = value?.trim() || "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseCommandArguments(
  args: string[],
  allowedOptions: string[],
  allowedFlags: string[] = [],
): { positionals: string[]; options: Record<string, string>; flags: Set<string> } {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawName, inlineValue] = arg.split("=", 2);
    const name = rawName ?? arg;
    if (allowedFlags.includes(name)) {
      if (inlineValue !== undefined) {
        throw createUsageError(`Option does not take a value: ${name}`);
      }
      flags.add(name);
      continue;
    }
    if (!allowedOptions.includes(name)) {
      throw createUsageError(`Unknown option: ${name}`);
    }

    const value = inlineValue ?? args[index + 1];
    options[name] = parseOptionValue(name, value);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return { positionals, options, flags };
}

type ParsedApiResponse = {
  body?: unknown;
  text?: string;
};

type ApiCommandOutput = {
  status: {
    code: number;
    text: string;
    ok: boolean;
  };
  response: unknown;
};

function getResponseStatusText(response: Response): string {
  return response.statusText || (response.ok ? "OK" : "");
}

function formatApiCommandOutput(response: Response, parsed: ParsedApiResponse): string {
  const output: ApiCommandOutput = {
    status: {
      code: response.status,
      text: getResponseStatusText(response),
      ok: response.ok,
    },
    response: parsed.body ?? parsed.text ?? null,
  };
  return JSON.stringify(output, null, 2);
}

function printApiEndpoints(out: (message: string) => void): void {
  const entries = listApiEndpoints();
  for (const entry of entries) {
    const description = entry.description ? ` - ${entry.description}` : "";
    const cliPath = entry.cliPath ?? entry.path.replace(/^\/api\//, "");
    out(`${entry.methods.join(", ")} ${cliPath}${description}`);
  }
}

async function readApiResponse(response: Response): Promise<ParsedApiResponse> {
  const rawBody = await response.text();
  if (!rawBody) {
    return {};
  }

  try {
    return {
      body: JSON.parse(rawBody) as unknown,
    };
  } catch {
    return {
      text: rawBody,
    };
  }
}

async function runApiCommand(
  command: Extract<CliCommand, { action: "api" }>,
  dependencies: Required<Pick<CliRuntimeDependencies, "fetchFn" | "now">> & CliOutputDependencies,
): Promise<number> {
  const out = dependencies.out ?? console.log;
  if (!command.endpoint) {
    printApiEndpoints(out);
    return 0;
  }

  const endpointPath = normalizeApiEndpointPath(command.endpoint);
  if (!findApiEndpoint(endpointPath)) {
    out(`Unknown API endpoint: ${endpointPath}`);
    return 1;
  }

  let authContext = await getCliRequestAuthContext({}, dependencies);
  if (!authContext) {
    out("Not logged in.");
    return 1;
  }

  const requestHeaders = authContext.kind === "bearer"
    ? getAuthorizedHeaders(authContext.credentials)
    : new Headers();
  let requestBody: string | undefined;
  if (command.payload !== undefined) {
    try {
      requestBody = JSON.stringify(JSON.parse(command.payload) as unknown);
    } catch {
      throw createUsageError("Invalid JSON for --payload");
    }
    requestHeaders.set("content-type", "application/json");
  }
  requestHeaders.set("accept", "application/json");

  const sendRequest = async (activeAuthContext: CliRequestAuthContext): Promise<Response> => {
    const requestUrl = `${activeAuthContext.baseUrl}${endpointPath}`;
    const headers = activeAuthContext.kind === "bearer"
      ? getAuthorizedHeaders(activeAuthContext.credentials, requestHeaders)
      : new Headers(requestHeaders);
    headers.set("origin", activeAuthContext.baseUrl);
    return await dependencies.fetchFn(requestUrl, {
      method: command.method,
      headers,
      body: requestBody,
    });
  };

  let response = await sendRequest(authContext);
  if (response.status === 401 && authContext.kind === "bearer") {
    const refreshedCredentials = await refreshStoredCredentials(authContext.credentials, dependencies);
    if (!refreshedCredentials) {
      out("Stored credentials are invalid.");
      return 1;
    }
    authContext = {
      kind: "bearer",
      credentials: refreshedCredentials,
      baseUrl: refreshedCredentials.baseUrl,
    };
    response = await sendRequest(authContext);
  }

  const parsed = await readApiResponse(response);
  out(formatApiCommandOutput(response, parsed));
  return response.ok ? 0 : 1;
}

function runSchemaCommand(
  command: Extract<CliCommand, { action: "schema" }>,
  dependencies: CliOutputDependencies,
): number {
  const out = dependencies.out ?? console.log;
  const entry = findApiEndpoint(command.endpoint);
  if (!entry) {
    out(`Unknown API endpoint: ${normalizeApiEndpointPath(command.endpoint)}`);
    return 1;
  }

  out(`Endpoint: ${entry.path}`);
  out(`Methods: ${entry.methods.join(", ")}`);
  if (entry.description) {
    out(`Description: ${entry.description}`);
  }
  if (entry.querySchema) {
    out("Query schema:");
    out(formatSchema(entry.querySchema));
  }
  if (entry.requestSchema) {
    out("Request body schema:");
    out(formatSchema(entry.requestSchema));
  }
  if (!entry.querySchema && !entry.requestSchema) {
    out("No request or query schema metadata is currently available for this endpoint.");
  }
  return 0;
}

export function parseCliCommand(args: string[], dependencies: CliParseDependencies = {}): CliCommand {
  const [action, ...restArgs] = args;
  if (!action) {
    return {
      action: "help",
      exitCode: 1,
    };
  }

  if (isHelpToken(action)) {
    return {
      action: "help",
      exitCode: 0,
    };
  }

  if (action === "version") {
    const { positionals } = parseCommandArguments(restArgs, []);
    if (positionals.length > 0) {
      throw createUsageError(`Unexpected argument: ${positionals[0]}`);
    }
    return { action };
  }

  if (action === "serve") {
    const { positionals } = parseCommandArguments(restArgs, []);
    if (positionals.length > 0) {
      throw createUsageError(`Unexpected argument: ${positionals[0]}`);
    }
    return { action };
  }

  if (action === "update") {
    const { positionals, options, flags } = parseCommandArguments(restArgs, ["--version"], ["--check"]);
    if (positionals.length > 0) {
      throw createUsageError(`Unexpected argument: ${positionals[0]}`);
    }
    if (flags.has("--check") && options["--version"]) {
      throw createUsageError("Cannot combine --check with --version");
    }
    return {
      action,
      checkOnly: flags.has("--check"),
      version: options["--version"]?.trim(),
    };
  }

  if (action === "auth") {
    const { positionals, options } = parseCommandArguments(restArgs, ["--client-id", "--cookies"]);
    if (positionals.length === 0) {
      throw createUsageError("Missing base URL argument for auth");
    }
    if (positionals.length > 1) {
      throw createUsageError(`Unexpected argument: ${positionals[1]}`);
    }
    let baseUrl: string;
    let cookies: string | undefined;
    try {
      baseUrl = normalizeBaseUrlValue(positionals[0]!);
      cookies = normalizeCookieHeaderValue(options["--cookies"]);
    } catch (error) {
      throw createUsageError(String(error).replace(/^Error:\s*/, ""));
    }
    return {
      action,
      baseUrl,
      clientId: options["--client-id"]?.trim() || getDefaultClientId(dependencies.getHostname),
      cookies,
    };
  }

  if (action === "status") {
    const { positionals } = parseCommandArguments(restArgs, []);
    if (positionals.length > 1) {
      throw createUsageError(`Unexpected argument: ${positionals[1]}`);
    }
    let baseUrl: string | undefined;
    try {
      baseUrl = positionals[0] ? normalizeBaseUrlValue(positionals[0]) : undefined;
    } catch (error) {
      throw createUsageError(String(error).replace(/^Error:\s*/, ""));
    }
    return {
      action,
      baseUrl,
    };
  }

  if (action === "api") {
    const { positionals, options } = parseCommandArguments(restArgs, ["--method", "--payload"]);
    if (positionals.length > 1) {
      throw createUsageError(`Unexpected argument: ${positionals[1]}`);
    }
    const method = options["--method"]?.trim().toUpperCase() || "GET";
    if (!HTTP_METHODS.has(method)) {
      throw createUsageError(`Unknown HTTP method: ${method}`);
    }
    return {
      action,
      endpoint: positionals[0] ? normalizeApiEndpointPath(positionals[0]) : undefined,
      method,
      payload: options["--payload"],
    };
  }

  if (action === "schema") {
    const { positionals } = parseCommandArguments(restArgs, []);
    if (positionals.length === 0) {
      throw createUsageError("Missing API endpoint argument for schema");
    }
    if (positionals.length > 1) {
      throw createUsageError(`Unexpected argument: ${positionals[1]}`);
    }
    return {
      action,
      endpoint: normalizeApiEndpointPath(positionals[0]!),
    };
  }

  if (action === "ws") {
    const { positionals, options } = parseCommandArguments(restArgs, [
      "--task-id",
      "--chat-id",
      "--ssh-session-id",
      "--ssh-server-session-id",
      "--provisioning-job-id",
    ]);
    if (positionals.length > 1) {
      throw createUsageError(`Unexpected argument: ${positionals[1]}`);
    }

    let baseUrl: string | undefined;
    try {
      baseUrl = positionals[0] ? normalizeBaseUrlValue(positionals[0]) : undefined;
    } catch (error) {
      throw createUsageError(String(error).replace(/^Error:\s*/, ""));
    }

    return {
      action,
      baseUrl,
      taskId: options["--task-id"]?.trim(),
      chatId: options["--chat-id"]?.trim(),
      sshSessionId: options["--ssh-session-id"]?.trim(),
      sshServerSessionId: options["--ssh-server-session-id"]?.trim(),
      provisioningJobId: options["--provisioning-job-id"]?.trim(),
    };
  }

  if (action === "preview") {
    const { positionals, options, flags } = parseCommandArguments(restArgs, [
      "--workspace",
      "--port",
      "--remote-host",
      "--host",
      "--local-port",
      "--path",
      "--base-url",
    ], ["--open"]);
    if (positionals.length > 0) {
      throw createUsageError(`Unexpected argument: ${positionals[0]}`);
    }
    const workspace = options["--workspace"]?.trim();
    if (!workspace) {
      throw createUsageError("Missing required option: --workspace");
    }
    const rawPort = options["--port"]?.trim();
    if (!rawPort) {
      throw createUsageError("Missing required option: --port");
    }
    let baseUrl: string | undefined;
    try {
      baseUrl = options["--base-url"] ? normalizeBaseUrlValue(options["--base-url"]) : undefined;
    } catch (error) {
      throw createUsageError(String(error).replace(/^Error:\s*/, ""));
    }
    return {
      action,
      baseUrl,
      workspace,
      port: parsePortOption("--port", rawPort),
      remoteHost: options["--remote-host"]?.trim() || "127.0.0.1",
      host: options["--host"]?.trim() || "127.0.0.1",
      localPort: options["--local-port"] ? parsePortOption("--local-port", options["--local-port"]) : undefined,
      path: normalizePreviewPathOption(options["--path"]),
      open: flags.has("--open"),
    };
  }

  throw createUsageError(`Unknown command: ${action}`);
}

export function parseMainCommand(args: string[]): MainCommand {
  return parseCliCommand(args);
}

export async function runCli(
  args: string[],
  dependencies: CliRuntimeDependencies = {},
): Promise<number | undefined> {
  const fetchFn = dependencies.fetchFn ?? fetch;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? (() => new Date());
  const out = dependencies.out ?? console.log;
  const err = dependencies.err ?? console.error;
  const startServerFn = dependencies.startServerFn ?? startServer;

  try {
    const command = parseCliCommand(args, {
      getHostname: dependencies.getHostname,
    });
    switch (command.action) {
      case "help":
        out(CLI_HELP);
        return command.exitCode;
      case "version":
        out(formatClankyVersion("clanky"));
        return 0;
      case "serve":
        await startServerFn();
        return undefined;
      case "update":
        return await runUpdateCommand(command, {
          fetchFn,
          out,
          err,
          currentVersion: CLANKY_VERSION,
          ...dependencies.updateDependencies,
        });
      case "auth":
        return await runAuthCommand(command, {
          fetchFn,
          sleep,
          out,
          now,
        });
      case "status":
        return await runStatusCommand(command, {
          fetchFn,
          out,
          now,
        });
      case "api":
        return await runApiCommand(command, {
          fetchFn,
          now,
          out,
        });
      case "schema":
        return runSchemaCommand(command, {
          out,
        });
      case "ws":
        return await runWsCommand(command, {
          fetchFn,
          now,
          out,
          err,
          ...dependencies.wsDependencies,
        });
      case "preview":
        return await runPreviewCommand(command, {
          fetchFn,
          now,
          out,
          err,
          getHostname: dependencies.getHostname,
          ...dependencies.previewDependencies,
        });
    }
  } catch (error) {
    err(String(error));
    return 1;
  }
}

export async function runMain(
  args: string[],
  dependencies: CliRuntimeDependencies = {},
): Promise<number | undefined> {
  const runCliFn = dependencies.runCliFn ?? runCli;
  return await runCliFn(args, dependencies);
}
