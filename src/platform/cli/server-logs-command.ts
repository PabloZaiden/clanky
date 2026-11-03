import type { RouteCatalogEntry } from "../server/route-catalog";
import { runApiCliCommand, type ApiCliCredentialsStore } from "./api-command";
import { resolveEnvironmentApiKeyAuth, type CliEnvironment } from "./environment-auth";
import type { CliCommandResult } from "./runtime";

const serverLogsRoute: RouteCatalogEntry = {
  path: "/api/server/logs",
  cliPath: "logs",
  methods: ["GET"],
  auth: "admin",
  sameOrigin: "never",
  scopes: [],
  description: "Retrieve the temporary server log snapshot.",
  tags: ["server"],
};

export interface ServerLogsCliCommandOptions {
  envPrefix: string;
  credentials?: ApiCliCredentialsStore;
  environment?: CliEnvironment;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

export async function runServerLogsCliCommand(input: ServerLogsCliCommandOptions): Promise<CliCommandResult> {
  const storedCredentials = await input.credentials?.read();
  const environmentAuth = resolveEnvironmentApiKeyAuth({
    envPrefix: input.envPrefix,
    environment: input.environment,
  });
  if (!storedCredentials && !environmentAuth) {
    return {
      exitCode: 1,
      error: "No authenticated CLI instance is configured",
    };
  }
  return await runApiCliCommand({
    catalog: [serverLogsRoute],
    args: ["logs"],
    responseFormat: "body",
    credentials: input.credentials,
    envPrefix: input.envPrefix,
    environment: input.environment,
    fetchFn: input.fetchFn,
    now: input.now,
  });
}
