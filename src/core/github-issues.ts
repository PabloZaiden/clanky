/**
 * Transport-neutral GitHub issue lookup for a workspace repository.
 */

import type { GitHubIssueSummary } from "@/contracts";
import type { CommandExecutor } from "./command-executor";
import { DomainError } from "./domain-error";

const GH_ISSUE_LIST_ARGS = [
  "issue",
  "list",
  "--state",
  "open",
  "--json",
  "number,title",
  "--limit",
  "1000",
] as const;

const GH_ISSUE_LIST_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGitHubIssues(rawOutput: string): GitHubIssueSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch (error) {
    throw new DomainError(
      "github_issues_invalid_response",
      "GitHub CLI returned invalid issue data",
      { cause: error },
    );
  }

  if (!Array.isArray(parsed)) {
    throw new DomainError(
      "github_issues_invalid_response",
      "GitHub CLI returned an invalid issue list",
    );
  }

  return parsed.map((value, index) => {
    if (!isRecord(value)) {
      throw new DomainError(
        "github_issues_invalid_response",
        `GitHub CLI returned an invalid issue at index ${index}`,
      );
    }

    const issueNumber = value["number"];
    const title = value["title"];
    if (
      typeof issueNumber !== "number"
      || !Number.isSafeInteger(issueNumber)
      || issueNumber <= 0
      || typeof title !== "string"
    ) {
      throw new DomainError(
        "github_issues_invalid_response",
        `GitHub CLI returned invalid issue fields at index ${index}`,
      );
    }

    return {
      number: issueNumber,
      title,
    };
  }).sort((left, right) => left.number - right.number);
}

export async function listOpenGitHubIssues(
  executor: CommandExecutor,
  directory: string,
): Promise<GitHubIssueSummary[]> {
  const result = await executor.exec("gh", [...GH_ISSUE_LIST_ARGS], {
    cwd: directory,
    timeout: GH_ISSUE_LIST_TIMEOUT_MS,
    logFailures: false,
  });

  if (!result.success) {
    throw new DomainError(
      "github_issues_command_failed",
      "GitHub CLI could not list open issues",
      {
        details: {
          exitCode: result.exitCode,
        },
      },
    );
  }

  return parseGitHubIssues(result.stdout);
}
