import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import type {
  CliCommandResult,
  WebAppCliCommandContext,
} from "@pablozaiden/webapp/cli";
import type { RuntimeEnvironment } from "@pablozaiden/webapp/server";
import type { ClankyCliContext } from "./mesh";
import { systemdToken } from "./systemd";

export const LINUX_SSH_AGENT_UNIT_NAME = "clanky-worker-ssh-agent.service";
export const LINUX_SSH_AGENT_DIRECTORY_NAME = "worker-ssh-agent";

const SHELL_BLOCK_START = "# >>> clanky worker ssh-agent >>>";
const SHELL_BLOCK_END = "# <<< clanky worker ssh-agent <<<";

export interface WorkerSshAgentPaths {
  label: string;
  servicePath: string;
  agentDirectory: string;
  socketPath: string;
  helperPath: string;
  bashrcPath: string;
  bashProfilePath: string;
  bashLoginPath: string;
  profilePath: string;
  zshrcPath: string;
  zshProfilePath: string;
}

export interface WorkerSshAgentConfiguration {
  paths: WorkerSshAgentPaths;
  homeDirectory: string;
  userName: string;
  binaryPath: string;
  sshAgentPath: string;
  sshAddPath: string;
}

export type WorkerSshAgentOperation = "unlock" | "status";

export interface WorkerSshAgentCommand {
  operation: WorkerSshAgentOperation;
  ifNeeded: boolean;
}

export interface WorkerSshAgentUnlockResult {
  changed: boolean;
  identities: number;
}

function resolveExecutable(command: string): string {
  const executable = Bun.which(command);
  if (!executable) {
    throw new Error(
      `${command} is required for the Linux worker SSH agent; install the OpenSSH client package first.`,
    );
  }
  return executable;
}

export function getWorkerSshAgentPaths(homeDirectory: string): WorkerSshAgentPaths {
  const agentDirectory = resolve(homeDirectory, ".clanky", LINUX_SSH_AGENT_DIRECTORY_NAME);
  return {
    label: LINUX_SSH_AGENT_UNIT_NAME,
    servicePath: `/etc/systemd/system/${LINUX_SSH_AGENT_UNIT_NAME}`,
    agentDirectory,
    socketPath: resolve(agentDirectory, "agent.sock"),
    helperPath: `${homeDirectory}/.clanky/worker-ssh-agent.sh`,
    bashrcPath: `${homeDirectory}/.bashrc`,
    bashProfilePath: `${homeDirectory}/.bash_profile`,
    bashLoginPath: `${homeDirectory}/.bash_login`,
    profilePath: `${homeDirectory}/.profile`,
    zshrcPath: `${homeDirectory}/.zshrc`,
    zshProfilePath: `${homeDirectory}/.zprofile`,
  };
}

export function resolveWorkerSshAgentConfiguration(input: {
  environment?: RuntimeEnvironment;
  homeDirectory?: string;
  userName?: string;
  binaryPath?: string;
} = {}): WorkerSshAgentConfiguration {
  const environment = input.environment ?? process.env;
  const homeDirectory = resolve(input.homeDirectory ?? environment["HOME"]?.trim() ?? homedir());
  const userName = input.userName?.trim() || userInfo().username;
  const uid = process.getuid?.();
  if (uid === 0) {
    throw new Error("Run worker SSH-agent commands as the worker user, not root.");
  }
  const binaryPath = resolve(input.binaryPath ?? process.execPath);
  return {
    paths: getWorkerSshAgentPaths(homeDirectory),
    homeDirectory,
    userName,
    binaryPath,
    sshAgentPath: resolveExecutable("ssh-agent"),
    sshAddPath: resolveExecutable("ssh-add"),
  };
}

export function renderSshAgentSystemdUnit(
  configuration: WorkerSshAgentConfiguration,
): string {
  return [
    "[Unit]",
    "Description=Clanky worker SSH agent",
    "After=local-fs.target",
    "Before=clanky-worker.service",
    "",
    "[Service]",
    "Type=simple",
    `User=${systemdToken(configuration.userName)}`,
    `ExecStartPre=/usr/bin/mkdir -p ${systemdToken(configuration.paths.agentDirectory, true)}`,
    `ExecStartPre=/usr/bin/chmod 0700 ${systemdToken(configuration.paths.agentDirectory, true)}`,
    `ExecStartPre=/usr/bin/rm -f ${systemdToken(configuration.paths.socketPath, true)}`,
    `ExecStart=${systemdToken(configuration.sshAgentPath, true)} -D -a ${systemdToken(configuration.paths.socketPath, true)}`,
    "Restart=on-failure",
    "RestartSec=5",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=10",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellReturn(value: number): string {
  return `return ${String(value)} 2>/dev/null || exit ${String(value)}`;
}

export function renderSshAgentShellHelper(
  configuration: WorkerSshAgentConfiguration,
): string {
  const binaryPath = shellQuote(configuration.binaryPath);
  const sshAddPath = shellQuote(configuration.sshAddPath);
  const socketPath = shellQuote(configuration.paths.socketPath);
  return [
    "#!/bin/sh",
    "# Managed by Clanky. Do not add secrets to this file.",
    `export SSH_AUTH_SOCK=${socketPath}`,
    `if ! command -v ${sshAddPath} >/dev/null 2>&1; then`,
    "  printf '%s\\n' 'Clanky: ssh-add is required for the worker SSH agent.' >&2",
    `  ${shellReturn(0)}`,
    "fi",
    `${binaryPath} worker ssh-agent unlock --if-needed`,
    "status=$?",
    "if [ \"$status\" -ne 0 ]; then",
    "  printf '%s\\n' 'Clanky: unable to unlock the worker SSH agent.' >&2",
    "fi",
    shellReturn(0),
    "",
  ].join("\n");
}

export function renderShellStartupBlock(helperPath: string): string {
  return [
    SHELL_BLOCK_START,
    'case "$-" in',
    "  *i*)",
    `    if [ -r ${shellQuote(helperPath)} ]; then`,
    `      . ${shellQuote(helperPath)}`,
    "    fi",
    "    ;;",
    "esac",
    SHELL_BLOCK_END,
  ].join("\n");
}

function replaceShellBlock(
  content: string,
  block: string | null,
): string {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.indexOf(SHELL_BLOCK_START);
  const endIndex = lines.indexOf(SHELL_BLOCK_END);
  if ((startIndex === -1) !== (endIndex === -1)) {
    throw new Error("The Clanky worker SSH-agent shell block is incomplete.");
  }
  if (startIndex !== -1 && endIndex < startIndex) {
    throw new Error("The Clanky worker SSH-agent shell block is malformed.");
  }
  if (startIndex !== -1) {
    lines.splice(
      startIndex,
      endIndex - startIndex + 1,
      ...(block ? block.split("\n") : []),
    );
    return lines.join("\n");
  }
  if (!block) return content;
  return `${content}${content.length > 0 && !content.endsWith("\n") ? "\n" : ""}${block}\n`;
}

export function upsertShellStartupBlock(content: string, helperPath: string): string {
  return replaceShellBlock(content, renderShellStartupBlock(helperPath));
}

export function removeShellStartupBlock(content: string): string {
  return replaceShellBlock(content, null);
}

export function parseWorkerSshAgentArgs(
  args: readonly string[],
): WorkerSshAgentCommand {
  const [operation, ...rest] = args;
  if (operation !== "unlock" && operation !== "status") {
    throw new Error("Worker ssh-agent command must be unlock or status");
  }
  let ifNeeded = false;
  for (const arg of rest) {
    if (operation === "unlock" && arg === "--if-needed" && !ifNeeded) {
      ifNeeded = true;
      continue;
    }
    throw new Error(`Unknown worker ssh-agent option: ${arg}`);
  }
  return { operation, ifNeeded };
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runProcess(
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  interactive: boolean,
): Promise<ProcessResult> {
  let process;
  try {
    process = Bun.spawn([command, ...args], {
      stdin: "inherit",
      stdout: interactive ? "inherit" : "pipe",
      stderr: interactive ? "inherit" : "pipe",
      env: {
        ...globalThis.process.env,
        ...environment,
      },
    });
  } catch (error) {
    throw new Error(`Unable to run ${command}: ${String(error)}`, { cause: error });
  }
  if (interactive) {
    return {
      exitCode: await process.exited,
      stdout: "",
      stderr: "",
    };
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function countIdentities(output: string): number {
  return output.trim() ? output.trim().split(/\r?\n/).length : 0;
}

async function listAgentIdentities(
  configuration: WorkerSshAgentConfiguration,
): Promise<ProcessResult> {
  const environment = {
    HOME: configuration.homeDirectory,
    SSH_AUTH_SOCK: configuration.paths.socketPath,
  };
  let result: ProcessResult = {
    exitCode: 2,
    stdout: "",
    stderr: "",
  };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    result = await runProcess(configuration.sshAddPath, ["-l"], environment, false);
    if (result.exitCode !== 2 || attempt === 9) return result;
    await Bun.sleep(50);
  }
  return result;
}

export async function unlockWorkerSshAgent(
  configuration: WorkerSshAgentConfiguration,
): Promise<WorkerSshAgentUnlockResult> {
  const environment = {
    HOME: configuration.homeDirectory,
    SSH_AUTH_SOCK: configuration.paths.socketPath,
  };
  const listed = await listAgentIdentities(configuration);
  if (listed.exitCode === 0) {
    return {
      changed: false,
      identities: countIdentities(listed.stdout),
    };
  }
  if (listed.exitCode !== 1) {
    const details = listed.stderr.trim() || listed.stdout.trim();
    throw new Error(
      `Unable to access the Clanky worker SSH agent${details ? `: ${details}` : "."}`,
    );
  }

  const added = await runProcess(
    configuration.sshAddPath,
    [],
    environment,
    true,
  );
  if (added.exitCode !== 0) {
    throw new Error(`ssh-add could not unlock the Clanky worker SSH agent (exit code ${String(added.exitCode)}).`);
  }

  const verified = await listAgentIdentities(configuration);
  if (verified.exitCode !== 0) {
    const details = verified.stderr.trim() || verified.stdout.trim();
    throw new Error(
      `ssh-add completed but the Clanky worker SSH agent has no identities${details ? `: ${details}` : "."}`,
    );
  }
  return {
    changed: true,
    identities: countIdentities(verified.stdout),
  };
}

async function getWorkerSshAgentStatus(
  configuration: WorkerSshAgentConfiguration,
): Promise<Record<string, unknown>> {
  const listed = await runProcess(
    configuration.sshAddPath,
    ["-l"],
    {
      HOME: configuration.homeDirectory,
      SSH_AUTH_SOCK: configuration.paths.socketPath,
    },
    false,
  );
  if (listed.exitCode === 0) {
    return {
      socket: configuration.paths.socketPath,
      available: true,
      unlocked: true,
      identities: countIdentities(listed.stdout),
    };
  }
  if (listed.exitCode === 1) {
    return {
      socket: configuration.paths.socketPath,
      available: true,
      unlocked: false,
      identities: 0,
    };
  }
  return {
    socket: configuration.paths.socketPath,
    available: false,
    unlocked: false,
    identities: 0,
  };
}

export async function runWorkerSshAgentCommand(
  context: WebAppCliCommandContext<ClankyCliContext>,
  configuration: WorkerSshAgentConfiguration,
): Promise<CliCommandResult> {
  const command = parseWorkerSshAgentArgs(context.args);
  if (command.operation === "status") {
    context.stdout.write(`${JSON.stringify(await getWorkerSshAgentStatus(configuration))}\n`);
    return { exitCode: 0 };
  }
  const result = await unlockWorkerSshAgent(configuration);
  if (!command.ifNeeded) {
    context.stdout.write(`${JSON.stringify({
      socket: configuration.paths.socketPath,
      unlocked: true,
      identities: result.identities,
      changed: result.changed,
    })}\n`);
  }
  return { exitCode: 0 };
}
