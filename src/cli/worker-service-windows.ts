import { copyFile, mkdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";

const WINDOWS_SERVICE_ID = "clanky-worker";
const WINDOWS_SERVICE_DIRECTORY = "worker-service";
const WINDOWS_SERVICE_BASENAME = "clanky-worker-service";
const WINDOWS_SERVICE_BINARY_NAME = "clanky-worker.exe";
const WINDOWS_SERVICE_LOG_DIRECTORY = "logs";
const WINDOWS_SERVICE_POLL_INTERVAL_MS = 100;
const WINDOWS_SERVICE_TRANSITION_TIMEOUT_MS = 30_000;
const WINDOWS_SERVICE_STOPPED = 1;
const WINDOWS_SERVICE_START_PENDING = 2;
const WINDOWS_SERVICE_STOP_PENDING = 3;
const WINDOWS_SERVICE_RUNNING = 4;

export interface WindowsWorkerServicePaths {
  platform: "win32";
  label: string;
  servicePath: string;
  supervisorTarget: string;
  serviceDirectory: string;
  managedBinaryPath: string;
  wrapperPath: string;
}

export interface WindowsWorkerServiceDefinition {
  paths: WindowsWorkerServicePaths;
  sourceBinaryPath: string;
  sourceWrapperPath: string;
  dataDir: string;
  workerDirectory: string;
  userName: string;
  userDomain: string;
  environment: Readonly<Record<string, string>>;
  arguments: readonly string[];
}

export interface WindowsWorkerServiceProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WindowsWorkerServiceProcessOptions {
  inheritOutput?: boolean;
}

export type WindowsWorkerServiceProcessRunner = (
  command: string,
  args: readonly string[],
  options?: WindowsWorkerServiceProcessOptions,
) => Promise<WindowsWorkerServiceProcessResult>;

interface WindowsWorkerServiceStatus {
  installed: boolean;
  running: boolean;
  childRunning: boolean;
  state: number | null;
  processId: number | null;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function quoteWindowsArgument(value: string): string {
  if (value && !/[\s"]/u.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    result += `${"\\".repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  return `${result}${"\\".repeat(backslashes * 2)}"`;
}

function processFailure(
  result: WindowsWorkerServiceProcessResult,
  command: string,
  args: readonly string[],
): Error {
  const details = result.stderr.trim() || result.stdout.trim();
  return new Error(
    `${command} ${args.join(" ")} failed with exit code ${String(result.exitCode)}${details ? `: ${details}` : ""}`,
  );
}

async function runRequired(
  runner: WindowsWorkerServiceProcessRunner,
  command: string,
  args: readonly string[],
  options?: WindowsWorkerServiceProcessOptions,
): Promise<WindowsWorkerServiceProcessResult> {
  const result = await runner(command, args, options);
  if (result.exitCode !== 0) {
    throw processFailure(result, command, args);
  }
  return result;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function replaceFile(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  if (win32.resolve(sourcePath) === win32.resolve(targetPath)) return;
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp-${String(process.pid)}-${crypto.randomUUID()}`;
  const backupPath = `${targetPath}.backup-${String(process.pid)}-${crypto.randomUUID()}`;
  const hadTarget = await fileExists(targetPath);
  let backupCreated = false;
  let preserveBackup = false;
  try {
    await copyFile(sourcePath, temporaryPath);
    if (hadTarget) {
      await rename(targetPath, backupPath);
      backupCreated = true;
    }
    await rename(temporaryPath, targetPath);
    if (backupCreated) {
      await rm(backupPath, { force: true });
      backupCreated = false;
    }
  } catch (error) {
    if (backupCreated && !(await fileExists(targetPath))) {
      try {
        await rename(backupPath, targetPath);
        backupCreated = false;
      } catch (rollbackError) {
        preserveBackup = true;
        throw new AggregateError(
          [error, rollbackError],
          `Unable to deploy ${targetPath} or restore its backup ${backupPath}`,
        );
      }
    }
    throw new Error(`Unable to deploy ${targetPath}`, { cause: error });
  } finally {
    await rm(temporaryPath, { force: true });
    if (backupCreated && !preserveBackup) await rm(backupPath, { force: true });
  }
}

function windowsPowerShellExecutable(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const windowsDirectory = environment["SystemRoot"] ?? environment["WINDIR"];
  return windowsDirectory
    ? win32.join(
        windowsDirectory,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe";
}

function powerShellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function windowsServiceInspectionScript(
  paths: WindowsWorkerServicePaths,
): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$service = Get-CimInstance -ClassName Win32_Service -Filter ${powerShellString(`Name = '${paths.label}'`)}`,
    "if ($null -eq $service) {",
    "  [Console]::Out.Write('{\"installed\":false}')",
    "  exit 0",
    "}",
    "$childRunning = $false",
    "if ([uint32]$service.ProcessId -gt 0) {",
    "  $children = @(Get-CimInstance -ClassName Win32_Process -Filter ('ParentProcessId = ' + [uint32]$service.ProcessId))",
    `  $expectedPath = ${powerShellString(paths.managedBinaryPath)}`,
    "  $childRunning = $null -ne ($children | Where-Object {",
    "    $null -ne $_.ExecutablePath -and $_.ExecutablePath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)",
    "  } | Select-Object -First 1)",
    "}",
    "[Console]::Out.Write(([PSCustomObject]@{",
    "  installed = $true",
    "  state = [string]$service.State",
    "  processId = [uint32]$service.ProcessId",
    "  childRunning = $childRunning",
    "} | ConvertTo-Json -Compress))",
  ].join("\n");
}

function serviceStateCode(value: string): number {
  switch (value.toLowerCase()) {
    case "stopped":
      return WINDOWS_SERVICE_STOPPED;
    case "start pending":
      return WINDOWS_SERVICE_START_PENDING;
    case "stop pending":
      return WINDOWS_SERVICE_STOP_PENDING;
    case "running":
      return WINDOWS_SERVICE_RUNNING;
    case "continue pending":
      return 5;
    case "pause pending":
      return 6;
    case "paused":
      return 7;
    default:
      throw new Error(
        `Windows SCM returned an unknown service state: ${value}`,
      );
  }
}

async function inspectWindowsWorkerService(
  paths: WindowsWorkerServicePaths,
  runner: WindowsWorkerServiceProcessRunner,
): Promise<WindowsWorkerServiceStatus> {
  const executable = windowsPowerShellExecutable();
  const encodedScript = Buffer.from(
    windowsServiceInspectionScript(paths),
    "utf16le",
  ).toString("base64");
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodedScript,
  ];
  const result = await runner(executable, args);
  if (result.exitCode !== 0) {
    throw processFailure(result, executable, args);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Windows service inspection returned invalid JSON for ${paths.label}`,
      { cause: error },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Windows service inspection returned invalid data for ${paths.label}`,
    );
  }
  const value = parsed as Record<string, unknown>;
  if (value["installed"] === false) {
    return {
      installed: false,
      running: false,
      childRunning: false,
      state: null,
      processId: null,
    };
  }
  if (
    value["installed"] !== true ||
    typeof value["state"] !== "string" ||
    typeof value["processId"] !== "number" ||
    typeof value["childRunning"] !== "boolean"
  ) {
    throw new Error(
      `Windows service inspection returned invalid data for ${paths.label}`,
    );
  }
  const state = serviceStateCode(value["state"]);
  return {
    installed: true,
    running: state === WINDOWS_SERVICE_RUNNING && value["childRunning"],
    childRunning: value["childRunning"],
    state,
    processId: value["processId"],
  };
}

async function runWrapper(
  paths: WindowsWorkerServicePaths,
  operation: "install" | "start" | "stop" | "uninstall",
  runner: WindowsWorkerServiceProcessRunner,
): Promise<void> {
  const args = operation === "install" ? ["install", "/p"] : [operation];
  await runRequired(
    runner,
    paths.wrapperPath,
    args,
    operation === "install" ? { inheritOutput: true } : undefined,
  );
}

async function waitForWindowsServiceState(
  paths: WindowsWorkerServicePaths,
  expectedState: number,
  runner: WindowsWorkerServiceProcessRunner,
): Promise<WindowsWorkerServiceStatus> {
  const deadline = Date.now() + WINDOWS_SERVICE_TRANSITION_TIMEOUT_MS;
  let lastStatus: WindowsWorkerServiceStatus | undefined;
  while (Date.now() <= deadline) {
    lastStatus = await inspectWindowsWorkerService(paths, runner);
    if (
      lastStatus.installed &&
      lastStatus.state === expectedState &&
      (expectedState !== WINDOWS_SERVICE_RUNNING || lastStatus.childRunning)
    ) {
      return lastStatus;
    }
    await Bun.sleep(WINDOWS_SERVICE_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Windows service ${paths.label} did not reach state ${String(expectedState)} within ${String(WINDOWS_SERVICE_TRANSITION_TIMEOUT_MS)}ms; last state: ${String(lastStatus?.state ?? "missing")}`,
  );
}

async function startWindowsWorkerService(
  paths: WindowsWorkerServicePaths,
  status: WindowsWorkerServiceStatus,
  runner: WindowsWorkerServiceProcessRunner,
): Promise<void> {
  if (status.state === WINDOWS_SERVICE_RUNNING) {
    if (!status.childRunning) {
      await waitForWindowsServiceState(paths, WINDOWS_SERVICE_RUNNING, runner);
    }
    return;
  }
  if (status.state === WINDOWS_SERVICE_START_PENDING) {
    await waitForWindowsServiceState(paths, WINDOWS_SERVICE_RUNNING, runner);
    return;
  }
  if (status.state === WINDOWS_SERVICE_STOP_PENDING) {
    await waitForWindowsServiceState(paths, WINDOWS_SERVICE_STOPPED, runner);
  } else if (status.state !== WINDOWS_SERVICE_STOPPED) {
    throw new Error(
      `Windows service ${paths.label} cannot start from state ${String(status.state)}`,
    );
  }
  await runWrapper(paths, "start", runner);
  await waitForWindowsServiceState(paths, WINDOWS_SERVICE_RUNNING, runner);
}

async function stopWindowsWorkerService(
  paths: WindowsWorkerServicePaths,
  status: WindowsWorkerServiceStatus,
  runner: WindowsWorkerServiceProcessRunner,
): Promise<void> {
  if (status.state === WINDOWS_SERVICE_STOPPED) return;
  if (status.state === WINDOWS_SERVICE_STOP_PENDING) {
    await waitForWindowsServiceState(paths, WINDOWS_SERVICE_STOPPED, runner);
    return;
  }
  if (status.state === WINDOWS_SERVICE_START_PENDING) {
    await waitForWindowsServiceState(paths, WINDOWS_SERVICE_RUNNING, runner);
  } else if (status.state !== WINDOWS_SERVICE_RUNNING) {
    throw new Error(
      `Windows service ${paths.label} cannot stop from state ${String(status.state)}`,
    );
  }
  await runWrapper(paths, "stop", runner);
  await waitForWindowsServiceState(paths, WINDOWS_SERVICE_STOPPED, runner);
}

export function getWindowsWorkerServicePaths(
  dataDir: string,
): WindowsWorkerServicePaths {
  const serviceDirectory = win32.join(dataDir, WINDOWS_SERVICE_DIRECTORY);
  return {
    platform: "win32",
    label: WINDOWS_SERVICE_ID,
    servicePath: win32.join(
      serviceDirectory,
      `${WINDOWS_SERVICE_BASENAME}.xml`,
    ),
    supervisorTarget: WINDOWS_SERVICE_ID,
    serviceDirectory,
    managedBinaryPath: win32.join(
      serviceDirectory,
      WINDOWS_SERVICE_BINARY_NAME,
    ),
    wrapperPath: win32.join(
      serviceDirectory,
      `${WINDOWS_SERVICE_BASENAME}.exe`,
    ),
  };
}

export function renderWindowsWorkerService(
  definition: WindowsWorkerServiceDefinition,
): string {
  const { paths } = definition;
  return [
    "<service>",
    `  <id>${xmlEscape(paths.label)}</id>`,
    "  <name>Clanky Mesh Worker</name>",
    "  <description>Runs a persistent Clanky Mesh worker.</description>",
    `  <executable>${xmlEscape(paths.managedBinaryPath)}</executable>`,
    `  <arguments>${xmlEscape(definition.arguments.map(quoteWindowsArgument).join(" "))}</arguments>`,
    `  <workingdirectory>${xmlEscape(definition.workerDirectory)}</workingdirectory>`,
    "  <startmode>Automatic</startmode>",
    "  <delayedAutoStart/>",
    "  <hidewindow>true</hidewindow>",
    "  <stoptimeout>30 sec</stoptimeout>",
    '  <onfailure action="restart" delay="5 sec"/>',
    "  <resetfailure>1 hour</resetfailure>",
    "  <serviceaccount>",
    `    <domain>${xmlEscape(definition.userDomain)}</domain>`,
    `    <user>${xmlEscape(definition.userName)}</user>`,
    "  </serviceaccount>",
    ...Object.entries(definition.environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, value]) =>
          `  <env name="${xmlEscape(key)}" value="${xmlEscape(value)}"/>`,
      ),
    `  <logpath>${xmlEscape(win32.join(definition.dataDir, WINDOWS_SERVICE_LOG_DIRECTORY))}</logpath>`,
    '  <log mode="roll-by-size">',
    "    <sizeThreshold>10240</sizeThreshold>",
    "    <keepFiles>8</keepFiles>",
    "  </log>",
    "</service>",
    "",
  ].join("\n");
}

export async function installWindowsWorkerService(
  definition: WindowsWorkerServiceDefinition,
  noStart: boolean,
  runner: WindowsWorkerServiceProcessRunner,
): Promise<void> {
  const { paths } = definition;
  const status = await inspectWindowsWorkerService(paths, runner);
  if (status.installed) {
    await stopWindowsWorkerService(paths, status, runner);
  }
  await mkdir(paths.serviceDirectory, { recursive: true });
  await mkdir(join(definition.dataDir, WINDOWS_SERVICE_LOG_DIRECTORY), {
    recursive: true,
  });
  await replaceFile(definition.sourceWrapperPath, paths.wrapperPath);
  await replaceFile(definition.sourceBinaryPath, paths.managedBinaryPath);
  const temporaryServicePath = `${paths.servicePath}.tmp-${String(process.pid)}-${crypto.randomUUID()}`;
  try {
    await Bun.write(
      temporaryServicePath,
      renderWindowsWorkerService(definition),
    );
    await replaceFile(temporaryServicePath, paths.servicePath);
  } finally {
    await rm(temporaryServicePath, { force: true });
  }
  if (!status.installed) {
    await runWrapper(paths, "install", runner);
  }
  if (!noStart) {
    await startWindowsWorkerService(
      paths,
      await inspectWindowsWorkerService(paths, runner),
      runner,
    );
  }
}

export async function uninstallWindowsWorkerService(
  paths: WindowsWorkerServicePaths,
  runner: WindowsWorkerServiceProcessRunner,
): Promise<void> {
  const status = await inspectWindowsWorkerService(paths, runner);
  if (status.installed) {
    await stopWindowsWorkerService(paths, status, runner);
  }
  if (status.installed) {
    await runWrapper(paths, "uninstall", runner);
  }
  await rm(paths.servicePath, { force: true });
  await rm(paths.managedBinaryPath, { force: true });
  await rm(paths.wrapperPath, { force: true });
  try {
    await rmdir(paths.serviceDirectory);
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      (error.code !== "ENOENT" && error.code !== "ENOTEMPTY")
    ) {
      throw error;
    }
  }
}

export async function getWindowsWorkerServiceStatus(
  paths: WindowsWorkerServicePaths,
  runner: WindowsWorkerServiceProcessRunner,
): Promise<Record<string, unknown>> {
  const status = await inspectWindowsWorkerService(paths, runner);
  return {
    platform: paths.platform,
    service: paths.label,
    installed: status.installed,
    loaded: status.installed,
    running: status.running,
    state: status.state,
    processId: status.processId,
    childRunning: status.childRunning,
    path: paths.servicePath,
    binaryPath: paths.managedBinaryPath,
    wrapperPath: paths.wrapperPath,
  };
}

export async function runWindowsWorkerServiceOperation(
  operation: "start" | "stop" | "restart",
  paths: WindowsWorkerServicePaths,
  runner: WindowsWorkerServiceProcessRunner,
): Promise<void> {
  const status = await inspectWindowsWorkerService(paths, runner);
  if (!status.installed) {
    throw new Error(
      `The worker service is not installed: ${paths.servicePath}`,
    );
  }
  if (operation === "start") {
    await startWindowsWorkerService(paths, status, runner);
    return;
  }
  await stopWindowsWorkerService(paths, status, runner);
  if (operation === "restart") {
    await startWindowsWorkerService(
      paths,
      await inspectWindowsWorkerService(paths, runner),
      runner,
    );
  }
}
