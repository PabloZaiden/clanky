import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  WEB_APP_CONFIG_VERSION,
  parsePort,
  parseWebAppPersistedConfig,
  readRuntimeConfig,
  readWebAppConfig,
  resolveAppDataDir,
  resolveAppDirectoryName,
  safeRuntimeConfig,
  type RuntimeConfig,
  type RuntimeEnvironment,
  type WebAppPersistedConfig,
} from "../server/runtime-config";
import type {
  CreateWebAppCliOptions,
  WebAppCliCommandContext,
  WebAppServerCommand,
} from "./create-web-app-cli";
import { createJsonFileStore, type JsonFileStore } from "./credentials";
import type { CliEnvironment } from "./environment-auth";
import type { CliCommandResult } from "./runtime";
import { createServerProcessPlatform } from "./server-process-platform";
import {
  securePrivateChildDirectory,
  securePrivateChildFile,
} from "@pablozaiden/webapp/server";
import {
  applyServeOptionsToEnvironment,
  parseServeOptionText,
  resolveServeOptionValues,
  serveOptionDefinition,
  validateServeOptionDefinitions,
  type WebAppServeOptionDefinition,
  type WebAppServeOptionValue,
  type WebAppServeOptionValues,
} from "./serve-options";

const SERVER_PID_FILE_VERSION = 1;
const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const READINESS_REQUEST_TIMEOUT_MS = 1_000;
const READINESS_POLL_INTERVAL_MS = 100;
const SERVER_STOP_TIMEOUT_MS = 5_000;
const SERVER_STOP_POLL_INTERVAL_MS = 100;
const serverProcessPlatform = createServerProcessPlatform();

interface ServerPidFile {
  version: typeof SERVER_PID_FILE_VERSION;
  pid: number;
  startedAt: string;
  command: WebAppServerCommand;
  host: string;
  port: number;
}

function healthPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("?") || value.includes("#")) {
    throw new Error("serve healthPath must be an absolute path without a query or fragment");
  }
  return value;
}

interface ServeUpOptions {
  development: boolean;
  host?: string;
  port?: number;
  application: Record<string, WebAppServeOptionValue>;
}

interface ServerLifecyclePaths {
  dataDir: string;
  pidPath: string;
  logPath: string;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCliCommandResult(value: CliCommandResult | WebAppPersistedConfig): value is CliCommandResult {
  return "exitCode" in value && typeof value.exitCode === "number";
}

function parseServerPidFile(value: unknown): ServerPidFile {
  if (!isRecord(value)) {
    throw new Error("Invalid web app server PID file");
  }
  const pid = value["pid"];
  const port = value["port"];
  const command = value["command"];
  if (
    value["version"] !== SERVER_PID_FILE_VERSION
    || !Number.isSafeInteger(pid)
    || Number(pid) <= 0
    || typeof value["startedAt"] !== "string"
    || !value["startedAt"]
    || !Array.isArray(command)
    || command.length === 0
    || command.some((part) => typeof part !== "string" || !part)
    || typeof value["host"] !== "string"
    || !value["host"]
    || !Number.isSafeInteger(port)
    || Number(port) < 1
    || Number(port) > 65535
  ) {
    throw new Error("Invalid web app server PID file");
  }
  const parsedCommand = command.filter((part): part is string => typeof part === "string");
  const [executable, ...args] = parsedCommand;
  if (!executable) {
    throw new Error("Invalid web app server PID file");
  }
  return {
    version: SERVER_PID_FILE_VERSION,
    pid: Number(pid),
    startedAt: value["startedAt"],
    command: [executable, ...args],
    host: value["host"],
    port: Number(port),
  };
}

function configStore(
  envPrefix: string,
  appDirectoryName: string,
  environment: CliEnvironment,
): JsonFileStore<WebAppPersistedConfig> {
  const dataDir = resolveAppDataDir({
    envPrefix,
    appDirectoryName,
    environment,
  });
  return createJsonFileStore({
    stateDirectory: () => dataDir,
    fileName: "config.json",
    parse: parseWebAppPersistedConfig,
  });
}

function pidStore(dataDir: string): JsonFileStore<ServerPidFile> {
  return createJsonFileStore({
    stateDirectory: () => dataDir,
    fileName: "server.pid",
    parse: parseServerPidFile,
  });
}

function lifecyclePaths(config: RuntimeConfig): ServerLifecyclePaths {
  return {
    dataDir: config.dataDir,
    pidPath: join(config.dataDir, "server.pid"),
    logPath: join(config.dataDir, "logs", "server.log"),
  };
}

function currentServerCommand(): WebAppServerCommand {
  const main = typeof Bun.main === "string" ? Bun.main : "";
  const compiledMain = main.startsWith("/$bunfs/");
  if (main && !compiledMain && existsSync(main)) {
    return [process.execPath, main, "serve"];
  }
  return [process.execPath, "serve"];
}

function normalizeServerCommand(value: readonly string[]): WebAppServerCommand {
  if (
    value.length === 0
    || value.some((part) => typeof part !== "string" || !part.trim())
  ) {
    throw new Error("The server command must contain a non-empty executable and arguments");
  }
  const [executable, ...args] = value;
  if (!executable) {
    throw new Error("The server command must contain an executable");
  }
  return [executable, ...args];
}

async function resolveServerCommand<TAppContext>(
  input: CreateWebAppCliOptions<TAppContext>,
  mode: "default" | "development",
  sourcePath: string | undefined,
): Promise<WebAppServerCommand> {
  if (mode === "development") {
    const adapter = input.serve?.development;
    if (!adapter || !sourcePath) {
      throw new Error("serve up --dev requires a configured development source path and adapter");
    }
    const command = normalizeServerCommand(await adapter.command({
      sourcePath,
      appContext: input.appContext as TAppContext,
    }));
    if (command.includes("--dev")) {
      throw new Error("The development server command must not include --dev");
    }
    return command;
  }
  if (input.serve?.command) {
    return normalizeServerCommand(await input.serve.command({
      mode,
      appContext: input.appContext as TAppContext,
    }));
  }
  return currentServerCommand();
}

function parseServeUpArgs(
  args: readonly string[],
  definitions: readonly WebAppServeOptionDefinition[] | undefined = undefined,
  commandName = "serve up",
): ServeUpOptions | CliCommandResult {
  let development = false;
  let host: string | undefined;
  let port: number | undefined;
  const application: Record<string, WebAppServeOptionValue> = {};
  validateServeOptionDefinitions(definitions);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--dev") {
      if (development) return { exitCode: 1, error: "--dev may only be specified once" };
      development = true;
      continue;
    }
    if (arg === "--host" || arg === "--port") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { exitCode: 1, error: `${arg} requires a value` };
      }
      index += 1;
      if (arg === "--host") {
        if (host !== undefined) return { exitCode: 1, error: "--host may only be specified once" };
        host = value;
      } else {
        if (port !== undefined) return { exitCode: 1, error: "--port may only be specified once" };
        try {
          port = parsePort(value, "--port");
        } catch (error) {
          return { exitCode: 1, error: errorMessage(error) };
        }
      }
      continue;
    }
    if (arg.startsWith("--host=")) {
      if (host !== undefined) return { exitCode: 1, error: "--host may only be specified once" };
      host = arg.slice("--host=".length);
      if (!host) return { exitCode: 1, error: "--host requires a value" };
      continue;
    }
    if (arg.startsWith("--port=")) {
      if (port !== undefined) return { exitCode: 1, error: "--port may only be specified once" };
      const value = arg.slice("--port=".length);
      if (!value) return { exitCode: 1, error: "--port requires a value" };
      try {
        port = parsePort(value, "--port");
      } catch (error) {
        return { exitCode: 1, error: errorMessage(error) };
      }
      continue;
    }
    const separatorIndex = arg.indexOf("=");
    const rawFlag = separatorIndex === -1 ? arg : arg.slice(0, separatorIndex);
    const inlineValue = separatorIndex === -1
      ? undefined
      : arg.slice(separatorIndex + 1);
    const optionName = rawFlag?.startsWith("--") ? rawFlag.slice(2) : "";
    const definition = serveOptionDefinition(definitions, optionName);
    if (definition) {
      if (application[definition.name] !== undefined) {
        return {
          exitCode: 1,
          error: `--${definition.name} may only be specified once`,
        };
      }
      const value = inlineValue ?? args[index + 1];
      if (value === undefined || (inlineValue === undefined && value.startsWith("--"))) {
        return {
          exitCode: 1,
          error: `--${definition.name} requires a ${definition.type} value`,
        };
      }
      if (inlineValue === undefined) {
        index += 1;
      }
      try {
        application[definition.name] = parseServeOptionText(
          definition,
          value,
          `--${definition.name}`,
        );
      } catch (error) {
        return { exitCode: 1, error: errorMessage(error) };
      }
      continue;
    }
    return { exitCode: 1, error: `Unknown ${commandName} option: ${arg}` };
  }
  if (host !== undefined && (!host.trim() || /[\s/?#]/.test(host))) {
    return { exitCode: 1, error: "--host must be a non-empty hostname or address" };
  }
  if (port === 0) {
    return { exitCode: 1, error: "--port must be between 1 and 65535 for detached servers" };
  }
  return { development, host: host?.trim(), port, application };
}

function overrideEnvironment(
  environment: CliEnvironment,
  envPrefix: string,
  options: ServeUpOptions,
): RuntimeEnvironment {
  const result: Record<string, string | undefined> = {
    ...process.env,
    ...environment,
  };
  if (options.host !== undefined) {
    result[`${envPrefix}_HOST`] = options.host;
  }
  if (options.port !== undefined) {
    result[`${envPrefix}_PORT`] = String(options.port);
  }
  return result;
}

function resolveServeEnvironment<TAppContext>(
  input: CreateWebAppCliOptions<TAppContext>,
  context: WebAppCliCommandContext<TAppContext>,
  options: ServeUpOptions,
): {
  environment: Record<string, string | undefined>;
  values: WebAppServeOptionValues;
} {
  const baseEnvironment = overrideEnvironment(
    context.environment,
    input.envPrefix,
    options,
  );
  const dataDir = resolveAppDataDir({
    envPrefix: input.envPrefix,
    appDirectoryName: input.appDirectoryName,
    environment: baseEnvironment,
  });
  const values = resolveServeOptionValues({
    definitions: input.serve?.options,
    envPrefix: input.envPrefix,
    environment: baseEnvironment,
    persisted: readWebAppConfig(dataDir),
    overrides: options.application,
  });
  return {
    values,
    environment: applyServeOptionsToEnvironment({
      definitions: input.serve?.options,
      envPrefix: input.envPrefix,
      environment: baseEnvironment,
      values,
    }),
  };
}

function processCommandMatches(
  commandLine: string,
  expected: WebAppServerCommand,
): boolean {
  const executable = expected[0]!;
  const executableName = basename(executable);
  const containsArgument = (part: string): boolean => {
    const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(?:^|\\s|['"])${escaped}(?:$|\\s|['"])`,
    ).test(commandLine);
  };
  const hasExecutable = containsArgument(executable)
    || commandLine.split(/\s+/).some((part) => {
      const candidate = basename(part.replace(/^['"]|['"]$/g, ""));
      return candidate === executableName;
    });
  if (!hasExecutable) return false;
  return expected.slice(1).every(containsArgument);
}

function serveCommandDescription(
  definitions: readonly WebAppServeOptionDefinition[] | undefined,
): string {
  const applicationOptions = validateServeOptionDefinitions(definitions);
  return [
    "Run the application server in the foreground or manage a detached instance.",
    "",
    "Subcommands:",
    "  serve                  Start the server in the foreground.",
    "  serve up [--host HOST] [--port PORT]",
    "                         Start or replace a detached server.",
    "  serve up --dev         Build the configured source tree, then start it.",
    "  serve down [--port PORT]",
    "                         Stop the detached server, if one is running.",
    "  serve status [--port PORT]",
    "                         Show detached server state as JSON.",
    "  serve config show      Show persisted and effective configuration.",
    "  serve config set       Persist a framework or application option.",
    "  serve config unset     Remove a persisted setting.",
    ...(applicationOptions.length === 0
      ? []
      : [
          "",
          "Application options:",
          ...applicationOptions.map(
            (definition) =>
              `  --${definition.name} ${definition.type.toUpperCase()}  ${definition.description}`,
          ),
        ]),
  ].join("\n");
}

async function isRecognizedProcess(
  pid: number,
  expectedCommands: readonly WebAppServerCommand[],
): Promise<boolean> {
  const commandLine = await serverProcessPlatform.readProcessCommand(pid);
  return commandLine !== undefined
    && expectedCommands.some((command) => processCommandMatches(commandLine, command));
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!serverProcessPlatform.isProcessAlive(pid)) return true;
    await Bun.sleep(SERVER_STOP_POLL_INTERVAL_MS);
  }
  return !serverProcessPlatform.isProcessAlive(pid);
}

async function stopProcess(
  pid: number,
  expectedCommands: readonly WebAppServerCommand[],
): Promise<void> {
  if (!serverProcessPlatform.isProcessAlive(pid)) return;
  if (!await isRecognizedProcess(pid, expectedCommands)) {
    throw new Error(`Refusing to stop unrecognized process ${String(pid)}`);
  }
  await serverProcessPlatform.terminateProcess(pid, false);
  if (await waitForProcessExit(pid, SERVER_STOP_TIMEOUT_MS)) return;
  if (!await isRecognizedProcess(pid, expectedCommands)) {
    throw new Error(`Process ${String(pid)} changed before forced termination`);
  }
  await serverProcessPlatform.terminateProcess(pid, true);
  if (!await waitForProcessExit(pid, SERVER_STOP_TIMEOUT_MS)) {
    throw new Error(`Process ${String(pid)} did not stop after forced termination`);
  }
}

async function waitForPortFree(port: number): Promise<void> {
  const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if ((await serverProcessPlatform.inspectPort(port)).pids.length === 0) return;
    await Bun.sleep(SERVER_STOP_POLL_INTERVAL_MS);
  }
  throw new Error(`Port ${String(port)} did not become available after stopping the server`);
}

function localHealthHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
  if (host === "localhost") return "127.0.0.1";
  return host;
}

function healthUrl(config: RuntimeConfig, path: string): string {
  const host = localHealthHost(config.host);
  const formattedHost = host.includes(":") && !host.startsWith("[")
    ? `[${host}]`
    : host;
  return `http://${formattedHost}:${String(config.port)}${path}`;
}

function readinessTimeout<TAppContext>(input: CreateWebAppCliOptions<TAppContext>): number {
  const value = input.serve?.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("serve readinessTimeoutMs must be a positive integer");
  }
  return value;
}

async function waitForReadiness<TAppContext>(
  context: WebAppCliCommandContext<TAppContext>,
  config: RuntimeConfig,
  command: WebAppServerCommand,
  child: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
  path: string,
): Promise<void> {
  const url = healthUrl(config, path);
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "no response";
  while (Date.now() <= deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Server exited with code ${String(child.exitCode)} before becoming ready; command: ${command.join(" ")}`,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READINESS_REQUEST_TIMEOUT_MS);
    try {
      const response = await context.fetchFn(url, { signal: controller.signal });
      if (response.ok) {
        await response.text();
        return;
      }
      lastFailure = `HTTP ${String(response.status)}`;
      await response.text();
    } catch (error) {
      lastFailure = errorMessage(error);
    } finally {
      clearTimeout(timer);
    }
    await Bun.sleep(READINESS_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Server did not become ready at ${url} within ${String(timeoutMs)}ms: ${lastFailure}`,
  );
}

async function startDetachedServer<TAppContext>(input: {
  context: WebAppCliCommandContext<TAppContext>;
  config: RuntimeConfig;
  paths: ServerLifecyclePaths;
  command: WebAppServerCommand;
  pidStore: JsonFileStore<ServerPidFile>;
  readinessTimeoutMs: number;
  healthPath: string;
}): Promise<CliCommandResult> {
  const { context, config, paths, command, pidStore, readinessTimeoutMs, healthPath } = input;
  const logDirectory = join(paths.dataDir, "logs");
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  securePrivateChildDirectory(logDirectory, paths.dataDir);
  const logFd = openSync(paths.logPath, "a", 0o600);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    securePrivateChildFile(paths.logPath, logDirectory);
    const environment: Record<string, string | undefined> = {
      ...process.env,
      ...context.environment,
      [`${context.envPrefix}_HOST`]: config.host,
      [`${context.envPrefix}_PORT`]: String(config.port),
      [`${context.envPrefix}_DATA_DIR`]: config.dataDir,
    };
    child = serverProcessPlatform.spawnDetached({
      command,
      cwd: process.cwd(),
      environment,
      logFd,
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  const metadata: ServerPidFile = {
    version: SERVER_PID_FILE_VERSION,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    command,
    host: config.host,
    port: config.port,
  };
  try {
    await pidStore.write(metadata);
    await waitForReadiness(
      context,
      config,
      command,
      child,
      readinessTimeoutMs,
      healthPath,
    );
  } catch (error) {
    try {
      await pidStore.clear();
      if (child.exitCode === null) {
        await stopProcess(child.pid, [command]);
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Detached server startup failed and cleanup also failed",
      );
    }
    throw error;
  }
  return {
    exitCode: 0,
    output: `Server started with PID ${String(child.pid)} at ${healthUrl(config, healthPath)}`,
  };
}

async function stopExistingServer(input: {
  config: RuntimeConfig;
  pidStore: JsonFileStore<ServerPidFile>;
  stored: ServerPidFile | undefined;
  expectedCommands: readonly WebAppServerCommand[];
}): Promise<void> {
  const { config, pidStore, stored, expectedCommands } = input;
  const inspection = await serverProcessPlatform.inspectPort(config.port);
  const pids = new Set(inspection.pids);
  if (stored && serverProcessPlatform.isProcessAlive(stored.pid)) {
    pids.add(stored.pid);
  }
  if (pids.size === 0) {
    await pidStore.clear();
    return;
  }
  const commandsByPid = new Map<number, WebAppServerCommand[]>();
  for (const pid of pids) {
    const commands = stored?.pid === pid
      ? [stored.command, ...expectedCommands]
      : [...expectedCommands];
    commandsByPid.set(pid, commands);
    if (!await isRecognizedProcess(pid, commands)) {
      throw new Error(
        `Port ${String(config.port)} is occupied by an unrecognized process (PID ${String(pid)}); refusing to stop it`,
      );
    }
  }
  for (const [pid, commands] of commandsByPid) {
    await stopProcess(pid, commands);
  }
  await waitForPortFree(config.port);
  await pidStore.clear();
}

function configKeyError(
  key: string,
  definitions: readonly WebAppServeOptionDefinition[] | undefined,
): CliCommandResult {
  const expected = [
    "host",
    "port",
    "development.source-path",
    ...validateServeOptionDefinitions(definitions).map((definition) => definition.name),
  ];
  return {
    exitCode: 1,
    error: `Unknown serve config key: ${key}; expected ${expected.join(", ")}`,
  };
}

function setConfigValue(
  config: WebAppPersistedConfig,
  key: string,
  value: string,
  definitions: readonly WebAppServeOptionDefinition[] | undefined,
): WebAppPersistedConfig | CliCommandResult {
  const next: WebAppPersistedConfig = {
    ...config,
    version: WEB_APP_CONFIG_VERSION,
  };
  if (key === "host") {
    if (!value.trim() || /[\s/?#]/.test(value)) {
      return { exitCode: 1, error: "host must be a non-empty hostname or address" };
    }
    next.server = { ...(config.server ?? {}), host: value.trim() };
    return next;
  }
  if (key === "port") {
    if (!value.trim()) {
      return { exitCode: 1, error: "port must be an integer between 1 and 65535" };
    }
    try {
      const port = parsePort(value, "port");
      if (port === 0) {
        return { exitCode: 1, error: "port must be between 1 and 65535 for detached servers" };
      }
      next.server = { ...(config.server ?? {}), port };
      return next;
    } catch (error) {
      return { exitCode: 1, error: errorMessage(error) };
    }
  }
  if (key === "development.source-path") {
    if (!value.trim()) {
      return { exitCode: 1, error: "development.source-path must be a non-empty path" };
    }
    next.development = { ...(config.development ?? {}), sourcePath: resolve(value.trim()) };
    return next;
  }
  const definition = serveOptionDefinition(definitions, key);
  if (definition) {
    try {
      next.serve = {
        ...(config.serve ?? {}),
        options: {
          ...(config.serve?.options ?? {}),
          [key]: parseServeOptionText(definition, value, key),
        },
      };
      return next;
    } catch (error) {
      return { exitCode: 1, error: errorMessage(error) };
    }
  }
  return configKeyError(key, definitions);
}

function unsetConfigValue(
  config: WebAppPersistedConfig,
  key: string,
  definitions: readonly WebAppServeOptionDefinition[] | undefined,
): WebAppPersistedConfig | CliCommandResult {
  const next: WebAppPersistedConfig = { ...config, version: WEB_APP_CONFIG_VERSION };
  if (key === "host" || key === "port") {
    if (next.server) {
      const server = { ...next.server };
      delete server[key];
      if (server.host === undefined && server.port === undefined) {
        delete next.server;
      } else {
        next.server = server;
      }
    }
    return next;
  }
  if (key === "development.source-path") {
    if (next.development) {
      const development = { ...next.development };
      delete development.sourcePath;
      if (development.sourcePath === undefined) {
        delete next.development;
      } else {
        next.development = development;
      }
    }
    return next;
  }
  if (
    serveOptionDefinition(definitions, key)
    || next.serve?.options?.[key] !== undefined
  ) {
    if (next.serve?.options) {
      const options = { ...next.serve.options };
      delete options[key];
      if (Object.keys(options).length === 0) {
        delete next.serve;
      } else {
        next.serve = { ...next.serve, options };
      }
    }
    return next;
  }
  return configKeyError(key, definitions);
}

async function assertDirectory(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw new Error(`Development source path is not a directory: ${path}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Development source path is not a directory:")) {
      throw error;
    }
    if (errorCode(error) === "ENOENT") {
      throw new Error(`Development source path does not exist: ${path}`, { cause: error });
    }
    throw new Error(`Unable to inspect development source path: ${path}`, { cause: error });
  }
}

async function runServeConfigCommand<TAppContext>(
  input: CreateWebAppCliOptions<TAppContext>,
  context: WebAppCliCommandContext<TAppContext>,
): Promise<CliCommandResult> {
  const [action = "show", ...args] = context.args;
  const appDirectoryName = resolveAppDirectoryName(input.envPrefix, input.appDirectoryName);
  const store = configStore(input.envPrefix, appDirectoryName, context.environment);
  if (action === "show") {
    if (args.length > 0) {
      return { exitCode: 1, error: "serve config show does not accept arguments" };
    }
    const config = await store.read() ?? { version: WEB_APP_CONFIG_VERSION };
    const values = resolveServeOptionValues({
      definitions: input.serve?.options,
      envPrefix: input.envPrefix,
      environment: context.environment,
      persisted: config,
    });
    const effective = readRuntimeConfig({
      appName: input.appName,
      envPrefix: input.envPrefix,
      appDirectoryName,
      environment: context.environment,
    });
    return {
      exitCode: 0,
      output: JSON.stringify({
        path: store.path(),
        config,
        effective: {
          ...safeRuntimeConfig(effective),
          ...(Object.keys(values).length > 0 ? { application: values } : {}),
        },
      }, null, 2),
    };
  }
  if (action !== "set" && action !== "unset") {
    return { exitCode: 1, error: `Unknown serve config command: ${action}` };
  }
  if (args.length !== (action === "set" ? 2 : 1)) {
    return {
      exitCode: 1,
      error: action === "set"
        ? "serve config set requires KEY VALUE"
        : "serve config unset requires KEY",
    };
  }
  const key = args[0]!;
  let result: WebAppPersistedConfig | CliCommandResult | undefined;
  await store.withLock!(async () => {
    const current = await store.read() ?? { version: WEB_APP_CONFIG_VERSION };
    result = action === "set"
      ? setConfigValue(current, key, args[1]!, input.serve?.options)
      : unsetConfigValue(current, key, input.serve?.options);
    if (!result || "exitCode" in result) return;
    if (key === "development.source-path" && action === "set") {
      const sourcePath = result.development?.sourcePath;
      if (!sourcePath) {
        throw new Error("development.source-path must be a non-empty path");
      }
      await assertDirectory(sourcePath);
      result.development = { ...result.development, sourcePath: sourcePath };
    }
    await store.write(result);
  });
  if (!result) {
    return { exitCode: 1, error: "Configuration update failed" };
  }
  if (isCliCommandResult(result)) {
    return result;
  }
  return { exitCode: 0, output: JSON.stringify(result, null, 2) };
}

async function expectedCommands<TAppContext>(
  input: CreateWebAppCliOptions<TAppContext>,
  sourcePath: string | undefined,
): Promise<WebAppServerCommand[]> {
  const commands = [await resolveServerCommand(input, "default", undefined)];
  if (sourcePath && input.serve?.development) {
    commands.push(await resolveServerCommand(input, "development", sourcePath));
  }
  return commands;
}

async function runServeUp<TAppContext>(
  input: CreateWebAppCliOptions<TAppContext>,
  context: WebAppCliCommandContext<TAppContext>,
  options: ServeUpOptions,
): Promise<CliCommandResult> {
  const resolved = resolveServeEnvironment(input, context, options);
  const environment = resolved.environment;
  const appDirectoryName = resolveAppDirectoryName(input.envPrefix, input.appDirectoryName);
  const config = readRuntimeConfig({
    appName: input.appName,
    envPrefix: input.envPrefix,
    appDirectoryName,
    environment,
  });
  if (config.port === 0) {
    return { exitCode: 1, error: "serve up requires a fixed port; configure a port between 1 and 65535" };
  }
  const persisted = readWebAppConfig(config.dataDir);
  const sourcePath = persisted.development?.sourcePath;
  const paths = lifecyclePaths(config);
  const serverPidStore = pidStore(config.dataDir);
  const timeoutMs = readinessTimeout(input);
  const configuredHealthPath = healthPath(input.serve?.healthPath ?? "/api/health");
  return await serverPidStore.withLock!(async () => {
    let command: WebAppServerCommand;
    if (options.development) {
      if (!input.serve?.development) {
        return { exitCode: 1, error: "serve up --dev is not supported by this application" };
      }
      if (!sourcePath) {
        return {
          exitCode: 1,
          error: "serve up --dev requires development.source-path; set it with serve config set",
        };
      }
      const resolvedSourcePath = resolve(sourcePath);
      await assertDirectory(resolvedSourcePath);
      await input.serve.development.build({
        sourcePath: resolvedSourcePath,
        appContext: input.appContext as TAppContext,
      });
      command = await resolveServerCommand(input, "development", resolvedSourcePath);
    } else {
      command = await resolveServerCommand(input, "default", undefined);
    }
    const candidates = options.development
      ? [
        command,
        await resolveServerCommand(input, "default", undefined),
      ]
      : await expectedCommands(input, sourcePath);
    await stopExistingServer({
      config,
      pidStore: serverPidStore,
      stored: await serverPidStore.read(),
      expectedCommands: candidates,
    });
    return await startDetachedServer({
      context: {
        ...context,
        environment,
      },
      config,
      paths,
      command,
      pidStore: serverPidStore,
      readinessTimeoutMs: timeoutMs,
      healthPath: configuredHealthPath,
    });
  });
}

async function runServeDown<TAppContext>(
  input: CreateWebAppCliOptions<TAppContext>,
  context: WebAppCliCommandContext<TAppContext>,
): Promise<CliCommandResult> {
  const parsed = parseServeUpArgs(context.args, undefined, "serve down");
  if ("exitCode" in parsed) return parsed;
  if (parsed.development) {
    return { exitCode: 1, error: "serve down does not accept --dev" };
  }
  const environment = overrideEnvironment(context.environment, input.envPrefix, parsed);
  const appDirectoryName = resolveAppDirectoryName(input.envPrefix, input.appDirectoryName);
  const config = readRuntimeConfig({
    appName: input.appName,
    envPrefix: input.envPrefix,
    appDirectoryName,
    environment,
  });
  if (config.port === 0) {
    return { exitCode: 1, error: "serve down requires a fixed configured port" };
  }
  const serverPidStore = pidStore(config.dataDir);
  return await serverPidStore.withLock!(async () => {
    const stored = await serverPidStore.read();
    const sourcePath = readWebAppConfig(config.dataDir).development?.sourcePath;
    const candidates = await expectedCommands(input, sourcePath);
    await stopExistingServer({
      config,
      pidStore: serverPidStore,
      stored,
      expectedCommands: candidates,
    });
    return { exitCode: 0, output: `Server stopped on port ${String(config.port)}` };
  });
}

async function runServeStatus<TAppContext>(
  input: CreateWebAppCliOptions<TAppContext>,
  context: WebAppCliCommandContext<TAppContext>,
): Promise<CliCommandResult> {
  const parsed = parseServeUpArgs(context.args, undefined, "serve status");
  if ("exitCode" in parsed) return parsed;
  if (parsed.development) {
    return { exitCode: 1, error: "serve status does not accept --dev" };
  }
  const environment = overrideEnvironment(context.environment, input.envPrefix, parsed);
  const appDirectoryName = resolveAppDirectoryName(input.envPrefix, input.appDirectoryName);
  const config = readRuntimeConfig({
    appName: input.appName,
    envPrefix: input.envPrefix,
    appDirectoryName,
    environment,
  });
  if (config.port === 0) {
    return { exitCode: 1, error: "serve status requires a fixed configured port" };
  }
  const paths = lifecyclePaths(config);
  const store = pidStore(config.dataDir);
  return await store.withLock!(async () => {
    const stored = await store.read();
    const inspection = await serverProcessPlatform.inspectPort(config.port);
    const sourcePath = readWebAppConfig(config.dataDir).development?.sourcePath;
    const candidates = await expectedCommands(input, sourcePath);
    const candidatePids = new Set(inspection.pids);
    const pidFileRunning = stored !== undefined
      && serverProcessPlatform.isProcessAlive(stored.pid);
    if (pidFileRunning) {
      candidatePids.add(stored.pid);
    }
    const recognizedPids: number[] = [];
    for (const pid of candidatePids) {
      if (await isRecognizedProcess(pid, [
        ...(stored?.pid === pid ? [stored.command] : []),
        ...candidates,
      ])) {
        recognizedPids.push(pid);
      }
    }
    return {
      exitCode: 0,
      output: JSON.stringify({
        running: candidatePids.size > 0,
        managed: candidatePids.size > 0 && recognizedPids.length === candidatePids.size,
        pids: inspection.pids,
        pidFilePid: pidFileRunning ? stored?.pid : undefined,
        recognizedPids,
        pidFile: paths.pidPath,
        logFile: paths.logPath,
        config: safeRuntimeConfig(config),
      }, null, 2),
    };
  });
}

export async function runServeCommand<TAppContext>(
  input: CreateWebAppCliOptions<TAppContext>,
  context: WebAppCliCommandContext<TAppContext>,
): Promise<CliCommandResult> {
  const [action, ...rest] = context.args;
  if (!action || action.startsWith("--")) {
    if (input.start === undefined) {
      return { exitCode: 1, error: "No application start callback is configured" };
    }
    const parsed = parseServeUpArgs(
      context.args,
      input.serve?.options,
      "serve",
    );
    if ("exitCode" in parsed) return parsed;
    if (parsed.development || parsed.host !== undefined || parsed.port !== undefined) {
      return {
        exitCode: 1,
        error: "Foreground serve accepts only application-defined options",
      };
    }
    const resolved = resolveServeEnvironment(input, context, parsed);
    await input.start({
      appContext: input.appContext as TAppContext,
      options: resolved.values,
      environment: resolved.environment,
    });
    return { exitCode: 0 };
  }
  if (action === "up") {
    const parsed = parseServeUpArgs(rest, input.serve?.options);
    if ("exitCode" in parsed) return parsed;
    return await runServeUp(input, context, parsed);
  }
  if (action === "down") {
    return await runServeDown(input, { ...context, args: rest });
  }
  if (action === "status") {
    return await runServeStatus(input, { ...context, args: rest });
  }
  if (action === "config") {
    return await runServeConfigCommand(input, { ...context, args: rest });
  }
  return {
    exitCode: 1,
    error: `Unknown serve command: ${action}; expected up, down, status, or config`,
  };
}

export function serveCommandUsage(): string {
  return "serve [up|down|status|config] [options]";
}

export { serveCommandDescription };
