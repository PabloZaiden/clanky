import { useLiveQuery } from "@pablozaiden/webapp/web";
import type { ChatRepositoryContext } from "@/contracts";
import { apiRequest } from "../../lib/api-client";
import { SNAPSHOT_REQUEST_TIMEOUT_MS } from "../../lib/request-lifecycle";
import { ComposerActionsMenuSection } from "../ComposerActionsMenu";

export function ChatRepositorySection({ chatId }: { chatId: string }) {
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
  return (
    <ComposerActionsMenuSection label="Repository">
      <div className="min-w-0 space-y-1 text-sm text-gray-600 dark:text-gray-300">
        {query.error ? (
          <p role="status">Repository lookup unavailable.</p>
        ) : !repository ? (
          <p>Loading repository…</p>
        ) : !repository.isGitRepo ? (
          <p>Not a Git repository.</p>
        ) : (
          <>
            <p className="min-w-0 break-words [overflow-wrap:anywhere]">
              <span className="text-gray-500 dark:text-gray-400">Branch: </span>
              <span className="font-mono">{repository.branch ?? "Detached HEAD"}</span>
            </p>
            {repository.pullRequestLookup === "found" && repository.pullRequest ? (
              <a href={repository.pullRequest.url} target="_blank" rel="noopener noreferrer" className="inline-block text-blue-600 underline dark:text-blue-400">
                Pull request #{repository.pullRequest.number}
              </a>
            ) : (
              <p>{repository.pullRequestLookup === "none" ? "No open pull request." : "Pull request lookup unavailable."}</p>
            )}
          </>
        )}
      </div>
    </ComposerActionsMenuSection>
  );
}
