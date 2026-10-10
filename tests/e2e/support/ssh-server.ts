/**
 * Ephemeral OpenSSH server for Linux black-box E2E scenarios.
 */

import { chmod, mkdir, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { pollUntil } from "./polling";
import {
  currentEnvironment,
  findFreeLoopbackPort,
  readProcessDiagnostics,
  requireCommand,
  runCommand,
  startManagedProcess,
  stopManagedProcess,
  type ManagedProcess,
} from "./process";
import { LIFECYCLE_TIMEOUT_MS } from "./timeouts";

interface SshServerOptions {
  clientHomeDirectory: string;
  providerBinDirectory: string;
  runDirectory: string;
}

export interface ManagedSshServer {
  agentProcess: ManagedProcess;
  agentSocket: string;
  directory: string;
  port: number;
  process: ManagedProcess;
  username: string;
}

function isRoot(): boolean {
  return process.getuid?.() === 0;
}

function sshdCommand(sshdPath: string): string[] {
  return isRoot()
    ? [sshdPath]
    : ["sudo", "-n", sshdPath];
}

async function stopPrivilegedProcess(processHandle: ManagedProcess): Promise<void> {
  if (isRoot()) {
    await stopManagedProcess(processHandle);
    return;
  }
  if (processHandle.processGroupId === null || processHandle.child.exitCode !== null) {
    return;
  }

  await requireCommand(
    [
      "sudo",
      "-n",
      "kill",
      "-TERM",
      "--",
      `-${String(processHandle.processGroupId)}`,
    ],
    { cwd: "/" },
  );
  await pollUntil(
    () => processHandle.child.exitCode,
    (exitCode) => exitCode !== null,
    {
      description: "privileged SSH server shutdown",
      timeoutMs: 5_000,
    },
  );
}

async function waitForSsh(
  server: ManagedSshServer,
  identityFile: string,
): Promise<void> {
  await pollUntil(
    async () => await runCommand(
      [
        "ssh",
        "-i",
        identityFile,
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "LogLevel=ERROR",
        "-p",
        String(server.port),
        `${server.username}@127.0.0.1`,
        "--",
        "printf SSH_READY",
      ],
      {
        cwd: server.directory,
        env: currentEnvironment(),
      },
    ),
    (result) => result.exitCode === 0 && result.stdout === "SSH_READY",
    {
      description: "ephemeral SSH server startup",
      timeoutMs: LIFECYCLE_TIMEOUT_MS,
      formatLastObserved: (result) => JSON.stringify(result),
    },
  );
}

function startSshd(
  options: SshServerOptions,
  directory: string,
  sshdPath: string,
  configPath: string,
): ManagedProcess {
  return startManagedProcess(
    [...sshdCommand(sshdPath), "-D", "-e", "-f", configPath],
    {
      cwd: directory,
      env: currentEnvironment({
        HOME: options.clientHomeDirectory,
        PATH: `${options.providerBinDirectory}:${process.env["PATH"] ?? ""}`,
      }),
      stdoutPath: join(directory, "sshd.stdout.log"),
      stderrPath: join(directory, "sshd.stderr.log"),
    },
  );
}

export async function startEphemeralSshServer(
  options: SshServerOptions,
): Promise<ManagedSshServer> {
  const directory = join(options.runDirectory, "ssh-server");
  const sshDirectory = join(options.clientHomeDirectory, ".ssh");
  const identityFile = join(sshDirectory, "id_ed25519");
  const hostKeyFile = join(directory, "ssh_host_ed25519_key");
  const authorizedKeysFile = join(directory, "authorized_keys");
  const configPath = join(directory, "sshd_config");
  const username = userInfo().username;
  const port = await findFreeLoopbackPort();
  await Promise.all([
    mkdir(directory, { recursive: true, mode: 0o700 }),
    mkdir(sshDirectory, { recursive: true, mode: 0o700 }),
  ]);

  const sshdPath = (await requireCommand(
    ["sh", "-c", "command -v sshd"],
    { cwd: directory },
  )).stdout.trim();
  if (!isRoot()) {
    await requireCommand(["sudo", "-n", "true"], { cwd: directory });
  }
  await requireCommand(
    isRoot()
      ? ["install", "-d", "-m", "0755", "/run/sshd"]
      : ["sudo", "-n", "install", "-d", "-m", "0755", "/run/sshd"],
    { cwd: directory },
  );
  await Promise.all([
    requireCommand(
      ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", identityFile],
      { cwd: directory },
    ),
    requireCommand(
      ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", hostKeyFile],
      { cwd: directory },
    ),
  ]);
  await Promise.all([
    chmod(sshDirectory, 0o700),
    chmod(identityFile, 0o600),
    chmod(hostKeyFile, 0o600),
  ]);
  await Bun.write(authorizedKeysFile, await Bun.file(`${identityFile}.pub`).text());
  await Bun.write(
    join(options.clientHomeDirectory, ".bash_profile"),
    `export PATH='${options.providerBinDirectory.replaceAll("'", "'\\''")}':/usr/local/bin:/usr/bin:/bin\n`,
  );
  // Hosted CI users can have a locked password while still allowing public-key login.
  await Bun.write(configPath, [
    `Port ${String(port)}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${hostKeyFile}`,
    `PidFile ${join(directory, "sshd.pid")}`,
    `AuthorizedKeysFile ${authorizedKeysFile}`,
    "PubkeyAuthentication yes",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "ChallengeResponseAuthentication no",
    "PermitRootLogin yes",
    "UsePAM yes",
    "StrictModes no",
    `AllowUsers ${username}`,
    `SetEnv HOME=${options.clientHomeDirectory}`,
    `SetEnv PATH=${options.providerBinDirectory}:/usr/local/bin:/usr/bin:/bin`,
    "Subsystem sftp internal-sftp",
    "LogLevel VERBOSE",
    "",
  ].join("\n"));

  const agentSocket = join(directory, "ssh-agent.sock");
  const agentProcess = startManagedProcess(
    ["ssh-agent", "-D", "-a", agentSocket],
    {
      cwd: directory,
      env: currentEnvironment(),
      stdoutPath: join(directory, "ssh-agent.stdout.log"),
      stderrPath: join(directory, "ssh-agent.stderr.log"),
    },
  );
  let processHandle: ManagedProcess | null = null;
  try {
    await pollUntil(
      async () => await runCommand(["test", "-S", agentSocket], { cwd: directory }),
      (result) => result.exitCode === 0,
      {
        description: "ephemeral SSH agent startup",
        timeoutMs: 5_000,
        formatLastObserved: (result) => JSON.stringify(result),
      },
    );
    await requireCommand(
      ["ssh-add", identityFile],
      {
        cwd: directory,
        env: currentEnvironment({ SSH_AUTH_SOCK: agentSocket }),
      },
    );
    await requireCommand(
      [...sshdCommand(sshdPath), "-t", "-f", configPath],
      { cwd: directory },
    );
    processHandle = startSshd(
      options,
      directory,
      sshdPath,
      configPath,
    );
    const server: ManagedSshServer = {
      agentProcess,
      agentSocket,
      directory,
      port,
      process: processHandle,
      username,
    };
    await waitForSsh(server, identityFile);
    return server;
  } catch (error) {
    const diagnostics = (
      await Promise.all([
        readProcessDiagnostics(agentProcess),
        processHandle ? readProcessDiagnostics(processHandle) : "",
      ])
    ).filter(Boolean).join("\n\n");
    if (processHandle) {
      await stopPrivilegedProcess(processHandle).catch(() => undefined);
    }
    await stopManagedProcess(agentProcess).catch(() => undefined);
    throw new Error(
      `Failed to start ephemeral SSH server${diagnostics ? `:\n${diagnostics}` : ""}`,
      { cause: error },
    );
  }
}

export async function restartEphemeralSshServer(
  server: ManagedSshServer,
  options: SshServerOptions,
): Promise<void> {
  await stopPrivilegedProcess(server.process);
  const sshdPath = (await requireCommand(
    ["sh", "-c", "command -v sshd"],
    { cwd: server.directory },
  )).stdout.trim();
  server.process = startSshd(
    options,
    server.directory,
    sshdPath,
    join(server.directory, "sshd_config"),
  );
  await waitForSsh(
    server,
    join(options.clientHomeDirectory, ".ssh", "id_ed25519"),
  );
}

export async function stopEphemeralSshServer(
  server: ManagedSshServer,
): Promise<void> {
  await stopPrivilegedProcess(server.process);
  await stopManagedProcess(server.agentProcess);
  await rm(server.directory, { recursive: true, force: true });
}
