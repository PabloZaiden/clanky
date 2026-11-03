import { findRouteCatalogEntry, resolveRouteOperation, type RouteCatalogEntry } from "../server/route-catalog";
import { routeSchemaToJsonSchema } from "@pablozaiden/webapp/server";
import type { HttpMethod, RouteOperationMetadata } from "../server/routes";
import {
  forceRefreshCliAuth,
  resolveCliAuth,
  type CliAuthSource,
} from "./auth-resolution";
import type {
  DeviceCredentialsStore,
  StoredDeviceCredentials,
} from "./device-auth";
import type { CliEnvironment } from "./environment-auth";
import { readOption, type CliCommandResult } from "./runtime";
import { readResponseMetadata } from "@pablozaiden/webapp/contracts";

export type ApiCliCredentialsStore = DeviceCredentialsStore & {
  read(): Promise<StoredDeviceCredentials | undefined>;
};

export interface ApiCliCommandOptions {
  catalog: readonly RouteCatalogEntry[];
  args: string[];
  mode?: "api" | "schema";
  baseUrl?: string;
  responseFormat?: "envelope" | "body";
  credentials?: ApiCliCredentialsStore;
  envPrefix?: string;
  environment?: CliEnvironment;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

function listOutput(catalog: readonly RouteCatalogEntry[]): string {
  return catalog
    .filter((entry) => entry.path.startsWith("/api/"))
    .map((entry) => `${entry.methods.join(", ")} ${entry.cliPath}${entry.description ? ` - ${entry.description}` : ""}`)
    .join("\n");
}

function operationSchemaOutput(operation: RouteOperationMetadata) {
  return {
    description: operation.description,
    querySchema: routeSchemaToJsonSchema(operation.querySchema),
    requestSchema: routeSchemaToJsonSchema(operation.requestSchema),
    responseSchema: routeSchemaToJsonSchema(operation.responseSchema, { io: "output" }),
    automation: operation.automation,
    delegation: operation.delegation,
    partialResults: operation.partialResults,
  };
}

function schemaOutput(entry: RouteCatalogEntry, method?: HttpMethod): string {
  const metadata = method ? resolveRouteOperation(entry, method) : entry;
  return JSON.stringify({
    path: entry.path,
    cliPath: entry.cliPath,
    methods: entry.methods,
    auth: entry.auth,
    sameOrigin: entry.sameOrigin,
    scopes: entry.scopes,
    tags: entry.tags,
    ...operationSchemaOutput(metadata),
    ...(method ? { method } : {}),
    operations: Object.fromEntries((method ? [method] : entry.methods).map((availableMethod) => [
      availableMethod,
      operationSchemaOutput(resolveRouteOperation(entry, availableMethod)),
    ])),
  }, null, 2);
}

function endpointArg(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("--"));
}

function hasMissingOptionValue(args: readonly string[], names: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    for (const name of names) {
      if (arg === name) {
        const value = args[index + 1];
        if (!value?.trim() || value.startsWith("-")) {
          return true;
        }
      } else if (arg.startsWith(`${name}=`) && !arg.slice(name.length + 1).trim()) {
        return true;
      }
    }
  }
  return false;
}

interface ResolvedApiCliAuth {
  headers: Headers;
  source: CliAuthSource;
  baseUrl?: string;
  accessToken?: string;
}

async function resolveAuth(input: ApiCliCommandOptions): Promise<ResolvedApiCliAuth> {
  const auth = await resolveCliAuth({
    credentials: input.credentials,
    envPrefix: input.envPrefix,
    environment: input.environment,
    explicitBaseUrl: input.baseUrl,
    fetchFn: input.fetchFn,
    now: input.now,
  });
  auth.headers.set("accept", "application/json");
  return auth;
}

export async function runApiCliCommand(input: ApiCliCommandOptions): Promise<CliCommandResult> {
  const methodOptions = ["--method", "-X"];
  if (hasMissingOptionValue(input.args, methodOptions)) {
    return { exitCode: 1, error: "Option --method/-X requires a value" };
  }
  const endpoint = endpointArg(input.args);
  if (!endpoint) {
    return { exitCode: 0, output: listOutput(input.catalog) };
  }
  const match = findRouteCatalogEntry(input.catalog, endpoint);
  if (!match) {
    return { exitCode: 1, error: `Unknown API endpoint: ${endpoint}` };
  }
  const methodOption = readOption(input.args, methodOptions);
  const method = (methodOption ?? match.entry.methods[0] ?? "GET").toUpperCase();
  if (!match.entry.methods.includes(method as never)) {
    return { exitCode: 1, error: `Method ${method} is not available for ${match.entry.cliPath}` };
  }
  if (input.mode === "schema") {
    try {
      return { exitCode: 0, output: schemaOutput(match.entry, methodOption ? method as HttpMethod : undefined) };
    } catch (error) {
      return { exitCode: 1, error: `Cannot represent schemas for ${match.entry.cliPath}: ${String(error)}` };
    }
  }
  const payload = readOption(input.args, ["--payload", "--data", "-d"]);
  const auth = await resolveAuth(input);
  const baseUrl = (input.baseUrl ?? auth.baseUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${match.path}`);
  const headers = auth.headers;
  const rejectedAccessToken = auth.accessToken;
  let body: string | undefined;
  if (payload !== undefined) {
    JSON.parse(payload) as unknown;
    body = payload;
    headers.set("content-type", "application/json");
  }
  const send = () => (input.fetchFn ?? fetch)(url, { method, headers, body });
  let response = await send();
  if (
    response.status === 401 &&
    auth.source === "device" &&
    input.credentials &&
    rejectedAccessToken
  ) {
    const refreshed = await forceRefreshCliAuth({
      credentials: input.credentials,
      rejectedAccessToken,
      fetchFn: input.fetchFn,
      now: input.now,
    });
    if (refreshed) {
      headers.set("authorization", refreshed.headers.get("authorization")!);
      response = await send();
    }
  }
  const text = await response.text();
  const { partial } = readResponseMetadata(response, resolveRouteOperation(match.entry, method as HttpMethod).partialResults);
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) as unknown : null;
  } catch {
    parsed = text || null;
  }
  const output = input.responseFormat === "body"
    ? text
    : JSON.stringify({
      status: { code: response.status, ok: response.ok, text: response.statusText },
      ...(partial ? { partial: true } : {}),
      response: parsed,
    }, null, 2);
  return {
    exitCode: response.ok && !partial ? 0 : 1,
    output: output ?? "",
  };
}
