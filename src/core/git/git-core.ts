/**
 * Internal core helpers: runGitCommand, error helpers, and SSH host-key retry logic.
 * These are NOT exported from the package public API.
 */

import type { CommandExecutor } from "../command-executor";
import { log } from "@pablozaiden/webapp/server";
import { GitCommandError } from "./git-types";
import type { GitCommandResult } from "./git-types";
import { resolve } from "node:path";

const DEFAULT_GIT_SSH_COMMAND = "ssh";
const ACCEPT_NEW_HOST_KEY_OPTION = "-o StrictHostKeyChecking=accept-new";
const KNOWN_HOSTS_OPTION_NAME = "UserKnownHostsFile";
const CLANKY_KNOWN_HOSTS_FILENAME = "clanky-known-hosts";
const LOCAL_GIT_FALLBACK_COMMANDS = ["/usr/local/bin/git", "/usr/bin/git"];

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * Run a git command in the specified directory using the given executor.
 */
export async function runGitCommand(
  executor: CommandExecutor,
  directory: string,
  args: string[],
  options: { allowFailure?: boolean } = {}
): Promise<GitCommandResult> {
  const { allowFailure = false } = options;
  const cmdStr = `git ${args.join(" ")}`;
  log.trace(`[GitService] Running: ${cmdStr} in ${directory}`);
  const gitArgs = ["-C", directory, ...args];
  let result = await executor.exec("git", gitArgs, { cwd: directory });

  if (!result.success && result.stderr.includes("posix_spawn 'git'")) {
    for (const fallbackCommand of LOCAL_GIT_FALLBACK_COMMANDS) {
      log.debug(`[GitService] Retrying with local git fallback: ${fallbackCommand}`);
      result = await executor.exec(fallbackCommand, gitArgs, { cwd: directory });
      if (result.success || !result.stderr.includes("ENOENT")) {
        break;
      }
    }
  }

  if (!result.success && shouldRetryWithAcceptedHostKey(result.stderr)) {
    log.info(`[GitService] Retrying with auto-accepted SSH host key: ${cmdStr}`);
    const retryEnv = await buildAcceptedHostKeyRetryEnv(executor, directory);
    result = await executor.exec("git", gitArgs, {
      cwd: directory,
      ...(retryEnv ? { env: retryEnv } : {}),
    });
  }

  if (!result.success) {
    if (allowFailure) {
      log.trace(`[GitService] Command failed (expected): ${cmdStr}`);
      log.trace(`[GitService]   exitCode: ${result.exitCode}`);
      log.trace(`[GitService]   stderr: ${result.stderr || "(empty)"}`);
      if (result.stdout) {
        log.trace(`[GitService]   stdout: ${result.stdout.slice(0, 300)}${result.stdout.length > 300 ? "..." : ""}`);
      }
    } else {
      log.error(`[GitService] Command failed: ${cmdStr}`);
      log.error(`[GitService]   exitCode: ${result.exitCode}`);
      log.error(`[GitService]   stderr: ${result.stderr || "(empty)"}`);
      if (result.stdout) {
        log.error(`[GitService]   stdout: ${result.stdout.slice(0, 300)}${result.stdout.length > 300 ? "..." : ""}`);
      }
    }
  } else {
    log.trace(`[GitService] Command succeeded: ${cmdStr}`);
  }

  return {
    success: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

/**
 * Create a GitCommandError from a failed git command result.
 */
export function gitError(message: string, result: GitCommandResult, args: string[]): GitCommandError {
  const command = `git ${args.join(" ")}`;
  return new GitCommandError(
    `${message}: ${result.stderr || "(no stderr)"}`,
    command,
    result.exitCode,
    result.stderr,
  );
}

function shouldRetryWithAcceptedHostKey(stderr: string): boolean {
  return stderr.includes("Host key verification failed");
}

async function buildAcceptedHostKeyRetryEnv(
  executor: CommandExecutor,
  directory: string
): Promise<Record<string, string>> {
  const baseSshCommand = await getConfiguredGitSshCommand(executor, directory);
  const knownHostsPath = await getGitKnownHostsPath(executor, directory);
  const sshCommand = knownHostsPath
    ? `${baseSshCommand} ${ACCEPT_NEW_HOST_KEY_OPTION} -o ${KNOWN_HOSTS_OPTION_NAME}=${quoteShellArg(knownHostsPath)}`
    : `${baseSshCommand} ${ACCEPT_NEW_HOST_KEY_OPTION}`;

  return { GIT_SSH_COMMAND: sshCommand };
}

async function getConfiguredGitSshCommand(executor: CommandExecutor, directory: string): Promise<string> {
  const envResult = await executor.exec("bash", ["-lc", "printf %s \"${GIT_SSH_COMMAND:-}\""], {
    cwd: directory,
  });
  if (envResult.success) {
    const envCommand = envResult.stdout.trim();
    if (envCommand) return envCommand;
  }

  const configResult = await executor.exec("git", ["-C", directory, "config", "--get", "core.sshCommand"], {
    cwd: directory,
  });
  if (configResult.success) {
    const configCommand = configResult.stdout.trim();
    if (configCommand) return configCommand;
  }

  return DEFAULT_GIT_SSH_COMMAND;
}

async function getGitKnownHostsPath(executor: CommandExecutor, directory: string): Promise<string | null> {
  const result = await executor.exec(
    "git",
    ["-C", directory, "rev-parse", "--git-path", CLANKY_KNOWN_HOSTS_FILENAME],
    { cwd: directory }
  );
  if (!result.success) {
    log.warn(`[GitService] Failed to resolve git known-hosts path for ${directory}: ${result.stderr || result.stdout || "unknown error"}`);
    return null;
  }

  const gitPath = result.stdout.trim();
  if (!gitPath) return null;

  return gitPath.startsWith("/") ? gitPath : resolve(directory, gitPath);
}
