import { hostname } from "node:os";
import { sha256 } from "../server/auth/crypto";
import type { RouteCatalogEntry } from "../server/route-catalog";
import {
  readRuntimeConfig,
  safeRuntimeConfig,
} from "../server/runtime-config";
import {
  forceRefreshCliAuth,
  resolveCliAuth,
} from "./auth-resolution";
import { runApiCliCommand } from "./api-command";
import type {
  CreateWebAppCliOptions,
  WebAppCliCommandDefinition,
  WebAppCliCommandMap,
} from "./create-web-app-cli";
import {
  normalizeBaseUrl,
  runDeviceAuthCommand,
} from "./device-auth";
import {
  cliAuthEnvironmentNames,
  type CliEnvironment,
} from "./environment-auth";
import type { CliProfileStore } from "./profiles";
import { readOption, type CliCommandResult } from "./runtime";
import { runServerLogsCliCommand } from "./server-logs-command";
import { runServeCommand, serveCommandDescription, serveCommandUsage } from "./server-lifecycle";
import { updateCommand } from "./update-command";
import {
  runWebSocketCliCommand,
  type CliInput,
  type CliOutput,
} from "./websocket-command";

interface BuiltInCommandDependencies<TAppContext> {
  input: CreateWebAppCliOptions<TAppContext>;
  profiles: CliProfileStore;
  environment: CliEnvironment;
  fetchFn: typeof fetch;
  stdin: CliInput;
  stdout: CliOutput;
  stderr: CliOutput;
  realtimePath: string;
  routeCatalog(): Promise<readonly RouteCatalogEntry[]>;
  help(command?: string): string;
  commandExists(command: string): boolean;
}

function unexpectedArguments(
  command: string,
  args: readonly string[],
): CliCommandResult | undefined {
  if (args.length === 0) return undefined;
  return {
    exitCode: 1,
    error: `${command} does not accept arguments: ${args.join(" ")}`,
  };
}

function jsonOutput(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function statusOutput(text: string): {
  output: string;
  authenticated: boolean;
} {
  if (!text) return { output: "", authenticated: false };
  try {
    const parsed = JSON.parse(text) as unknown;
    const authenticated = Boolean(
      parsed
      && typeof parsed === "object"
      && (parsed as Record<string, unknown>)["authenticated"] === true,
    );
    return { output: jsonOutput(parsed), authenticated };
  } catch {
    return { output: text, authenticated: false };
  }
}

function validateAuthArgs(args: readonly string[]): string | undefined {
  const names = ["--base-url", "--client-id", "--scope"];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const exact = names.find((name) => arg === name);
    if (exact) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return `${exact} requires a value`;
      }
      index += 1;
      continue;
    }
    const assignment = names.find((name) => arg.startsWith(`${name}=`));
    if (assignment) {
      if (arg.length === assignment.length + 1) {
        return `${assignment} requires a value`;
      }
      continue;
    }
    return `Unknown auth option: ${arg}`;
  }
  return undefined;
}

function helpCommand<TAppContext>(
  dependencies: BuiltInCommandDependencies<TAppContext>,
): WebAppCliCommandDefinition<TAppContext> {
  return {
    description: "Show generated command help.",
    usage: "help [command]",
    handler: ({ args }) => {
      if (args.length > 1) {
        return { exitCode: 1, error: "help accepts at most one command name" };
      }
      const command = args[0];
      if (command && !dependencies.commandExists(command)) {
        return {
          exitCode: 1,
          error: `Unknown command: ${command}`,
          output: dependencies.help(),
        };
      }
      return { exitCode: 0, output: dependencies.help(command) };
    },
  };
}

function serveCommand<TAppContext>(
  input: CreateWebAppCliOptions<TAppContext>,
): WebAppCliCommandDefinition<TAppContext> {
  return {
    description: serveCommandDescription(input.serve?.options),
    usage: serveCommandUsage(),
    handler: async (context) => await runServeCommand(input, context),
  };
}

function versionCommand<TAppContext>(
  input: CreateWebAppCliOptions<TAppContext>,
): WebAppCliCommandDefinition<TAppContext> {
  return {
    description: "Print the application version.",
    usage: "version",
    handler: ({ args }) => unexpectedArguments("version", args) ?? {
      exitCode: 0,
      output: input.version,
    },
  };
}

function configCommand<TAppContext>(
  input: CreateWebAppCliOptions<TAppContext>,
): WebAppCliCommandDefinition<TAppContext> {
  return {
    description: "Print the resolved safe runtime configuration.",
    usage: "config",
    handler: async ({ args, environment }) => {
      const invalid = unexpectedArguments("config", args);
      if (invalid) return invalid;
      const value = input.config
        ? await input.config()
        : safeRuntimeConfig(readRuntimeConfig({
            appName: input.appName,
            envPrefix: input.envPrefix,
            appDirectoryName: input.appDirectoryName,
            environment,
          }));
      return { exitCode: 0, output: jsonOutput(value) };
    },
  };
}

function logsCommand<TAppContext>(
  dependencies: BuiltInCommandDependencies<TAppContext>,
): WebAppCliCommandDefinition<TAppContext> {
  return {
    description: "Retrieve the authenticated server log snapshot.",
    usage: "logs",
    handler: async ({ args, profile }) => {
      const invalid = unexpectedArguments("logs", args);
      if (invalid) return invalid;
      return await runServerLogsCliCommand({
        envPrefix: dependencies.input.envPrefix,
        credentials: dependencies.profiles.credentials(profile),
        environment: dependencies.environment,
        fetchFn: dependencies.fetchFn,
      });
    },
  };
}

function apiCommand<TAppContext>(
  dependencies: BuiltInCommandDependencies<TAppContext>,
  mode: "api" | "schema",
): WebAppCliCommandDefinition<TAppContext> {
  return {
    description: mode === "api"
      ? "List or call an application API route."
      : "Print schema metadata for an application API route.",
    usage: mode === "api"
      ? "api [endpoint] [--method METHOD] [--payload JSON]"
      : "schema [endpoint] [--method METHOD]",
    handler: async ({ args, profile }) => await runApiCliCommand({
      catalog: await dependencies.routeCatalog(),
      args,
      mode,
      envPrefix: dependencies.input.envPrefix,
      environment: dependencies.environment,
      credentials: dependencies.profiles.credentials(profile),
      fetchFn: dependencies.fetchFn,
    }),
  };
}

function defaultDeviceClientId(commandName: string): string {
  const clientId = `${commandName}-cli-${hostname()}`;
  return clientId.length <= 200 ? clientId : `cli-${sha256(clientId)}`;
}

function authCommand<TAppContext>(
  dependencies: BuiltInCommandDependencies<TAppContext>,
): WebAppCliCommandDefinition<TAppContext> {
  return {
    description: "Authenticate the selected profile with device authorization.",
    usage: "auth [--base-url URL] [--client-id ID] [--scope SCOPE]",
    handler: async ({ args, profile }) => {
      const invalid = validateAuthArgs(args);
      if (invalid) return { exitCode: 1, error: invalid };
      const credentials = dependencies.profiles.credentials(profile);
      const stored = await credentials.read();
      const names = cliAuthEnvironmentNames(dependencies.input.envPrefix);
      const baseUrl = readOption(args, ["--base-url"])
        ?? stored?.baseUrl
        ?? dependencies.environment[names.baseUrl];
      if (!baseUrl?.trim()) {
        return {
          exitCode: 1,
          error: `A base URL is required through --base-url or ${names.baseUrl}`,
        };
      }
      await runDeviceAuthCommand({
        baseUrl: normalizeBaseUrl(baseUrl),
        clientId: readOption(args, ["--client-id"])
          ?? dependencies.input.clientId
          ?? defaultDeviceClientId(dependencies.input.commandName),
        scope: readOption(args, ["--scope"]),
        store: credentials,
        fetchFn: dependencies.fetchFn,
        out: (message) => dependencies.stdout.write(`${message}\n`),
      });
      return { exitCode: 0 };
    },
  };
}

function statusCommand<TAppContext>(
  dependencies: BuiltInCommandDependencies<TAppContext>,
): WebAppCliCommandDefinition<TAppContext> {
  return {
    description: "Validate the selected profile or environment credentials.",
    usage: "status",
    handler: async ({ args, profile }) => {
      const invalid = unexpectedArguments("status", args);
      if (invalid) return invalid;
      const credentials = dependencies.profiles.credentials(profile);
      let auth = await resolveCliAuth({
        credentials,
        envPrefix: dependencies.input.envPrefix,
        environment: dependencies.environment,
        fetchFn: dependencies.fetchFn,
      });
      if (auth.source === "anonymous" || !auth.baseUrl) {
        return {
          exitCode: 1,
          error: "No authenticated CLI instance is configured",
        };
      }
      const rejectedAccessToken = auth.accessToken;
      const request = () => dependencies.fetchFn(
        `${auth.baseUrl}/api/auth/status`,
        { headers: auth.headers },
      );
      let response = await request();
      if (response.status === 401 && auth.source === "device" && rejectedAccessToken) {
        const refreshed = await forceRefreshCliAuth({
          credentials,
          rejectedAccessToken,
          fetchFn: dependencies.fetchFn,
        });
        if (refreshed) {
          auth = refreshed;
          response = await request();
        }
      }
      const result = statusOutput(await response.text());
      return {
        exitCode: response.ok && result.authenticated ? 0 : 1,
        output: result.output,
      };
    },
  };
}

function profileCommand<TAppContext>(
  profiles: CliProfileStore,
): WebAppCliCommandDefinition<TAppContext> {
  return {
    description: "List, select, or remove CLI credential profiles.",
    usage: "profile <list|use NAME|remove NAME>",
    handler: async ({ args }) => {
      const [action = "list", name, ...rest] = args;
      if (rest.length > 0) {
        return { exitCode: 1, error: "Too many profile arguments" };
      }
      if (action === "list") {
        if (name) {
          return {
            exitCode: 1,
            error: "profile list does not accept a name",
          };
        }
        const listed = await profiles.list();
        return {
          exitCode: 0,
          output: listed.map((profile) => (
            `${profile.current ? "*" : " "} ${profile.name}${profile.baseUrl ? `\t${profile.baseUrl}` : ""}`
          )).join("\n"),
        };
      }
      if (!name) {
        return {
          exitCode: 1,
          error: `profile ${action} requires a profile name`,
        };
      }
      if (action === "use") {
        await profiles.use(name);
        return { exitCode: 0, output: `Using profile ${name}` };
      }
      if (action === "remove") {
        const removed = await profiles.remove(name);
        return removed
          ? { exitCode: 0, output: `Removed profile ${name}` }
          : { exitCode: 1, error: `Unknown profile: ${name}` };
      }
      return {
        exitCode: 1,
        error: `Unknown profile command: ${action}`,
      };
    },
  };
}

function websocketCommand<TAppContext>(
  dependencies: BuiltInCommandDependencies<TAppContext>,
): WebAppCliCommandDefinition<TAppContext> {
  return {
    description: "Bridge JSON lines on stdin to the authenticated realtime WebSocket.",
    usage: "ws",
    handler: async ({ args, profile }) => {
      const invalid = unexpectedArguments("ws", args);
      if (invalid) return invalid;
      return await runWebSocketCliCommand({
        credentials: dependencies.profiles.credentials(profile),
        envPrefix: dependencies.input.envPrefix,
        environment: dependencies.environment,
        fetchFn: dependencies.fetchFn,
        realtimePath: dependencies.realtimePath,
        input: dependencies.stdin,
        output: dependencies.stdout,
        createWebSocket: dependencies.input.webSocketFactory,
        signals: dependencies.input.signals,
      });
    },
  };
}

export function createBuiltInCommands<TAppContext>(
  dependencies: BuiltInCommandDependencies<TAppContext>,
): WebAppCliCommandMap<TAppContext> {
  return {
    help: helpCommand(dependencies),
    serve: serveCommand(dependencies.input),
    version: versionCommand(dependencies.input),
    config: configCommand(dependencies.input),
    update: updateCommand(dependencies),
    logs: logsCommand(dependencies),
    api: apiCommand(dependencies, "api"),
    schema: apiCommand(dependencies, "schema"),
    auth: authCommand(dependencies),
    status: statusCommand(dependencies),
    profile: profileCommand(dependencies.profiles),
    ws: websocketCommand(dependencies),
  };
}
