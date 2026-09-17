/**
 * Internal core helpers: runGitCommand, error helpers, and SSH host-key retry logic.
 * These are NOT exported from the package public API.
 */

import {
  resolveCommandExecutorDirectory,
  type CommandExecutor,
  type GitCommandScope,
} from "../command-executor";
import { log } from "@pablozaiden/webapp/server";
import { GitCommandError } from "./git-types";
import type { GitCommandResult } from "./git-types";
import { normalizeExecutionRoot } from "../execution-path";

const DEFAULT_GIT_SSH_COMMAND = "ssh";
const ACCEPT_NEW_HOST_KEY_OPTION = "-o StrictHostKeyChecking=accept-new";
const KNOWN_HOSTS_OPTION_NAME = "UserKnownHostsFile";
const CLANKY_KNOWN_HOSTS_FILENAME = "clanky-known-hosts";

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * Run a git command in the specified directory using the given executor.
 */
export async function resolveGitDirectory(
  executor: CommandExecutor,
  directory: string,
): Promise<string> {
  return resolveCommandExecutorDirectory(executor, directory);
}

export async function runGitCommand(
  executor: CommandExecutor,
  directory: string,
  args: string[],
  options: {
    allowFailure?: boolean;
    scope?: GitCommandScope;
  } = {},
): Promise<GitCommandResult> {
  const { allowFailure = false } = options;
  const cmdStr = `git ${args.join(" ")}`;
  const gitDirectory = await resolveGitDirectory(executor, directory);
  log.trace(`[GitService] Running: ${cmdStr} in ${gitDirectory}`);
  let result = await executor.execGit(gitDirectory, args, {
    scope: options.scope ?? "repository",
    logFailures: false,
  });

  if (!result.success && shouldRetryWithAcceptedHostKey(result.stderr)) {
    log.info(`[GitService] Retrying with auto-accepted SSH host key: ${cmdStr}`);
    const retryEnv = await buildAcceptedHostKeyRetryEnv(executor, directory);
    result = await executor.execGit(gitDirectory, args, {
      scope: options.scope ?? "repository",
      logFailures: false,
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
  const environmentCommand = await executor.getGitEnvironmentVariable(
    "GIT_SSH_COMMAND",
  );
  if (environmentCommand?.trim()) {
    return environmentCommand.trim();
  }

  const gitDirectory = await resolveGitDirectory(executor, directory);
  const configResult = await executor.execGit(gitDirectory, ["config", "--get", "core.sshCommand"], {
    scope: "repository",
    logFailures: false,
  });
  if (configResult.success) {
    const configCommand = configResult.stdout.trim();
    if (configCommand) return configCommand;
  }

  return DEFAULT_GIT_SSH_COMMAND;
}

async function getGitKnownHostsPath(executor: CommandExecutor, directory: string): Promise<string | null> {
  const gitDirectory = await resolveGitDirectory(executor, directory);
  const result = await executor.execGit(
    gitDirectory,
    [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      CLANKY_KNOWN_HOSTS_FILENAME,
    ],
    { scope: "repository", logFailures: false },
  );
  if (!result.success) {
    log.warn(`[GitService] Failed to resolve git known-hosts path for ${directory}: ${result.stderr || result.stdout || "unknown error"}`);
    return null;
  }

  const gitPath = result.stdout.trim();
  if (!gitPath) return null;

  return normalizeExecutionRoot(gitPath, executor.pathStyle);
}
