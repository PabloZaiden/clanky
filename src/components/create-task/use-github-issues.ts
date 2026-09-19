import { useEffect, useRef, useState } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import type {
  GitHubIssueSummary,
  GitHubIssuesResponse,
  GitHubRepositoryUrlResponse,
} from "@/contracts";
import { apiRequest } from "../../lib/api-client";

const log = createLogger("useGitHubIssues");

interface UseGitHubIssuesOptions {
  workspaceId?: string;
  issueNumber: string;
  setIssueNumber: (value: string) => void;
  preserveExistingIssue: boolean;
}

export interface UseGitHubIssuesResult {
  issues: GitHubIssueSummary[];
  loading: boolean;
}

function isGitHubRepositoryUrlResponse(value: unknown): value is GitHubRepositoryUrlResponse {
  if (typeof value !== "object" || value === null || !("githubUrl" in value)) {
    return false;
  }

  const githubUrl = value.githubUrl;
  return githubUrl === null || typeof githubUrl === "string";
}

function isGitHubIssuesResponse(value: unknown): value is GitHubIssuesResponse {
  if (typeof value !== "object" || value === null || !("issues" in value)) {
    return false;
  }

  const issues = value.issues;
  return Array.isArray(issues) && issues.every((issue) => (
    typeof issue === "object"
    && issue !== null
    && "number" in issue
    && typeof issue.number === "number"
    && Number.isSafeInteger(issue.number)
    && issue.number > 0
    && "title" in issue
    && typeof issue.title === "string"
  ));
}

export function useGitHubIssues({
  workspaceId,
  issueNumber,
  setIssueNumber,
  preserveExistingIssue,
}: UseGitHubIssuesOptions): UseGitHubIssuesResult {
  const [issues, setIssues] = useState<GitHubIssueSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const issueNumberRef = useRef(issueNumber);
  issueNumberRef.current = issueNumber;

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setIssues([]);
    setLoading(Boolean(workspaceId));

    const isActiveRequest = () =>
      requestIdRef.current === requestId
      && controllerRef.current === controller
      && !controller.signal.aborted;

    const clearIssueSelection = () => {
      if (!preserveExistingIssue) {
        issueNumberRef.current = "";
        setIssueNumber("");
      }
    };

    if (!workspaceId) {
      clearIssueSelection();
      controllerRef.current = null;
      setLoading(false);
      return () => {
        requestIdRef.current += 1;
        controller.abort();
      };
    }

    const loadIssues = async () => {
      try {
        const repositoryResponse = await apiRequest<unknown>(
          `/api/git/github-repository-url?workspaceId=${encodeURIComponent(workspaceId)}`,
          {
            signal: controller.signal,
            action: "Load GitHub repository URL",
            fallbackMessage: "GitHub repository URL is not available for this workspace",
          },
        );
        if (!isActiveRequest()) {
          return;
        }
        if (!isGitHubRepositoryUrlResponse(repositoryResponse)) {
          throw new Error("Clanky API returned an invalid GitHub repository response");
        }
        if (!repositoryResponse.githubUrl) {
          clearIssueSelection();
          setIssues([]);
          return;
        }

        const issuesResponse = await apiRequest<unknown>(
          `/api/git/github-issues?workspaceId=${encodeURIComponent(workspaceId)}`,
          {
            signal: controller.signal,
            action: "Load GitHub issues",
            fallbackMessage: "GitHub issues are not available for this workspace",
          },
        );
        if (!isActiveRequest()) {
          return;
        }
        if (!isGitHubIssuesResponse(issuesResponse)) {
          throw new Error("Clanky API returned an invalid GitHub issues response");
        }

        if (
          !preserveExistingIssue
          && issueNumberRef.current
          && !issuesResponse.issues.some(
            (issue) => String(issue.number) === issueNumberRef.current,
          )
        ) {
          issueNumberRef.current = "";
          setIssueNumber("");
        }
        setIssues(issuesResponse.issues);
      } catch (fetchError) {
        if (!isActiveRequest()) {
          return;
        }

        const message = fetchError instanceof Error
          ? fetchError.message
          : "Failed to load GitHub issues";
        log.warn("Failed to load GitHub issues automatically", {
          workspaceId,
          error: message,
        });
        clearIssueSelection();
        setIssues([]);
      } finally {
        if (isActiveRequest()) {
          controllerRef.current = null;
          setLoading(false);
        }
      }
    };

    void loadIssues();

    return () => {
      requestIdRef.current += 1;
      controller.abort();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [preserveExistingIssue, setIssueNumber, workspaceId]);

  return {
    issues,
    loading,
  };
}
