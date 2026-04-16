import type { FileContentResponse } from "../../types";
import { MarkdownRenderer } from "../MarkdownRenderer";

interface StatusTabProps {
  statusContent: FileContentResponse | null;
  loadingContent: boolean;
  markdownEnabled: boolean;
  /** When true, renders without the outer scroll container (for embedding inside another tab). */
  embedded?: boolean;
}

export function StatusTab({ statusContent, loadingContent, markdownEnabled, embedded = false }: StatusTabProps) {
  const content = (
    <div className="min-w-0 flex-1">
      {loadingContent ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-gray-500 border-t-transparent" />
        </div>
      ) : statusContent?.exists ? (
        <MarkdownRenderer content={statusContent.content} rawMode={!markdownEnabled} className="min-w-0 rounded-lg bg-gray-50 p-4 dark:bg-neutral-900" />
      ) : (
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          No status.md file found in the project directory.
        </p>
      )}
    </div>
  );

  if (embedded) return content;

  return (
    <div className="flex min-w-0 flex-1 overflow-x-hidden overflow-y-auto dark-scrollbar">
      <div className="min-w-0 flex-1 px-3 py-3 sm:px-4 sm:py-4">
        {content}
      </div>
    </div>
  );
}
