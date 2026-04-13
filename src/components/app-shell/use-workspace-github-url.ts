import { useEffect, useState } from "react";
import { normalizeGitHubRepositoryUrl } from "../../lib/github-repository-url";
import { createLogger } from "../../lib/logger";
import { appFetch } from "../../lib/public-path";
import type { GitHubRepositoryUrlResponse, Workspace } from "../../types";

const log = createLogger("useWorkspaceGitHubUrl");

interface FetchedGitHubUrlState {
  workspaceId: string;
  githubUrl: string | null;
}

export function useWorkspaceGitHubUrl(workspace: Workspace): string | null {
  const persistedRepoUrl = workspace.repoUrl?.trim() ?? "";
  const persistedGitHubUrl = persistedRepoUrl
    ? normalizeGitHubRepositoryUrl(persistedRepoUrl)
    : null;
  const [fetchedGitHubUrl, setFetchedGitHubUrl] = useState<FetchedGitHubUrlState | null>(null);

  useEffect(() => {
    if (!workspace.id || !workspace.directory) {
      setFetchedGitHubUrl(null);
      return;
    }

    if (persistedRepoUrl) {
      setFetchedGitHubUrl({
        workspaceId: workspace.id,
        githubUrl: persistedGitHubUrl,
      });
      return;
    }

    const controller = new AbortController();
    setFetchedGitHubUrl(null);

    async function fetchGitHubUrl() {
      try {
        const response = await appFetch(
          `/api/git/github-repository-url?directory=${encodeURIComponent(workspace.directory)}&workspaceId=${encodeURIComponent(workspace.id)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) {
          return;
        }
        if (!response.ok) {
          setFetchedGitHubUrl({
            workspaceId: workspace.id,
            githubUrl: null,
          });
          return;
        }

        const data = await response.json() as GitHubRepositoryUrlResponse;
        if (!controller.signal.aborted) {
          setFetchedGitHubUrl({
            workspaceId: workspace.id,
            githubUrl: data.githubUrl ?? null,
          });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        log.warn("Failed to fetch workspace GitHub URL", {
          workspaceId: workspace.id,
          directory: workspace.directory,
          error: String(error),
        });
        setFetchedGitHubUrl({
          workspaceId: workspace.id,
          githubUrl: null,
        });
      }
    }

    void fetchGitHubUrl();

    return () => {
      controller.abort();
    };
  }, [persistedGitHubUrl, persistedRepoUrl, workspace.directory, workspace.id]);

  if (persistedRepoUrl) {
    return persistedGitHubUrl;
  }

  return fetchedGitHubUrl?.workspaceId === workspace.id
    ? fetchedGitHubUrl.githubUrl
    : null;
}
