import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type RuntimeEnvironment,
} from "@pablozaiden/webapp/server";
import {
  type CliCommandResult,
  type WebAppCliCommandContext,
  type WebAppCliCommandDefinition,
} from "@pablozaiden/webapp/cli";
import type { ClankyCliContext } from "./mesh";
import { resolveWorkerRuntimeConfiguration } from "./worker-runtime";

const MACOS_LABEL = "com.pablozaiden.clanky.worker";
const LINUX_UNIT_NAME = "clanky-worker.service";
const SERVICE_LOG_DIRECTORY = "logs";
const SAFE_ENVIRONMENT_KEYS = [
  "CLANKY_LOG_LEVEL",
  "CLANKY_IN_MEMORY_LOGS",
  "CLANKY_PUBLIC_BASE_URL",
  "CLANKY_AUTH_ISSUER",
  "CLANKY_TRUST_PROXY",
  "CLANKY_TRUST_PROXY_HEADERS",
  "CLANKY_TRUST_PROXY_CHAIN",
  "CLANKY_DISABLE_SAME_ORIGIN_CHECK",
] as const;

export type WorkerServicePlatform = "darwin" | "linux";
export type WorkerServiceOperation =
  | "install"
  | "uninstall"
  | "status"
  | "start"
  | "stop"
  | "restart";

export interface WorkerServiceCommand {
  operation: WorkerServiceOperation;
  noStart: boolean;
}

export interface WorkerServicePaths {
  platform: WorkerServicePlatform;
  label: string;
  servicePath: string;
  supervisorTarget: string;
  supervisorDomain?: string;
}

export interface WorkerServiceConfiguration {
  platform: WorkerServicePlatform;
  paths: WorkerServicePaths;
  binaryPath: string;
  dataDir: string;
  workerDirectory: string;
  workerExecutionEnabled: boolean;
  insecure: boolean;
  host: string;
  port: number;
  homeDirectory: string;
  userName: string;
  environment: Readonly<Record<string, string>>;
}

interface WorkerServiceResolutionInput {
  platform?: WorkerServicePlatform;
  environment?: RuntimeEnvironment;
  cwd?: string;
  executablePath?: string;
  mainPath?: string;
  homeDirectory?: string;
  userName?: string;
  uid?: number;
}

export interface WorkerServiceProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type WorkerServiceProcessRunner = (
  command: string,
  args: readonly string[],
) => Promise<WorkerServiceProcessResult>;

type ProcessResult = WorkerServiceProcessResult;
type ProcessRunner = WorkerServiceProcessRunner;

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT",
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function currentMainPath(): string {
  return typeof Bun.main === "string" ? Bun.main : "";
}

export function detectWorkerServicePlatform(
  platform: string = process.platform,
): WorkerServicePlatform {
  if (platform === "darwin" || platform === "linux") {
    return platform;
  }
  throw new Error("Worker services are supported on macOS and Linux only.");
}

export function isStandaloneClankyInvocation(
  mainPath: string,
  executablePath: string,
): boolean {
  if (!mainPath) return false;
  const normalizedMainPath = mainPath.replaceAll("\\", "/");
  return (
    resolve(mainPath) === resolve(executablePath)
    || normalizedMainPath.startsWith("/$bunfs/")
    || normalizedMainPath.includes("/$bunfs/")
  );
}

export function parseWorkerServiceArgs(args: readonly string[]): WorkerServiceCommand {
  const [operation, ...rest] = args;
  if (
    operation !== "install"
    && operation !== "uninstall"
    && operation !== "status"
    && operation !== "start"
    && operation !== "stop"
    && operation !== "restart"
  ) {
    throw new Error(
      "Worker service command must be install, uninstall, status, start, stop, or restart",
    );
  }
  let noStart = false;
  for (const arg of rest) {
    if (operation === "install" && arg === "--no-start" && !noStart) {
      noStart = true;
      continue;
    }
    throw new Error(`Unknown worker service option: ${arg}`);
  }
  return { operation, noStart };
}

export function getWorkerServicePaths(
  platform: WorkerServicePlatform,
  homeDirectory: string,
  uid?: number,
): WorkerServicePaths {
  if (platform === "darwin") {
    if (uid === undefined || !Number.isInteger(uid) || uid <= 0) {
      throw new Error("A non-root macOS user is required for a worker LaunchAgent.");
    }
    return {
      platform,
      label: MACOS_LABEL,
      servicePath: join(homeDirectory, "Library", "LaunchAgents", `${MACOS_LABEL}.plist`),
      supervisorTarget: `gui/${String(uid)}/${MACOS_LABEL}`,
      supervisorDomain: `gui/${String(uid)}`,
    };
  }
  return {
    platform,
    label: LINUX_UNIT_NAME,
    servicePath: `/etc/systemd/system/${LINUX_UNIT_NAME}`,
    supervisorTarget: LINUX_UNIT_NAME,
  };
}

function resolveHomeDirectory(
  environment: RuntimeEnvironment,
  explicitHomeDirectory?: string,
): string {
  return resolve(explicitHomeDirectory ?? environment["HOME"]?.trim() ?? homedir());
}

function resolveUserName(explicitUserName?: string): string {
  return explicitUserName?.trim() || userInfo().username;
}

function resolveUid(explicitUid?: number): number | undefined {
  return explicitUid ?? process.getuid?.();
}

function assertNonRootUser(platform: WorkerServicePlatform, uid: number | undefined): void {
  if (uid === 0) {
    throw new Error(
      `Run worker service commands as the worker user, not root; ${platform} service installation invokes its own supervisor privileges.`,
    );
  }
}

async function assertDirectory(path: string, description: string): Promise<void> {
  let directory;
  try {
    directory = await stat(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`${description} does not exist: ${path}`, { cause: error });
    }
    throw new Error(`Unable to inspect ${description.toLowerCase()}: ${path}`, { cause: error });
  }
  if (!directory.isDirectory()) {
    throw new Error(`${description} is not a directory: ${path}`);
  }
}

async function assertStandaloneBinary(binaryPath: string, mainPath: string): Promise<void> {
  if (!isStandaloneClankyInvocation(mainPath, binaryPath)) {
    throw new Error(
      "Worker service installation requires a standalone Clanky binary; development Bun entrypoints are not supported.",
    );
  }
  let binary;
  try {
    binary = await stat(binaryPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`The Clanky executable does not exist: ${binaryPath}`, { cause: error });
    }
    throw new Error(`Unable to inspect the Clanky executable: ${binaryPath}`, { cause: error });
  }
  if (!binary.isFile()) {
    throw new Error(`The Clanky executable is not a file: ${binaryPath}`);
  }
  if ((binary.mode & 0o111) === 0) {
    throw new Error(`The Clanky executable is not executable: ${binaryPath}`);
  }
}

function buildServiceEnvironment(input: {
  environment: RuntimeEnvironment;
  dataDir: string;
  homeDirectory: string;
  host: string;
  port: number;
  platform: WorkerServicePlatform;
}): Record<string, string> {
  const result: Record<string, string> = {
    CLANKY_DATA_DIR: input.dataDir,
    CLANKY_HOST: input.host,
    CLANKY_PORT: String(input.port),
    HOME: input.homeDirectory,
  };
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = input.environment[key];
    if (value !== undefined && value.trim()) {
      result[key] = value;
    }
  }
  if (input.platform === "linux") {
    result["PATH"] = input.environment["PATH"]?.trim()
      || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  }
  return result;
}

export async function resolveWorkerServiceConfiguration(
  input: WorkerServiceResolutionInput = {},
): Promise<WorkerServiceConfiguration> {
  const platform = input.platform ?? detectWorkerServicePlatform();
  const environment = input.environment ?? process.env;
  const homeDirectory = resolveHomeDirectory(environment, input.homeDirectory);
  const uid = resolveUid(input.uid);
  assertNonRootUser(platform, uid);
  const paths = getWorkerServicePaths(platform, homeDirectory, uid);
  const runtimeConfiguration = resolveWorkerRuntimeConfiguration({
    environment,
    cwd: input.cwd,
  });
  const dataDir = runtimeConfiguration.dataDir;
  if (!await pathExists(join(dataDir, "clanky.db"))) {
    throw new Error(`The worker data directory is not initialized: ${dataDir}`);
  }
  const workerDirectory = runtimeConfiguration.workerDirectory;
  await assertDirectory(workerDirectory, "The Mesh worker directory");
  const binaryPath = resolve(input.executablePath ?? process.execPath);
  await assertStandaloneBinary(binaryPath, input.mainPath ?? currentMainPath());
  const userName = resolveUserName(input.userName);
  if (!userName) {
    throw new Error("The worker service user name is unavailable.");
  }
  return {
    platform,
    paths,
    binaryPath,
    dataDir,
    workerDirectory,
    workerExecutionEnabled: runtimeConfiguration.workerExecutionEnabled,
    insecure: runtimeConfiguration.insecure,
    host: runtimeConfiguration.host,
    port: runtimeConfiguration.port,
    homeDirectory,
    userName,
    environment: buildServiceEnvironment({
      environment,
      dataDir,
      homeDirectory,
      host: runtimeConfiguration.host,
      port: runtimeConfiguration.port,
      platform,
    }),
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function renderPlistString(value: string): string {
  return `    <string>${xmlEscape(value)}</string>`;
}

function renderPlistArray(values: readonly string[]): string {
  return [
    "    <array>",
    ...values.map((value) => renderPlistString(value)),
    "    </array>",
  ].join("\n");
}

function renderPlistEnvironment(environment: Readonly<Record<string, string>>): string {
  return [
    "    <dict>",
    ...Object.entries(environment).map(([key, value]) => (
      `      <key>${xmlEscape(key)}</key>\n${renderPlistString(value).replace(/^    /, "      ")}`
    )),
    "    </dict>",
  ].join("\n");
}

function workerCommand(configuration: WorkerServiceConfiguration): string[] {
  return [
    configuration.binaryPath,
    "serve",
    "--mesh-worker",
    "true",
    "--worker-directory",
    configuration.workerDirectory,
    "--worker-execution-enabled",
    String(configuration.workerExecutionEnabled),
    "--insecure",
    String(configuration.insecure),
  ];
}

export function renderLaunchAgent(configuration: WorkerServiceConfiguration): string {
  const command = [
    "/usr/bin/env",
    ...Object.entries(configuration.environment).map(([key, value]) => `${key}=${value}`),
    ...workerCommand(configuration),
  ].map(shellQuote);
  const programArguments = [
    "/bin/zsh",
    "-lic",
    `exec ${command.join(" ")}`,
  ];
  const logs = join(configuration.dataDir, SERVICE_LOG_DIRECTORY);
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "  <dict>",
    `    <key>Label</key>\n${renderPlistString(configuration.paths.label)}`,
    `    <key>ProgramArguments</key>\n${renderPlistArray(programArguments)}`,
    `    <key>WorkingDirectory</key>\n${renderPlistString(configuration.workerDirectory)}`,
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <true/>",
    "    <key>LimitLoadToSessionType</key>",
    `    <string>Aqua</string>`,
    "    <key>EnvironmentVariables</key>",
    renderPlistEnvironment({ HOME: configuration.homeDirectory }),
    `    <key>StandardOutPath</key>\n${renderPlistString(join(logs, "worker-service.stdout.log"))}`,
    `    <key>StandardErrorPath</key>\n${renderPlistString(join(logs, "worker-service.stderr.log"))}`,
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

function systemdValueQuote(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("%", "%%");
  return `"${escaped}"`;
}

function systemdExecStartQuote(value: string): string {
  return systemdValueQuote(value).replaceAll("$", () => "$$");
}

export function renderSystemdUnit(configuration: WorkerServiceConfiguration): string {
  const command = workerCommand(configuration).map(systemdExecStartQuote).join(" ");
  const environment = Object.entries(configuration.environment)
    .map(([key, value]) => `Environment=${systemdValueQuote(`${key}=${value}`)}`);
  return [
    "[Unit]",
    "Description=Clanky Mesh worker",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${systemdValueQuote(configuration.userName)}`,
    `WorkingDirectory=${systemdValueQuote(configuration.workerDirectory)}`,
    ...environment,
    `ExecStart=${command}`,
    "Restart=on-failure",
    "RestartSec=5",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=30",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

async function defaultProcessRunner(
  command: string,
  args: readonly string[],
): Promise<ProcessResult> {
  const process = Bun.spawn([command, ...args], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function commandFailure(result: ProcessResult, command: string, args: readonly string[]): Error {
  const details = result.stderr.trim() || result.stdout.trim();
  return new Error(
    `${command} ${args.join(" ")} failed with exit code ${String(result.exitCode)}${details ? `: ${details}` : ""}`,
  );
}

async function runRequired(
  runner: ProcessRunner,
  command: string,
  args: readonly string[],
): Promise<ProcessResult> {
  const result = await runner(command, args);
  if (result.exitCode !== 0) {
    throw commandFailure(result, command, args);
  }
  return result;
}

async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${String(process.pid)}-${crypto.randomUUID()}`;
  try {
    await Bun.write(temporaryPath, content);
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function writeLinuxUnit(
  configuration: WorkerServiceConfiguration,
  runner: ProcessRunner,
): Promise<void> {
  const temporaryPath = join(
    process.env["TMPDIR"]?.trim() || "/tmp",
    `clanky-worker-${String(process.pid)}-${crypto.randomUUID()}.service`,
  );
  try {
    await writeAtomic(temporaryPath, renderSystemdUnit(configuration), 0o600);
    await runRequired(runner, "sudo", [
      "install",
      "-m",
      "0644",
      temporaryPath,
      configuration.paths.servicePath,
    ]);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

interface MacServiceStatus {
  loaded: boolean;
  running: boolean;
}

async function inspectMacService(
  paths: WorkerServicePaths,
  runner: ProcessRunner,
): Promise<MacServiceStatus> {
  const result = await runner("launchctl", ["print", paths.supervisorTarget]);
  if (result.exitCode === 0) {
    return {
      loaded: true,
      running: /(?:^|\n)\s*state = running\s*(?:\n|$)/i.test(result.stdout),
    };
  }
  if (result.exitCode === 113 || /could not find|no such process/i.test(result.stderr)) {
    return { loaded: false, running: false };
  }
  throw commandFailure(result, "launchctl", ["print", paths.supervisorTarget]);
}

async function unloadMacService(
  paths: WorkerServicePaths,
  runner: ProcessRunner,
): Promise<void> {
  if ((await inspectMacService(paths, runner)).loaded) {
    await runRequired(runner, "launchctl", ["bootout", paths.supervisorTarget]);
  }
}

async function startMacService(
  paths: WorkerServicePaths,
  runner: ProcessRunner,
): Promise<void> {
  if (!(await inspectMacService(paths, runner)).loaded) {
    await runRequired(runner, "launchctl", [
      "bootstrap",
      paths.supervisorDomain!,
      paths.servicePath,
    ]);
  }
  await runRequired(runner, "launchctl", ["kickstart", "-k", paths.supervisorTarget]);
}

function systemctlArgs(args: readonly string[]): string[] {
  return ["systemctl", ...args];
}

async function runSystemctl(
  runner: ProcessRunner,
  args: readonly string[],
): Promise<ProcessResult> {
  return await runner("sudo", systemctlArgs(args));
}

async function assertSystemctlSuccess(
  runner: ProcessRunner,
  args: readonly string[],
): Promise<ProcessResult> {
  const result = await runSystemctl(runner, args);
  if (result.exitCode !== 0) {
    throw commandFailure(result, "sudo", systemctlArgs(args));
  }
  return result;
}

function assertSystemctlStatusResult(
  result: ProcessResult,
  args: readonly string[],
): void {
  if (
    (result.exitCode === 0 || result.exitCode === 1 || result.exitCode === 3)
    && !/(?:sudo:|permission denied|command not found)/i.test(result.stderr)
  ) {
    return;
  }
  throw commandFailure(result, "sudo", systemctlArgs(args));
}

async function stopLinuxService(
  paths: WorkerServicePaths,
  runner: ProcessRunner,
): Promise<void> {
  const result = await runSystemctl(runner, ["disable", "--now", paths.label]);
  if (
    result.exitCode !== 0
    && !/not loaded|does not exist|not found/i.test(`${result.stdout}\n${result.stderr}`)
  ) {
    throw commandFailure(result, "sudo", systemctlArgs([
      "disable",
      "--now",
      paths.label,
    ]));
  }
}

async function installService(
  configuration: WorkerServiceConfiguration,
  noStart: boolean,
  runner: ProcessRunner,
): Promise<void> {
  await mkdir(join(configuration.dataDir, SERVICE_LOG_DIRECTORY), { recursive: true });
  if (configuration.platform === "darwin") {
    await unloadMacService(configuration.paths, runner);
    await writeAtomic(configuration.paths.servicePath, renderLaunchAgent(configuration), 0o600);
    if (!noStart) await startMacService(configuration.paths, runner);
    return;
  }
  await writeLinuxUnit(configuration, runner);
  await assertSystemctlSuccess(runner, ["daemon-reload"]);
  await assertSystemctlSuccess(runner, ["enable", configuration.paths.label]);
  if (!noStart) {
    await assertSystemctlSuccess(runner, ["restart", configuration.paths.label]);
  }
}

async function uninstallService(
  paths: WorkerServicePaths,
  runner: ProcessRunner,
): Promise<void> {
  if (paths.platform === "darwin") {
    await unloadMacService(paths, runner);
    await rm(paths.servicePath, { force: true });
    return;
  }
  await stopLinuxService(paths, runner);
  await runRequired(runner, "sudo", ["rm", "-f", paths.servicePath]);
  await assertSystemctlSuccess(runner, ["daemon-reload"]);
}

export async function getWorkerServiceStatus(
  paths: WorkerServicePaths,
  runner: ProcessRunner,
): Promise<Record<string, unknown>> {
  const installed = await pathExists(paths.servicePath);
  if (paths.platform === "darwin") {
    const macStatus = await inspectMacService(paths, runner);
    return {
      platform: paths.platform,
      service: paths.label,
      installed,
      loaded: macStatus.loaded,
      running: macStatus.running,
      path: paths.servicePath,
    };
  }
  const active = await runSystemctl(runner, ["is-active", paths.label]);
  const enabled = await runSystemctl(runner, ["is-enabled", paths.label]);
  assertSystemctlStatusResult(active, ["is-active", paths.label]);
  assertSystemctlStatusResult(enabled, ["is-enabled", paths.label]);
  return {
    platform: paths.platform,
    service: paths.label,
    installed,
    loaded: enabled.exitCode === 0,
    running: active.exitCode === 0 && active.stdout.trim() === "active",
    path: paths.servicePath,
  };
}

async function runWorkerServiceOperation(
  command: WorkerServiceCommand,
  context: WebAppCliCommandContext<ClankyCliContext>,
): Promise<Record<string, unknown>> {
  const platform = detectWorkerServicePlatform();
  const environment = context.environment;
  const homeDirectory = resolveHomeDirectory(environment);
  const paths = getWorkerServicePaths(platform, homeDirectory, resolveUid());
  const runner = defaultProcessRunner;
  if (command.operation === "install") {
    const configuration = await resolveWorkerServiceConfiguration({
      platform,
      environment,
      homeDirectory,
    });
    await installService(
      configuration,
      command.noStart,
      runner,
    );
    return {
      platform,
      service: paths.label,
      installed: true,
      started: !command.noStart,
      path: paths.servicePath,
    };
  }
  if (command.operation === "uninstall") {
    await uninstallService(paths, runner);
    return {
      platform,
      service: paths.label,
      installed: false,
      path: paths.servicePath,
    };
  }
  if (command.operation === "status") {
    return await getWorkerServiceStatus(paths, runner);
  }
  if (!await pathExists(paths.servicePath)) {
    throw new Error(`The worker service is not installed: ${paths.servicePath}`);
  }
  if (platform === "darwin") {
    if (command.operation === "stop") {
      await unloadMacService(paths, runner);
    } else {
      if (command.operation === "restart") await unloadMacService(paths, runner);
      await startMacService(paths, runner);
    }
  } else {
    await assertSystemctlSuccess(runner, [command.operation, paths.label]);
  }
  return {
    platform,
    service: paths.label,
    operation: command.operation,
    path: paths.servicePath,
  };
}

export async function runWorkerServiceCommand(
  context: WebAppCliCommandContext<ClankyCliContext>,
): Promise<CliCommandResult> {
  const result = await runWorkerServiceOperation(parseWorkerServiceArgs(context.args), context);
  context.stdout.write(`${JSON.stringify(result)}\n`);
  return { exitCode: 0 };
}

export function createWorkerServiceCommand(): WebAppCliCommandDefinition<ClankyCliContext> {
  return {
    description:
      "Install and manage the native worker service; macOS worker startup requests permissions.",
    usage: "worker service <install|uninstall|status|start|stop|restart> [--no-start]",
    handler: runWorkerServiceCommand,
  };
}
