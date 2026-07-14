/**
 * Pull request title/body generation helpers.
 */

import type { PromptInput, AgentResponse } from "../backends/types";
import type { ModelConfig } from "@/shared";
import { parseConventionalCommit } from "./conventional-commits";

export const DEFAULT_PULL_REQUEST_METADATA_TIMEOUT_MS = 30_000;
const MAX_PULL_REQUEST_TITLE_LENGTH = 120;
const MAX_PULL_REQUEST_BODY_LENGTH = 8_000;
const BANNED_METADATA_PATTERNS = [
  /\bclanky\b/i,
  /\bautopr\b/i,
  /\bgenerated automatically\b/i,
  /\bautomatically generated\b/i,
  /\b(?:opened|created)\s+automatically\b/i,
  /\bautomated\s+(?:pr|pull request)\b/i,
] as const;

export interface PullRequestMetadataBackendInterface {
  sendPrompt(sessionId: string, prompt: PromptInput): Promise<AgentResponse>;
}

export interface PullRequestMetadataChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

export interface PullRequestMetadataInput {
  taskName: string;
  originalPrompt: string;
  issueNumber?: number;
  baseBranch: string;
  workingBranch: string;
  commitMessages: string[];
  changedFiles: PullRequestMetadataChangedFile[];
  diffSummary: {
    files: number;
    insertions: number;
    deletions: number;
  };
}

export interface PullRequestMetadata {
  title: string;
  body: string;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function stripMarkdownFences(value: string): string {
  return value
    .replace(/^```(?:json|markdown|md|text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function containsBannedMetadata(text: string): boolean {
  return BANNED_METADATA_PATTERNS.some((pattern) => pattern.test(text));
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeCommitSummary(message: string): string | null {
  const firstLine = message.split("\n")[0]?.trim();
  if (!firstLine) {
    return null;
  }

  const conventional = parseConventionalCommit(message);
  if (conventional?.description) {
    return conventional.description;
  }

  return firstLine;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const value of values) {
    const normalized = collapseWhitespace(value);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(normalized);
  }

  return results;
}

function extractCommitSummaries(commitMessages: string[]): string[] {
  return uniqueStrings(
    commitMessages
      .map((message) => normalizeCommitSummary(message))
      .filter((value): value is string => Boolean(value)),
  );
}

function humanizeFilePath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split("/").filter(Boolean);
  const fileName = parts[parts.length - 1]?.replace(/\.[^.]+$/u, "");
  if (!fileName) {
    return null;
  }

  return collapseWhitespace(fileName.replace(/[-_]+/g, " "));
}

function capitalizeSentence(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function lowercaseFirstCharacter(value: string): string {
  if (!value) {
    return value;
  }
  return `${value[0]!.toLowerCase()}${value.slice(1)}`;
}

function stripBannedMetadata(value: string): string {
  let sanitized = value;
  for (const pattern of BANNED_METADATA_PATTERNS) {
    const globalPattern = pattern.flags.includes("g")
      ? pattern
      : new RegExp(pattern.source, `${pattern.flags}g`);
    sanitized = sanitized.replace(globalPattern, " ");
  }
  return sanitized;
}

function inferFallbackFocus(input: PullRequestMetadataInput): string | null {
  const firstFile = input.changedFiles[0]?.path;
  if (firstFile) {
    return humanizeFilePath(firstFile);
  }

  const taskName = collapseWhitespace(input.taskName);
  return taskName || null;
}

function sanitizeTitle(title: string): string {
  const sanitized = truncate(
    collapseWhitespace(
      title
        .replace(/[`*~#]/g, "")
        .replace(/[\x00-\x1F\x7F]/g, " "),
    ),
    MAX_PULL_REQUEST_TITLE_LENGTH,
  );

  if (!sanitized) {
    throw new Error("Pull request metadata returned an empty title.");
  }
  if (containsBannedMetadata(sanitized)) {
    throw new Error("Pull request title contains banned branding.");
  }

  return sanitized;
}

function sanitizeBody(body: string): string {
  const sanitized = truncate(
    stripMarkdownFences(body)
      .replace(/\r\n/g, "\n")
      .replace(/[^\S\n]+/g, " ")
      .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    MAX_PULL_REQUEST_BODY_LENGTH,
  );

  if (!sanitized) {
    throw new Error("Pull request metadata returned an empty body.");
  }
  if (containsBannedMetadata(sanitized)) {
    throw new Error("Pull request body contains banned branding.");
  }

  return sanitized;
}

function normalizeIssueNumber(issueNumber: number | undefined): number | undefined {
  return issueNumber !== undefined && Number.isInteger(issueNumber) && issueNumber > 0
    ? issueNumber
    : undefined;
}

function appendIssueClosingDirective(body: string, issueNumber: number | undefined): string {
  const normalizedIssueNumber = normalizeIssueNumber(issueNumber);
  if (normalizedIssueNumber === undefined) {
    return body;
  }

  const directive = `Closes #${normalizedIssueNumber}`;
  if (new RegExp(`\\bCloses\\s+#${normalizedIssueNumber}\\b`, "i").test(body)) {
    return body;
  }

  const separator = body.length > 0 ? "\n\n" : "";
  const availableBodyLength = MAX_PULL_REQUEST_BODY_LENGTH - separator.length - directive.length;
  const truncatedBody = body.slice(0, Math.max(0, availableBodyLength)).trimEnd();
  return `${truncatedBody}${separator}${directive}`;
}

function sanitizeFallbackTitle(title: string): string {
  try {
    return sanitizeTitle(stripBannedMetadata(title));
  } catch {
    return "Update completed changes";
  }
}

function sanitizeFallbackBody(body: string): string {
  try {
    return sanitizeBody(stripBannedMetadata(body));
  } catch {
    return "## Summary\n- Completed the requested updates and prepared them for review.";
  }
}

function parseJsonObject(content: string): Record<string, unknown> {
  const stripped = stripMarkdownFences(content);

  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    const firstBrace = stripped.indexOf("{");
    const lastBrace = stripped.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(stripped.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
    }
    throw new Error("Pull request metadata response was not valid JSON.");
  }
}

function buildChangedFileLines(changedFiles: PullRequestMetadataChangedFile[]): string {
  const limitedFiles = changedFiles.slice(0, 12);
  if (limitedFiles.length === 0) {
    return "- No changed files were available.\n";
  }

  return `${limitedFiles.map((file) => {
    const totals: string[] = [];
    if (file.additions > 0) {
      totals.push(`+${file.additions}`);
    }
    if (file.deletions > 0) {
      totals.push(`-${file.deletions}`);
    }
    const stats = totals.length > 0 ? ` (${totals.join(" / ")})` : "";
    return `- ${file.status}: ${file.path}${stats}`;
  }).join("\n")}\n`;
}

function buildMetadataPrompt(input: PullRequestMetadataInput): PromptInput {
  const commitSummaries = extractCommitSummaries(input.commitMessages).slice(0, 10);
  const changedFilesText = buildChangedFileLines(input.changedFiles);
  const originalPrompt = truncate(collapseWhitespace(input.originalPrompt), 1_000);
  const issueNumber = normalizeIssueNumber(input.issueNumber);
  const issueInstruction = issueNumber === undefined
    ? ""
    : `- The body MUST include the exact GitHub closing keyword \`Closes #${issueNumber}\` on its own line.`;

  return {
    parts: [{
      type: "text",
      text: `Generate a GitHub pull request title and body for work that has already been completed.

Base the result on the actual completed work shown below. Use the original request only as supporting context when it helps explain intent. Do not invent changes that are not evidenced by the commits, files, or diff summary.

Requirements:
- Output ONLY strict JSON with this shape: {"title":"...","body":"..."}
- Title: concise, specific, no surrounding quotes, max 120 characters
- Body: plain Markdown, concise but informative
- Do NOT mention Clanky, autopr, automation, or that the pull request was generated automatically
- Do NOT simply restate the original request; describe the implemented changes
${issueInstruction}

Task name:
${input.taskName.trim() || "(not provided)"}

Base branch: ${input.baseBranch}
Head branch: ${input.workingBranch}
${issueNumber === undefined ? "Linked GitHub issue: none" : `Linked GitHub issue: #${issueNumber}`}

Diff summary:
- ${input.diffSummary.files} files changed
- ${input.diffSummary.insertions} insertions
- ${input.diffSummary.deletions} deletions

Commit summaries:
${commitSummaries.length > 0 ? commitSummaries.map((summary) => `- ${summary}`).join("\n") : "- No commit summaries were available."}

Changed files:
${changedFilesText}
Original request (supporting context only):
${originalPrompt || "(not provided)"}
`,
    }],
  };
}

export function buildFallbackPullRequestMetadata(input: PullRequestMetadataInput): PullRequestMetadata {
  const commitSummaries = extractCommitSummaries(input.commitMessages);
  const focus = inferFallbackFocus(input);

  let title = "Update completed changes";
  if (commitSummaries.length >= 2) {
    title = `${capitalizeSentence(commitSummaries[0]!)} and ${lowercaseFirstCharacter(commitSummaries[1]!)}`;
  } else if (commitSummaries.length === 1) {
    title = capitalizeSentence(commitSummaries[0]!);
  } else if (focus) {
    title = `Update ${focus}`;
  }

  const summaryLines = commitSummaries.length > 0
    ? commitSummaries.slice(0, 5).map((summary) => `- ${capitalizeSentence(summary)}`)
    : [`- Updated work on \`${input.workingBranch}\`.`];

  const changeSummary = [
    `- ${input.diffSummary.files} files changed`,
    ...(input.diffSummary.insertions > 0 ? [`- ${input.diffSummary.insertions} insertions`] : []),
    ...(input.diffSummary.deletions > 0 ? [`- ${input.diffSummary.deletions} deletions`] : []),
  ];

  const fileLines = input.changedFiles.slice(0, 8).map((file) => {
    const changeTotals: string[] = [];
    if (file.additions > 0) {
      changeTotals.push(`+${file.additions}`);
    }
    if (file.deletions > 0) {
      changeTotals.push(`-${file.deletions}`);
    }
    const suffix = changeTotals.length > 0 ? ` (${changeTotals.join(" / ")})` : "";
    return `- ${file.path} (${file.status})${suffix}`;
  });

  const bodySections = [
    "## Summary",
    ...summaryLines,
    "",
    "## Changes",
    ...changeSummary,
    ...(fileLines.length > 0 ? ["", "## Files", ...fileLines] : []),
    "",
    "## Branches",
    `- Base: \`${input.baseBranch}\``,
    `- Head: \`${input.workingBranch}\``,
  ];

  return {
    title: sanitizeFallbackTitle(title),
    body: appendIssueClosingDirective(
      sanitizeFallbackBody(bodySections.join("\n")),
      input.issueNumber,
    ),
  };
}

export interface GeneratePullRequestMetadataOptions {
  metadata: PullRequestMetadataInput;
  backend: PullRequestMetadataBackendInterface;
  sessionId: string;
  model?: ModelConfig;
  timeoutMs?: number;
}

export async function generatePullRequestMetadata(
  options: GeneratePullRequestMetadataOptions,
): Promise<PullRequestMetadata> {
  const { metadata, backend, sessionId, model, timeoutMs = DEFAULT_PULL_REQUEST_METADATA_TIMEOUT_MS } = options;

  if (!backend || !sessionId) {
    throw new Error("Backend and sessionId are required for pull request metadata generation.");
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Pull request metadata generation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    let response: AgentResponse;
    try {
      response = await Promise.race([
        backend.sendPrompt(sessionId, {
          ...buildMetadataPrompt(metadata),
          model,
        }),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

    const parsed = parseJsonObject(response.content);
    const title = typeof parsed["title"] === "string" ? parsed["title"] : "";
    const body = typeof parsed["body"] === "string" ? parsed["body"] : "";

    return {
      title: sanitizeTitle(title),
      body: appendIssueClosingDirective(sanitizeBody(body), metadata.issueNumber),
    };
  } catch (error) {
    throw new Error(`Failed to generate pull request metadata: ${String(error)}`, { cause: error });
  }
}
