/**
 * GitHub CLI helpers for the automatic PR flow.
 */

import type { CommandExecutor } from "./command-executor";
import type { Loop } from "../types/loop";
import type { PullRequestNavigationGitService } from "./pull-request-navigation";
import { backendManager } from "./backend-manager";
import { getDiff, getDiffSummary } from "./git/git-diff";
import { createLogger } from "./logger";
import { resolveEffectiveCheapModel } from "./cheap-model";
import {
  buildFallbackPullRequestMetadata,
  generatePullRequestMetadata,
  type PullRequestMetadata,
  type PullRequestMetadataInput,
} from "./pull-request-metadata";
import {
  normalizeGitHubRepositoryUrl,
  validateExistingPullRequestUrl,
} from "./pull-request-navigation";

const log = createLogger("core:automatic-pr-flow-github");

const GH_UNAVAILABLE_REASON = "GitHub CLI is not available in the loop environment.";
const NO_GITHUB_REMOTE_REASON = "Could not determine a GitHub origin remote for this loop.";

interface PullRequestView {
  number?: unknown;
  url?: unknown;
  state?: unknown;
  mergedAt?: unknown;
  reviewDecision?: unknown;
}

interface RepositoryCoordinates {
  owner: string;
  name: string;
  repositoryUrl: string;
}

interface GraphQlUser {
  login?: unknown;
}

interface GraphQlCommentNode {
  id?: unknown;
  body?: unknown;
  createdAt?: unknown;
  url?: unknown;
  author?: GraphQlUser | null;
  path?: unknown;
  originalLine?: unknown;
}

interface GraphQlThreadNode {
  id?: unknown;
  isResolved?: unknown;
  isOutdated?: unknown;
  isCollapsed?: unknown;
  comments?: {
    nodes?: GraphQlCommentNode[] | null;
  } | null;
}

interface GraphQlReviewNode {
  id?: unknown;
  body?: unknown;
  state?: unknown;
  submittedAt?: unknown;
  url?: unknown;
  author?: GraphQlUser | null;
}

interface GraphQlIssueCommentNode {
  id?: unknown;
  body?: unknown;
  createdAt?: unknown;
  url?: unknown;
  author?: GraphQlUser | null;
}

interface PullRequestDetailsQueryResponse {
  data?: {
    repository?: {
      pullRequest?: {
        number?: unknown;
        url?: unknown;
        state?: unknown;
        reviewDecision?: unknown;
        reviewThreads?: { nodes?: GraphQlThreadNode[] | null } | null;
        comments?: { nodes?: GraphQlIssueCommentNode[] | null } | null;
        reviews?: { nodes?: GraphQlReviewNode[] | null } | null;
      } | null;
    } | null;
  } | null;
}

export interface AutomaticPrFlowPullRequest {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
  mergedAt?: string;
}

export interface AutomaticPrFlowFeedbackItem {
  id: string;
  source: "review_thread" | "review_comment" | "review";
  body: string;
  authorLogin?: string;
  createdAt?: string;
  url?: string;
  threadId?: string;
  path?: string;
  line?: number;
}

export interface AutomaticPrFlowSnapshot {
  pullRequest: AutomaticPrFlowPullRequest;
  reviewThreads: AutomaticPrFlowFeedbackItem[];
  reviewComments: AutomaticPrFlowFeedbackItem[];
  reviews: AutomaticPrFlowFeedbackItem[];
  actionableItems: AutomaticPrFlowFeedbackItem[];
}

function getWorkingBranch(loop: Loop): string | null {
  const workingBranch = loop.state.git?.workingBranch?.trim();
  return workingBranch ? workingBranch : null;
}

function getBaseBranch(loop: Loop): string | null {
  const configuredBaseBranch = loop.config.baseBranch?.trim();
  if (configuredBaseBranch) {
    return configuredBaseBranch;
  }

  const originalBranch = loop.state.git?.originalBranch?.trim();
  return originalBranch ? originalBranch : null;
}

async function isGhAvailable(executor: CommandExecutor, directory: string): Promise<boolean> {
  const result = await executor.exec("gh", ["--version"], { cwd: directory, timeout: 5000 });
  return result.success;
}

function parsePullRequestView(stdout: string): PullRequestView | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as PullRequestView;
  } catch (error) {
    log.warn("Failed to parse gh pull request JSON", {
      error: String(error),
      stdout: trimmed,
    });
    return null;
  }
}

function normalizePullRequestState(rawState: unknown): AutomaticPrFlowPullRequest["state"] | null {
  if (typeof rawState !== "string") {
    return null;
  }

  const upperState = rawState.toUpperCase();
  if (upperState === "OPEN" || upperState === "CLOSED" || upperState === "MERGED") {
    return upperState;
  }

  return null;
}

function normalizeReviewDecision(
  rawReviewDecision: unknown,
): AutomaticPrFlowPullRequest["reviewDecision"] | undefined {
  if (typeof rawReviewDecision !== "string") {
    return undefined;
  }

  const upperDecision = rawReviewDecision.toUpperCase();
  if (
    upperDecision === "APPROVED"
    || upperDecision === "CHANGES_REQUESTED"
    || upperDecision === "REVIEW_REQUIRED"
  ) {
    return upperDecision;
  }

  return undefined;
}

function parseRepositoryCoordinates(remoteUrl: string): RepositoryCoordinates | null {
  const repositoryUrl = normalizeGitHubRepositoryUrl(remoteUrl);
  if (!repositoryUrl) {
    return null;
  }

  const parsed = new URL(repositoryUrl);
  const [owner, name] = parsed.pathname.replace(/^\/+/u, "").split("/", 2);
  if (!owner || !name) {
    return null;
  }

  return { owner, name, repositoryUrl };
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isNoPullRequestError(stderr: string): boolean {
  return /no pull requests found/i.test(stderr);
}

async function buildPullRequestMetadataInput(
  loop: Loop,
  directory: string,
  executor: CommandExecutor,
  baseBranch: string,
): Promise<PullRequestMetadataInput> {
  let changedFiles: PullRequestMetadataInput["changedFiles"] = [];
  let diffSummary: PullRequestMetadataInput["diffSummary"] = {
    files: 0,
    insertions: 0,
    deletions: 0,
  };

  try {
    changedFiles = await getDiff(executor, directory, baseBranch);
  } catch (error) {
    log.warn("Failed to load diff details for automatic PR metadata", {
      loopId: loop.config.id,
      baseBranch,
      error: String(error),
    });
  }

  try {
    diffSummary = await getDiffSummary(executor, directory, baseBranch);
  } catch (error) {
    log.warn("Failed to load diff summary for automatic PR metadata", {
      loopId: loop.config.id,
      baseBranch,
      error: String(error),
    });
  }

  return {
    loopName: loop.config.name,
    originalPrompt: loop.config.prompt,
    baseBranch,
    workingBranch: loop.state.git?.workingBranch ?? "",
    commitMessages: loop.state.git?.commits.map((commit) => commit.message) ?? [],
    changedFiles,
    diffSummary,
  };
}

async function generateAutomaticPrMetadata(
  loop: Loop,
  directory: string,
  executor: CommandExecutor,
  baseBranch: string,
): Promise<PullRequestMetadata> {
  const metadataInput = await buildPullRequestMetadataInput(loop, directory, executor, baseBranch);
  try {
    let backend = backendManager.getInitializedBackend(loop.config.workspaceId);
    if (
      !backend
      || !backendManager.isWorkspaceConnected(loop.config.workspaceId)
      || backend.getDirectory() !== directory
    ) {
      await backendManager.connect(loop.config.workspaceId, directory);
      backend = backendManager.getBackend(loop.config.workspaceId);
    }

    const tempSession = await backend.createSession({
      title: "Pull Request Metadata Generation",
      directory,
    });

    try {
      const helperModel = await resolveEffectiveCheapModel({
        workspaceId: loop.config.workspaceId,
        directory,
        model: loop.config.model,
        cheapModel: loop.config.cheapModel,
        operation: "pull_request_metadata_generation",
      });
      return await generatePullRequestMetadata({
        metadata: metadataInput,
        backend,
        sessionId: tempSession.id,
        model: helperModel,
      });
    } finally {
      try {
        await backend.abortSession(tempSession.id);
      } catch (cleanupError) {
        log.warn("Failed to clean up temporary PR metadata session", {
          loopId: loop.config.id,
          error: String(cleanupError),
        });
      }
    }
  } catch (error) {
    log.warn("Failed to generate automatic PR metadata via backend, using fallback", {
      loopId: loop.config.id,
      error: String(error),
    });
    return buildFallbackPullRequestMetadata(metadataInput);
  }
}

function parseExistingPullRequest(pullRequestView: PullRequestView): AutomaticPrFlowPullRequest | null {
  const number = toNumberValue(pullRequestView.number);
  const url = typeof pullRequestView.url === "string"
    ? validateExistingPullRequestUrl(pullRequestView.url)
    : null;
  const state = normalizePullRequestState(pullRequestView.state);
  if (number === undefined || !url || !state) {
    return null;
  }

  return {
    number,
    url,
    state,
    mergedAt: toStringValue(pullRequestView.mergedAt),
    reviewDecision: normalizeReviewDecision(pullRequestView.reviewDecision),
  };
}

async function getExistingPullRequest(
  workingBranch: string,
  directory: string,
  executor: CommandExecutor,
): Promise<AutomaticPrFlowPullRequest | null> {
  const result = await executor.exec(
    "gh",
    ["pr", "view", workingBranch, "--json", "number,url,state,mergedAt,reviewDecision"],
    { cwd: directory, timeout: 10000 },
  );
  if (!result.success) {
    if (isNoPullRequestError(result.stderr.trim())) {
      return null;
    }
    throw new Error(result.stderr.trim() || `gh pr view exited with code ${result.exitCode}`);
  }

  const parsed = parsePullRequestView(result.stdout);
  if (!parsed) {
    throw new Error("GitHub CLI returned invalid pull request JSON.");
  }

  const normalized = parseExistingPullRequest(parsed);
  if (!normalized) {
    throw new Error("GitHub CLI returned incomplete pull request metadata.");
  }

  return normalized;
}

export async function ensureAutomaticPrFlowPullRequest(
  loop: Loop,
  directory: string,
  executor: CommandExecutor,
  git: PullRequestNavigationGitService,
): Promise<AutomaticPrFlowPullRequest> {
  const workingBranch = getWorkingBranch(loop);
  if (!workingBranch) {
    throw new Error("This loop does not have a working branch to open a pull request for.");
  }

  if (!(await isGhAvailable(executor, directory))) {
    throw new Error(GH_UNAVAILABLE_REASON);
  }

  const remoteUrl = await git.getRemoteUrl(directory, "origin");
  if (!parseRepositoryCoordinates(remoteUrl)) {
    throw new Error(NO_GITHUB_REMOTE_REASON);
  }

  const existingPullRequest = await getExistingPullRequest(workingBranch, directory, executor);
  if (existingPullRequest) {
    return existingPullRequest;
  }

  const baseBranch = getBaseBranch(loop) ?? await git.getDefaultBranch(directory);
  const metadata = await generateAutomaticPrMetadata(loop, directory, executor, baseBranch);
  const createResult = await executor.exec(
    "gh",
    [
      "pr",
      "create",
      "--base",
      baseBranch,
      "--head",
      workingBranch,
      "--title",
      metadata.title,
      "--body",
      metadata.body,
    ],
    { cwd: directory, timeout: 15000 },
  );
  if (!createResult.success) {
    throw new Error(createResult.stderr.trim() || `gh pr create exited with code ${createResult.exitCode}`);
  }

  const pullRequest = await getExistingPullRequest(workingBranch, directory, executor);
  if (!pullRequest) {
    throw new Error("Pull request creation succeeded but GitHub CLI could not load the new PR.");
  }

  return pullRequest;
}

function normalizeReviewThread(thread: GraphQlThreadNode): AutomaticPrFlowFeedbackItem | null {
  const threadId = toStringValue(thread.id);
  const isResolved = thread.isResolved === true;
  const isOutdated = thread.isOutdated === true;
  if (!threadId || isResolved || isOutdated) {
    return null;
  }

  const comments = thread.comments?.nodes?.filter(Boolean) ?? [];
  const latestCommentWithBody = [...comments].reverse().find((comment) => toStringValue(comment.body));
  const latestComment = latestCommentWithBody ?? comments[comments.length - 1];
  if (!latestComment) {
    return null;
  }

  const body = toStringValue(latestComment.body);
  if (!body) {
    return null;
  }

  return {
    id: threadId,
    source: "review_thread",
    body,
    authorLogin: toStringValue(latestComment.author?.login),
    createdAt: toStringValue(latestComment.createdAt),
    url: toStringValue(latestComment.url),
    threadId,
    path: toStringValue(latestComment.path),
    line: toNumberValue(latestComment.originalLine),
  };
}

function normalizeReviewComment(comment: GraphQlIssueCommentNode): AutomaticPrFlowFeedbackItem | null {
  const id = toStringValue(comment.id);
  const body = toStringValue(comment.body);
  if (!id || !body) {
    return null;
  }

  return {
    id,
    source: "review_comment",
    body,
    authorLogin: toStringValue(comment.author?.login),
    createdAt: toStringValue(comment.createdAt),
    url: toStringValue(comment.url),
  };
}

function normalizeReview(review: GraphQlReviewNode): AutomaticPrFlowFeedbackItem | null {
  const id = toStringValue(review.id);
  const body = toStringValue(review.body);
  const state = toStringValue(review.state)?.toUpperCase();
  if (!id || !body || (state !== "CHANGES_REQUESTED" && state !== "COMMENTED")) {
    return null;
  }

  return {
    id,
    source: "review",
    body,
    authorLogin: toStringValue(review.author?.login),
    createdAt: toStringValue(review.submittedAt),
    url: toStringValue(review.url),
  };
}

function dedupeFeedbackItems(items: AutomaticPrFlowFeedbackItem[]): AutomaticPrFlowFeedbackItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

function parsePullRequestDetails(stdout: string): PullRequestDetailsQueryResponse {
  try {
    return JSON.parse(stdout) as PullRequestDetailsQueryResponse;
  } catch (error) {
    throw new Error(`GitHub CLI returned invalid GraphQL JSON: ${String(error)}`);
  }
}

export async function fetchAutomaticPrFlowSnapshot(
  pullRequest: AutomaticPrFlowPullRequest,
  directory: string,
  executor: CommandExecutor,
  git: PullRequestNavigationGitService,
): Promise<AutomaticPrFlowSnapshot> {
  if (!(await isGhAvailable(executor, directory))) {
    throw new Error(GH_UNAVAILABLE_REASON);
  }

  const remoteUrl = await git.getRemoteUrl(directory, "origin");
  const coordinates = parseRepositoryCoordinates(remoteUrl);
  if (!coordinates) {
    throw new Error(NO_GITHUB_REMOTE_REASON);
  }

  const result = await executor.exec(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number url state reviewDecision reviewThreads(first:100){nodes{id isResolved isOutdated isCollapsed comments(first:20){nodes{id body createdAt url author{login} path originalLine}}} } comments(first:100){nodes{id body createdAt url author{login}}} reviews(first:100){nodes{id body state submittedAt url author{login}}}}}}",
      "-F",
      `owner=${coordinates.owner}`,
      "-F",
      `name=${coordinates.name}`,
      "-F",
      `number=${pullRequest.number}`,
    ],
    { cwd: directory, timeout: 15000 },
  );
  if (!result.success) {
    throw new Error(result.stderr.trim() || `gh api graphql exited with code ${result.exitCode}`);
  }

  const parsed = parsePullRequestDetails(result.stdout);
  const responsePullRequest = parsed.data?.repository?.pullRequest;
  if (!responsePullRequest) {
    throw new Error("GitHub CLI returned pull request details without a pull request payload.");
  }

  const reviewThreads = dedupeFeedbackItems(
    (responsePullRequest.reviewThreads?.nodes ?? [])
      .map((thread) => normalizeReviewThread(thread))
      .filter((item): item is AutomaticPrFlowFeedbackItem => item !== null),
  );
  const reviewComments = dedupeFeedbackItems(
    (responsePullRequest.comments?.nodes ?? [])
      .map((comment) => normalizeReviewComment(comment))
      .filter((item): item is AutomaticPrFlowFeedbackItem => item !== null),
  );
  const reviews = dedupeFeedbackItems(
    (responsePullRequest.reviews?.nodes ?? [])
      .map((review) => normalizeReview(review))
      .filter((item): item is AutomaticPrFlowFeedbackItem => item !== null),
  );

  return {
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
      state: normalizePullRequestState(responsePullRequest.state) ?? pullRequest.state,
      reviewDecision: normalizeReviewDecision(responsePullRequest.reviewDecision) ?? pullRequest.reviewDecision,
      mergedAt: pullRequest.mergedAt,
    },
    reviewThreads,
    reviewComments,
    reviews,
    actionableItems: dedupeFeedbackItems([...reviewThreads, ...reviewComments, ...reviews]),
  };
}

export async function resolveAutomaticPrFlowReviewThread(
  threadId: string,
  directory: string,
  executor: CommandExecutor,
): Promise<void> {
  if (!threadId.trim()) {
    throw new Error("Review thread ID is required.");
  }

  if (!(await isGhAvailable(executor, directory))) {
    throw new Error(GH_UNAVAILABLE_REASON);
  }

  const result = await executor.exec(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      "query=mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}",
      "-F",
      `threadId=${threadId}`,
    ],
    { cwd: directory, timeout: 10000 },
  );
  if (!result.success) {
    throw new Error(result.stderr.trim() || `gh api graphql exited with code ${result.exitCode}`);
  }
}
