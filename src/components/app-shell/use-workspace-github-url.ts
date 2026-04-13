import { useEffect, useState } from "react";
import { normalizeGitHubRepositoryUrl } from "../../lib/github-repository-url";
import { createLogger } from "../../lib/logger";
import { appFetch } from "../../lib/public-path";
import type { GitHubRepositoryUrlResponse, Workspace } from "../../types";

const log = createLogger("useWorkspaceGitHubUrl");

export function useWorkspaceGitHubUrl(workspace: Workspace): string | null {
  const [githubUrl, setGitHubUrl] = useState<string | null>(() =>
    workspace.repoUrl ? normalizeGitHubRepositoryUrl(workspace.repoUrl) : null
  );

  useEffect(() => {
    if (!workspace.id || !workspace.directory) {
      setGitHubUrl(null);
      return;
    }

    const persistedGitHubUrl = workspace.repoUrl
      ? normalizeGitHubRepositoryUrl(workspace.repoUrl)
      : null;
    if (persistedGitHubUrl) {
      setGitHubUrl(persistedGitHubUrl);
      return;
    }

    const controller = new AbortController();

    async function fetchGitHubUrl() {
      setGitHubUrl(null);

      try {
        const response = await appFetch(
          `/api/git/github-repository-url?directory=${encodeURIComponent(workspace.directory)}&workspaceId=${encodeURIComponent(workspace.id)}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          setGitHubUrl(null);
          return;
        }

        const data = await response.json() as GitHubRepositoryUrlResponse;
        if (!controller.signal.aborted) {
          setGitHubUrl(data.githubUrl ?? null);
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
        setGitHubUrl(null);
      }
    }

    void fetchGitHubUrl();

    return () => {
      controller.abort();
    };
  }, [workspace.directory, workspace.id, workspace.repoUrl]);

  return githubUrl;
}
