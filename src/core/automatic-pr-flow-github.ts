/**
 * GitHub CLI helpers for the automatic PR flow.
 */

import type { CommandExecutor } from "./command-executor";
import type {
  AutomaticPrFlowFeedbackSource,
  AutomaticPrFlowMergeStateStatus,
  Task,
} from "../types/task";
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

const GH_UNAVAILABLE_REASON = "GitHub CLI is not available in the task environment.";
const NO_GITHUB_REMOTE_REASON = "Could not determine a GitHub origin remote for this task.";
const MAX_WORKFLOW_FAILURE_TEXT_LENGTH = 4_000;
const WORKFLOW_FAILURE_CONCLUSIONS = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "STALE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);
const STATUS_FAILURE_STATES = new Set(["ERROR", "FAILURE"]);

interface PullRequestView {
  number?: unknown;
  url?: unknown;
  state?: unknown;
  mergedAt?: unknown;
  reviewDecision?: unknown;
  mergeStateStatus?: unknown;
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

interface GraphQlStatusCheckContextNode {
  __typename?: unknown;
  id?: unknown;
  databaseId?: unknown;
  name?: unknown;
  context?: unknown;
  workflowName?: unknown;
  status?: unknown;
  state?: unknown;
  conclusion?: unknown;
  detailsUrl?: unknown;
  targetUrl?: unknown;
  summary?: unknown;
  text?: unknown;
  description?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

interface GraphQlCommitNode {
  oid?: unknown;
  statusCheckRollup?: {
    contexts?: {
      nodes?: GraphQlStatusCheckContextNode[] | null;
    } | null;
  } | null;
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
        mergeStateStatus?: unknown;
        viewerCanUpdateBranch?: unknown;
        headRefOid?: unknown;
        commits?: {
          nodes?: Array<{
            commit?: GraphQlCommitNode | null;
          } | null> | null;
        } | null;
        reviewThreads?: { nodes?: GraphQlThreadNode[] | null } | null;
        comments?: { nodes?: GraphQlIssueCommentNode[] | null } | null;
        reviews?: { nodes?: GraphQlReviewNode[] | null } | null;
      } | null;
    } | null;
  } | null;
}

const PULL_REQUEST_DETAILS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name) {
    pullRequest(number:$number) {
      number
      url
      state
      reviewDecision
      mergeStateStatus
      viewerCanUpdateBranch
      headRefOid
      commits(last:1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first:100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    id
                    databaseId
                    name
                    workflowName
                    status
                    conclusion
                    detailsUrl
                    summary
                    text
                    startedAt
                    completedAt
                  }
                  ... on StatusContext {
                    id
                    context
                    state
                    description
                    targetUrl
                    createdAt
                    updatedAt
                  }
                }
              }
            }
          }
        }
      }
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          isOutdated
          isCollapsed
          comments(first:20) {
            nodes {
              id
              body
              createdAt
              url
              author {
                login
              }
              path
              originalLine
            }
          }
        }
      }
      comments(first:100) {
        nodes {
          id
          body
          createdAt
          url
          author {
            login
          }
        }
      }
      reviews(first:100) {
        nodes {
          id
          body
          state
          submittedAt
          url
          author {
            login
          }
        }
      }
    }
  }
}`;

export interface AutomaticPrFlowPullRequest {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
  mergeStateStatus?: AutomaticPrFlowMergeStateStatus;
  viewerCanUpdateBranch?: boolean;
  mergedAt?: string;
  headSha?: string;
}

export interface AutomaticPrFlowFeedbackItem {
  id: string;
  source: AutomaticPrFlowFeedbackSource;
  body: string;
  authorLogin?: string;
  createdAt?: string;
  url?: string;
  threadId?: string;
  path?: string;
  line?: number;
  headSha?: string;
  workflowName?: string;
  checkName?: string;
  checkConclusion?: string;
}

export interface AutomaticPrFlowSnapshot {
  pullRequest: AutomaticPrFlowPullRequest;
  reviewThreads: AutomaticPrFlowFeedbackItem[];
  reviewComments: AutomaticPrFlowFeedbackItem[];
  reviews: AutomaticPrFlowFeedbackItem[];
  workflowFailures: AutomaticPrFlowFeedbackItem[];
  actionableItems: AutomaticPrFlowFeedbackItem[];
}

function getWorkingBranch(task: Task): string | null {
  const workingBranch = task.state.git?.workingBranch?.trim();
  return workingBranch ? workingBranch : null;
}

function getBaseBranch(task: Task): string | null {
  const configuredBaseBranch = task.config.baseBranch?.trim();
  if (configuredBaseBranch) {
    return configuredBaseBranch;
  }

  const originalBranch = task.state.git?.originalBranch?.trim();
  return originalBranch ? originalBranch : null;
}

async function isGhAvailable(executor: CommandExecutor, directory: string): Promise<boolean> {
  const result = await executor.exec("gh", ["--version"], { cwd: directory, timeout: 5000 });
  return result.success;
}

async function getGitHubOriginRemoteUrl(
  directory: string,
  git: PullRequestNavigationGitService,
): Promise<string> {
  if (!(await git.hasRemote(directory, "origin"))) {
    throw new Error(NO_GITHUB_REMOTE_REASON);
  }

  const remoteUrl = await git.getRemoteUrl(directory, "origin");
  if (!parseRepositoryCoordinates(remoteUrl)) {
    throw new Error(NO_GITHUB_REMOTE_REASON);
  }
  return remoteUrl;
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

function normalizeMergeStateStatus(
  rawMergeStateStatus: unknown,
): AutomaticPrFlowPullRequest["mergeStateStatus"] | undefined {
  if (typeof rawMergeStateStatus !== "string") {
    return undefined;
  }

  const upperStatus = rawMergeStateStatus.toUpperCase();
  if (
    upperStatus === "BEHIND"
    || upperStatus === "BLOCKED"
    || upperStatus === "CLEAN"
    || upperStatus === "DIRTY"
    || upperStatus === "DRAFT"
    || upperStatus === "HAS_HOOKS"
    || upperStatus === "UNKNOWN"
    || upperStatus === "UNSTABLE"
  ) {
    return upperStatus;
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

function toBooleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toUpperString(value: unknown): string | undefined {
  const stringValue = toStringValue(value);
  return stringValue?.toUpperCase();
}

function truncateExternalText(value: unknown, maxLength: number): string | undefined {
  const stringValue = toStringValue(value);
  if (!stringValue) {
    return undefined;
  }

  return stringValue
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "")
    .trim()
    .slice(0, maxLength)
    .trim();
}

function buildWorkflowFailureId(
  sourceId: string,
  headSha: string,
  conclusion: string,
  completedAt?: string,
): string {
  return ["workflow", sourceId, headSha, conclusion, completedAt ?? ""].join(":");
}

function normalizeCheckRunFailure(
  checkRun: GraphQlStatusCheckContextNode,
  headSha: string,
): AutomaticPrFlowFeedbackItem | null {
  const sourceId = toStringValue(checkRun.id) ?? toStringValue(checkRun.databaseId);
  const status = toUpperString(checkRun.status);
  const conclusion = toUpperString(checkRun.conclusion);
  if (
    !sourceId
    || !headSha
    || status !== "COMPLETED"
    || !conclusion
    || !WORKFLOW_FAILURE_CONCLUSIONS.has(conclusion)
  ) {
    return null;
  }

  const checkName = truncateExternalText(checkRun.name, 200) ?? "Unnamed workflow check";
  const workflowName = truncateExternalText(checkRun.workflowName, 200);
  const completedAt = toStringValue(checkRun.completedAt);
  const details = [
    truncateExternalText(checkRun.summary, 2_000),
    truncateExternalText(checkRun.text, 2_000),
  ].filter((value): value is string => value !== undefined);
  const body = [
    `Workflow check "${checkName}" failed with conclusion ${conclusion}.`,
    workflowName ? `Workflow: ${workflowName}` : undefined,
    `Head commit: ${headSha}`,
    details.length > 0 ? `Reported details:\n${details.join("\n")}` : undefined,
  ].filter((value): value is string => value !== undefined).join("\n");

  return {
    id: buildWorkflowFailureId(sourceId, headSha, conclusion, completedAt),
    source: "workflow",
    body: truncateExternalText(body, MAX_WORKFLOW_FAILURE_TEXT_LENGTH) ?? body,
    createdAt: toStringValue(checkRun.startedAt) ?? completedAt,
    url: truncateExternalText(checkRun.detailsUrl, 500),
    headSha,
    workflowName,
    checkName,
    checkConclusion: conclusion,
  };
}

function normalizeStatusContextFailure(
  statusContext: GraphQlStatusCheckContextNode,
  headSha: string,
): AutomaticPrFlowFeedbackItem | null {
  const sourceId = toStringValue(statusContext.id) ?? toStringValue(statusContext.context);
  const context = truncateExternalText(statusContext.context, 200) ?? "Unnamed status check";
  const state = toUpperString(statusContext.state);
  if (!sourceId || !headSha || !state || !STATUS_FAILURE_STATES.has(state)) {
    return null;
  }

  const details = truncateExternalText(statusContext.description, 2_000);
  const body = [
    `Workflow status check "${context}" failed with state ${state}.`,
    `Head commit: ${headSha}`,
    details ? `Reported details:\n${details}` : undefined,
  ].filter((value): value is string => value !== undefined).join("\n");
  const completedAt = toStringValue(statusContext.updatedAt) ?? toStringValue(statusContext.createdAt);

  return {
    id: buildWorkflowFailureId(sourceId, headSha, state, completedAt),
    source: "workflow",
    body: truncateExternalText(body, MAX_WORKFLOW_FAILURE_TEXT_LENGTH) ?? body,
    createdAt: toStringValue(statusContext.createdAt),
    url: truncateExternalText(statusContext.targetUrl, 500),
    headSha,
    checkName: context,
    checkConclusion: state,
  };
}

function normalizeWorkflowFailure(
  check: GraphQlStatusCheckContextNode,
  headSha: string,
): AutomaticPrFlowFeedbackItem | null {
  switch (check.__typename) {
    case "CheckRun":
      return normalizeCheckRunFailure(check, headSha);
    case "StatusContext":
      return normalizeStatusContextFailure(check, headSha);
    default:
      return null;
  }
}

function isNoPullRequestError(stderr: string): boolean {
  return /no pull requests found/i.test(stderr);
}

async function buildPullRequestMetadataInput(
  task: Task,
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
      taskId: task.config.id,
      baseBranch,
      error: String(error),
    });
  }

  try {
    diffSummary = await getDiffSummary(executor, directory, baseBranch);
  } catch (error) {
    log.warn("Failed to load diff summary for automatic PR metadata", {
      taskId: task.config.id,
      baseBranch,
      error: String(error),
    });
  }

  return {
    taskName: task.config.name,
    originalPrompt: task.config.prompt,
    issueNumber: task.config.issueNumber,
    baseBranch,
    workingBranch: task.state.git?.workingBranch ?? "",
    commitMessages: task.state.git?.commits.map((commit) => commit.message) ?? [],
    changedFiles,
    diffSummary,
  };
}

async function generateAutomaticPrMetadata(
  task: Task,
  directory: string,
  executor: CommandExecutor,
  baseBranch: string,
): Promise<PullRequestMetadata> {
  const metadataInput = await buildPullRequestMetadataInput(task, directory, executor, baseBranch);
  try {
    let backend = backendManager.getInitializedBackend(task.config.workspaceId);
    if (
      !backend
      || !backendManager.isWorkspaceConnected(task.config.workspaceId)
      || backend.getDirectory() !== directory
    ) {
      await backendManager.connect(task.config.workspaceId, directory);
      backend = backendManager.getBackend(task.config.workspaceId);
    }

    const tempSession = await backend.createSession({
      title: "Pull Request Metadata Generation",
      directory,
    });

    try {
      const helperModel = await resolveEffectiveCheapModel({
        workspaceId: task.config.workspaceId,
        directory,
        model: task.config.model,
        cheapModel: task.config.cheapModel,
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
          taskId: task.config.id,
          error: String(cleanupError),
        });
      }
    }
  } catch (error) {
    log.warn("Failed to generate automatic PR metadata via backend, using fallback", {
      taskId: task.config.id,
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
    mergeStateStatus: normalizeMergeStateStatus(pullRequestView.mergeStateStatus),
  };
}

async function getExistingPullRequest(
  workingBranch: string,
  directory: string,
  executor: CommandExecutor,
): Promise<AutomaticPrFlowPullRequest | null> {
  const result = await executor.exec(
    "gh",
    ["pr", "view", workingBranch, "--json", "number,url,state,mergedAt,reviewDecision,mergeStateStatus"],
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
  task: Task,
  directory: string,
  executor: CommandExecutor,
  git: PullRequestNavigationGitService,
): Promise<AutomaticPrFlowPullRequest> {
  const workingBranch = getWorkingBranch(task);
  if (!workingBranch) {
    throw new Error("This task does not have a working branch to open a pull request for.");
  }

  if (!(await isGhAvailable(executor, directory))) {
    throw new Error(GH_UNAVAILABLE_REASON);
  }

  await getGitHubOriginRemoteUrl(directory, git);

  const existingPullRequest = await getExistingPullRequest(workingBranch, directory, executor);
  if (existingPullRequest) {
    return existingPullRequest;
  }

  const baseBranch = getBaseBranch(task) ?? await git.getDefaultBranch(directory);
  const metadata = await generateAutomaticPrMetadata(task, directory, executor, baseBranch);
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

export async function enableExistingPullRequestAutoMerge(
  task: Task,
  directory: string,
  executor: CommandExecutor,
  git: PullRequestNavigationGitService,
): Promise<AutomaticPrFlowPullRequest> {
  const workingBranch = getWorkingBranch(task);
  if (!workingBranch) {
    throw new Error("This task does not have a working branch to enable automatic merge for.");
  }

  if (!(await isGhAvailable(executor, directory))) {
    throw new Error(GH_UNAVAILABLE_REASON);
  }

  await getGitHubOriginRemoteUrl(directory, git);

  const existingPullRequest = await getExistingPullRequest(workingBranch, directory, executor);
  if (!existingPullRequest) {
    throw new Error("This task does not have an existing GitHub pull request yet.");
  }

  if (existingPullRequest.state !== "OPEN") {
    throw new Error("Automatic merge can only be enabled for open pull requests.");
  }

  const result = await executor.exec(
    "gh",
    ["pr", "merge", workingBranch, "--auto", "--squash"],
    { cwd: directory, timeout: 15000 },
  );
  if (!result.success) {
    throw new Error(result.stderr.trim() || `gh pr merge exited with code ${result.exitCode}`);
  }

  return existingPullRequest;
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

  const remoteUrl = await getGitHubOriginRemoteUrl(directory, git);
  const coordinates = parseRepositoryCoordinates(remoteUrl)!;

  const result = await executor.exec(
    "gh",
    [
      "api",
      "graphql",
      "-f",
    `query=${PULL_REQUEST_DETAILS_QUERY}`,
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

  const latestCommit = [...(responsePullRequest.commits?.nodes ?? [])]
    .reverse()
    .map((node) => node?.commit)
    .find((commit): commit is GraphQlCommitNode => commit !== undefined && commit !== null);
  const headSha = toStringValue(responsePullRequest.headRefOid)
    ?? toStringValue(latestCommit?.oid)
    ?? pullRequest.headSha;

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
  const workflowFailures = headSha
    ? dedupeFeedbackItems(
        (latestCommit?.statusCheckRollup?.contexts?.nodes ?? [])
          .filter((check): check is GraphQlStatusCheckContextNode => check !== null)
          .map((check) => normalizeWorkflowFailure(check, headSha))
          .filter((item): item is AutomaticPrFlowFeedbackItem => item !== null),
      )
    : [];

  return {
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
      state: normalizePullRequestState(responsePullRequest.state) ?? pullRequest.state,
      reviewDecision: normalizeReviewDecision(responsePullRequest.reviewDecision) ?? pullRequest.reviewDecision,
      mergeStateStatus: normalizeMergeStateStatus(responsePullRequest.mergeStateStatus) ?? pullRequest.mergeStateStatus,
      viewerCanUpdateBranch: toBooleanValue(responsePullRequest.viewerCanUpdateBranch) ?? pullRequest.viewerCanUpdateBranch,
      mergedAt: pullRequest.mergedAt,
      headSha,
    },
    reviewThreads,
    reviewComments,
    reviews,
    workflowFailures,
    actionableItems: dedupeFeedbackItems([...reviewThreads, ...reviewComments, ...reviews, ...workflowFailures]),
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
