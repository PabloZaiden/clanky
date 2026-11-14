import { useLiveQuery, useToast } from "@pablozaiden/webapp/web";
import type { ChatRepositoryContext } from "@/contracts";
import { apiRequest } from "../../lib/api-client";
import { SNAPSHOT_REQUEST_TIMEOUT_MS } from "../../lib/request-lifecycle";
import { ComposerActionsMenuSection } from "../ComposerActionsMenu";
import { PullRequestIcon } from "../common/Icons";
import { writeTextToClipboard } from "../../utils/clipboard";

const PR_STATE_COLORS = {
  open: "text-green-600 dark:text-green-400",
  closed: "text-red-600 dark:text-red-400",
  merged: "text-purple-600 dark:text-purple-400",
};

export function ChatRepositorySection({ chatId }: { chatId: string }) {
  const toast = useToast();
  const query = useLiveQuery<ChatRepositoryContext>({
    load: (signal) => apiRequest<ChatRepositoryContext>(
      `/api/chats/${encodeURIComponent(chatId)}/repository-context`,
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(SNAPSHOT_REQUEST_TIMEOUT_MS)]),
        action: "Read chat repository context",
      },
    ),
    deps: [chatId],
    realtime: { resources: ["chats"], targets: { chatId } },
  });
  const repository = query.data;
  async function copyBranch(): Promise<void> {
    if (!repository?.branch) return;
    try {
      await writeTextToClipboard(repository.branch);
      toast.success("Copied branch name");
    } catch (error) {
      toast.error(`Failed to copy branch name: ${String(error)}`);
    }
  }

  return (
    <ComposerActionsMenuSection label="Repository">
      <div className="flex h-8 min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-sm text-gray-600 dark:text-gray-300">
        {query.error ? (
          <p role="status" className="truncate">Repository lookup unavailable.</p>
        ) : !repository ? (
          <p>Loading repository…</p>
        ) : !repository.isGitRepo ? (
          <p>Not a Git repository.</p>
        ) : (
          <>
            {repository.branch ? (
              <button
                type="button"
                className="h-full min-w-0 flex-1 truncate text-left font-mono hover:underline"
                title={repository.branch}
                aria-label={`Copy branch ${repository.branch}`}
                onClick={() => void copyBranch()}
              >
                {repository.branch}
              </button>
            ) : <span className="min-w-0 flex-1 truncate">Detached HEAD</span>}
            {repository.pullRequestLookup === "found" && repository.pullRequest ? (
              <a
                href={repository.pullRequest.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-full shrink-0 items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
                title={`Pull request #${repository.pullRequest.number} (${repository.pullRequest.state})`}
                aria-label={`Pull request #${repository.pullRequest.number}, ${repository.pullRequest.state}`}
              >
                <PullRequestIcon state={repository.pullRequest.state} className={PR_STATE_COLORS[repository.pullRequest.state]} />
                #{repository.pullRequest.number}
              </a>
            ) : repository.pullRequestLookup === "unavailable" ? (
              <span className="shrink-0 text-gray-500 dark:text-gray-400" role="status" title={repository.message ?? "Pull request lookup unavailable."} aria-label="Pull request lookup unavailable">PR unavailable</span>
            ) : null}
          </>
        )}
      </div>
    </ComposerActionsMenuSection>
  );
}
