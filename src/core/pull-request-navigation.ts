/**
 * Helpers for resolving a pull request destination for pushed tasks.
 */

import type { CommandExecutor } from "./command-executor";
import { createLogger } from "./logger";
import type { Task, PullRequestMonitoringState } from "../types/task";
import type { PullRequestDestinationResponse } from "../types/api";
import { normalizeGitHubRepositoryUrl } from "../lib/github-repository-url";

export { normalizeGitHubRepositoryUrl } from "../lib/github-repository-url";

export interface PullRequestNavigationGitService {
  getDefaultBranch(directory: string): Promise<string>;
  getRemoteUrl(directory: string, remote?: string): Promise<string>;
  hasRemote(directory: string, remote?: string): Promise<boolean>;
}

const GH_UNAVAILABLE_REASON = "GitHub CLI is not available in the task environment.";
const NO_GITHUB_REMOTE_REASON = "Could not determine a GitHub origin remote for this task.";
const log = createLogger("core:pull-request-navigation");

interface PullRequestView {
  number?: unknown;
  url?: unknown;
  state?: unknown;
  mergedAt?: unknown;
}

function disabled(disabledReason: string): PullRequestDestinationResponse {
  return {
    enabled: false,
    destinationType: "disabled",
    disabledReason,
  };
}

export function buildGitHubCompareUrl(
  repositoryUrl: string,
  baseBranch: string,
  headBranch: string,
): string {
  return `${repositoryUrl}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headBranch)}?expand=1`;
}

export function validateExistingPullRequestUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname !== "github.com") {
      return null;
    }

    if (!/\/pull\/\d+$/u.test(parsed.pathname)) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

function getBaseBranch(task: Task): string | null {
  const configuredBaseBranch = task.config.baseBranch?.trim();
  if (configuredBaseBranch) {
    return configuredBaseBranch;
  }

  const originalBranch = task.state.git?.originalBranch?.trim();
  if (originalBranch) {
    return originalBranch;
  }

  return null;
}

function getWorkingBranch(task: Task): string | null {
  const workingBranch = task.state.git?.workingBranch?.trim();
  return workingBranch ? workingBranch : null;
}

function createMonitoringState(
  lastCheckedAt: string,
  monitoring: Omit<PullRequestMonitoringState, "lastCheckedAt">,
): PullRequestMonitoringState {
  return {
    ...monitoring,
    lastCheckedAt,
  };
}

function parsePullRequestView(stdout: string): PullRequestView | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as PullRequestView;
  } catch (error) {
    log.warn("Failed to parse gh pr view output", {
      error: String(error),
      stdout: trimmed,
    });
    return null;
  }
}

function mapPullRequestViewToMonitoringState(
  pullRequestView: PullRequestView,
  lastCheckedAt: string,
): PullRequestMonitoringState {
  const pullRequestNumber = typeof pullRequestView.number === "number"
    ? pullRequestView.number
    : undefined;
  const pullRequestUrl = typeof pullRequestView.url === "string"
    ? validateExistingPullRequestUrl(pullRequestView.url)
    : null;
  const state = typeof pullRequestView.state === "string"
    ? pullRequestView.state.toUpperCase()
    : "";
  const mergedAt = typeof pullRequestView.mergedAt === "string" && pullRequestView.mergedAt.trim()
    ? pullRequestView.mergedAt
    : undefined;

  const withCommonFields = (status: PullRequestMonitoringState["status"]): PullRequestMonitoringState => {
    const monitoringState = createMonitoringState(lastCheckedAt, { status });
    if (pullRequestNumber !== undefined) {
      monitoringState.pullRequestNumber = pullRequestNumber;
    }
    if (pullRequestUrl) {
      monitoringState.pullRequestUrl = pullRequestUrl;
    }
    if (mergedAt) {
      monitoringState.mergedAt = mergedAt;
    }
    return monitoringState;
  };

  if (state === "MERGED" || mergedAt) {
    const monitoringState = withCommonFields("merged");
    if (!monitoringState.mergedAt) {
      monitoringState.mergedAt = lastCheckedAt;
    }
    return monitoringState;
  }
  if (state === "OPEN") {
    return withCommonFields("open");
  }
  if (state === "CLOSED") {
    return withCommonFields("closed");
  }

  return createMonitoringState(lastCheckedAt, {
    status: "error",
    lastError: `Unexpected pull request state: ${state || "missing"}`,
  });
}

function isNoPullRequestError(stderr: string): boolean {
  return /no pull requests found/i.test(stderr);
}

async function isGhAvailable(executor: CommandExecutor, directory: string): Promise<boolean> {
  const ghVersionResult = await executor.exec("gh", ["--version"], { cwd: directory, timeout: 5000 });
  return ghVersionResult.success;
}

export async function probePullRequestMonitoring(
  task: Task,
  directory: string,
  executor: CommandExecutor,
  git: PullRequestNavigationGitService,
): Promise<PullRequestMonitoringState> {
  const lastCheckedAt = new Date().toISOString();
  const workingBranch = getWorkingBranch(task);
  if (!workingBranch) {
    return createMonitoringState(lastCheckedAt, {
      status: "error",
      lastError: "This task does not have a working branch to monitor.",
    });
  }

  if (!(await isGhAvailable(executor, directory))) {
    return createMonitoringState(lastCheckedAt, {
      status: "unavailable",
      lastError: GH_UNAVAILABLE_REASON,
    });
  }

  try {
    const remoteUrl = await git.getRemoteUrl(directory, "origin");
    if (!normalizeGitHubRepositoryUrl(remoteUrl)) {
      return createMonitoringState(lastCheckedAt, {
        status: "unavailable",
        lastError: NO_GITHUB_REMOTE_REASON,
      });
    }
  } catch (error) {
    return createMonitoringState(lastCheckedAt, {
      status: "error",
      lastError: String(error),
    });
  }

  const prViewResult = await executor.exec(
    "gh",
    ["pr", "view", workingBranch, "--json", "number,url,state,mergedAt"],
    { cwd: directory, timeout: 10000 },
  );
  if (!prViewResult.success) {
    const stderr = prViewResult.stderr.trim();
    if (isNoPullRequestError(stderr)) {
      return createMonitoringState(lastCheckedAt, { status: "no_pr" });
    }
    return createMonitoringState(lastCheckedAt, {
      status: "error",
      lastError: stderr || `gh pr view exited with code ${prViewResult.exitCode}`,
    });
  }

  const pullRequestView = parsePullRequestView(prViewResult.stdout);
  if (!pullRequestView) {
    return createMonitoringState(lastCheckedAt, {
      status: "error",
      lastError: "GitHub CLI returned invalid pull request JSON.",
    });
  }

  return mapPullRequestViewToMonitoringState(pullRequestView, lastCheckedAt);
}

export async function resolvePullRequestDestination(
  task: Task,
  directory: string,
  executor: CommandExecutor,
  git: PullRequestNavigationGitService,
): Promise<PullRequestDestinationResponse> {
  const workingBranch = getWorkingBranch(task);
  if (!workingBranch) {
    return disabled("This task does not have a working branch to compare.");
  }

  if (!(await isGhAvailable(executor, directory))) {
    return disabled(GH_UNAVAILABLE_REASON);
  }

  const prViewResult = await executor.exec(
    "gh",
    ["pr", "view", workingBranch, "--json", "url", "-q", ".url"],
    { cwd: directory, timeout: 10000 },
  );
  const existingPrUrl = prViewResult.stdout.trim();
  if (prViewResult.success && existingPrUrl.length > 0) {
    const validatedExistingPrUrl = validateExistingPullRequestUrl(existingPrUrl);
    if (validatedExistingPrUrl) {
      return {
        enabled: true,
        destinationType: "existing_pr",
        url: validatedExistingPrUrl,
      };
    }

    log.warn("Ignoring invalid gh pr view URL output", {
      directory,
      existingPrUrl,
    });
  }

  const remoteUrl = await git.getRemoteUrl(directory, "origin");
  const repositoryUrl = normalizeGitHubRepositoryUrl(remoteUrl);
  if (!repositoryUrl) {
    return disabled(NO_GITHUB_REMOTE_REASON);
  }

  const baseBranch = getBaseBranch(task) ?? await git.getDefaultBranch(directory);
  return {
    enabled: true,
    destinationType: "create_pr",
    url: buildGitHubCompareUrl(repositoryUrl, baseBranch, workingBranch),
  };
}
