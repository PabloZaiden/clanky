import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import type { GitHubIssueSummary, GitHubIssuesResponse } from "@/contracts";
import { apiRequest } from "../../lib/api-client";

const log = createLogger("useGitHubIssues");

interface UseGitHubIssuesOptions {
  workspaceId?: string;
  issueNumber: string;
  setIssueNumber: (value: string) => void;
}

export interface UseGitHubIssuesResult {
  issues: GitHubIssueSummary[] | null;
  loading: boolean;
  error: string | null;
  fetchIssues: () => Promise<void>;
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
}: UseGitHubIssuesOptions): UseGitHubIssuesResult {
  const [issues, setIssues] = useState<GitHubIssueSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    requestIdRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setIssues(null);
    setError(null);
    setLoading(false);

    return () => {
      requestIdRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [workspaceId]);

  const fetchIssues = useCallback(async () => {
    if (!workspaceId || loading) {
      return;
    }

    const requestId = ++requestIdRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const isActiveRequest = () =>
      requestIdRef.current === requestId
      && controllerRef.current === controller
      && !controller.signal.aborted;

    setLoading(true);
    setError(null);

    try {
      const body = await apiRequest<unknown>(
        `/api/git/github-issues?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          signal: controller.signal,
          action: "Fetch GitHub issues",
          fallbackMessage: "Failed to fetch GitHub issues",
        },
      );
      if (!isActiveRequest()) {
        return;
      }
      if (!isGitHubIssuesResponse(body)) {
        throw new Error("Clanky API returned an invalid GitHub issues response");
      }

      if (issueNumber && !body.issues.some((issue) => String(issue.number) === issueNumber)) {
        setIssueNumber("");
      }
      setIssues(body.issues);
    } catch (fetchError) {
      if (!isActiveRequest()) {
        return;
      }

      const message = fetchError instanceof Error
        ? fetchError.message
        : "Failed to fetch GitHub issues";
      log.warn("Failed to fetch GitHub issues", {
        workspaceId,
        error: message,
      });
      setError(message);
    } finally {
      if (isActiveRequest()) {
        controllerRef.current = null;
        setLoading(false);
      }
    }
  }, [issueNumber, loading, setIssueNumber, workspaceId]);

  return {
    issues,
    loading,
    error,
    fetchIssues,
  };
}
