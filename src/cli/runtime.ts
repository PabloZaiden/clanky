import { startServer } from "../server";
import { formatRalpherVersion } from "../version";
import {
  DEFAULT_CLIENT_ID,
  getAuthorizedHeaders,
  getValidatedCredentials,
  normalizeBaseUrlValue,
  normalizeCookieHeaderValue,
  refreshStoredCredentials,
  runAuthCommand,
  runStatusCommand,
  type AuthCommandOptions,
  type StatusCommandOptions,
  type StoredCliCredentials,
} from "./auth";
import {
  findApiEndpoint,
  formatSchema,
  listApiEndpoints,
  normalizeApiEndpointPath,
} from "./api-catalog";

const CLI_USAGE = [
  "Usage:",
  "  ralpher web",
  "  ralpher version",
  "  ralpher auth <base-url> [--client-id <client-id>] [--cookies <cookie-header>]",
  "  ralpher status [base-url]",
  "  ralpher api",
  "  ralpher api <endpoint> [--method <method>] [--payload <json>]",
  "  ralpher schema <endpoint>",
].join("\n");
const CLI_HELP = [formatRalpherVersion(), "", CLI_USAGE].join("\n");

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

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
    action: "web";
  }
  | {
    action: "version";
  }
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
  };

export type MainCommand = CliCommand;

export interface CliRuntimeDependencies extends CliOutputDependencies {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  startServerFn?: typeof startServer;
  runCliFn?: typeof runCli;
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

function parseCommandArguments(
  args: string[],
  allowedOptions: string[],
): { positionals: string[]; options: Record<string, string> } {
  const positionals: string[] = [];
  const options: Record<string, string> = {};

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
    if (!allowedOptions.includes(name)) {
      throw createUsageError(`Unknown option: ${name}`);
    }

    const value = inlineValue ?? args[index + 1];
    options[name] = parseOptionValue(name, value);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return { positionals, options };
}

function formatApiResponseBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  return JSON.stringify(body, null, 2);
}

function getResponseStatusLabel(response: Response): string {
  const statusText = response.statusText || (response.ok ? "OK" : "");
  return `Status: ${response.status} ${statusText}`.trimEnd();
}

function printApiEndpoints(out: (message: string) => void): void {
  const entries = listApiEndpoints();
  for (const entry of entries) {
    const description = entry.description ? ` - ${entry.description}` : "";
    out(`${entry.methods.join(", ")} ${entry.path}${description}`);
  }
}

async function readApiResponse(response: Response): Promise<{ body?: unknown; text?: string }> {
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

  let credentials = await getValidatedCredentials({}, dependencies);
  if (!credentials) {
    out("Not logged in.");
    return 1;
  }

  const requestHeaders = getAuthorizedHeaders(credentials);
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

  const sendRequest = async (activeCredentials: StoredCliCredentials): Promise<Response> => {
    const requestUrl = `${activeCredentials.baseUrl}${endpointPath}`;
    const headers = getAuthorizedHeaders(activeCredentials, requestHeaders);
    headers.set("origin", activeCredentials.baseUrl);
    return await dependencies.fetchFn(requestUrl, {
      method: command.method,
      headers,
      body: requestBody,
    });
  };

  let response = await sendRequest(credentials);
  if (response.status === 401) {
    const refreshedCredentials = await refreshStoredCredentials(credentials, dependencies);
    if (!refreshedCredentials) {
      out("Stored credentials are invalid.");
      return 1;
    }
    credentials = refreshedCredentials;
    response = await sendRequest(credentials);
  }

  const parsed = await readApiResponse(response);
  out(getResponseStatusLabel(response));
  if (parsed.body !== undefined) {
    out(formatApiResponseBody(parsed.body));
  } else if (parsed.text !== undefined) {
    out(parsed.text);
  }
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

export function parseCliCommand(args: string[]): CliCommand {
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

  if (action === "web") {
    const { positionals } = parseCommandArguments(restArgs, []);
    if (positionals.length > 0) {
      throw createUsageError(`Unexpected argument: ${positionals[0]}`);
    }
    return { action };
  }

  if (action === "version") {
    const { positionals } = parseCommandArguments(restArgs, []);
    if (positionals.length > 0) {
      throw createUsageError(`Unexpected argument: ${positionals[0]}`);
    }
    return { action };
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
      clientId: options["--client-id"]?.trim() || DEFAULT_CLIENT_ID,
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
    const command = parseCliCommand(args);
    switch (command.action) {
      case "help":
        out(CLI_HELP);
        return command.exitCode;
      case "web":
        await startServerFn();
        return undefined;
      case "version":
        out(formatRalpherVersion());
        return 0;
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
