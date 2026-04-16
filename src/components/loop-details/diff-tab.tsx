import type { FileDiff } from "../../types";
import { DiffPatchViewer } from "./diff-patch-viewer";

interface DiffTabProps {
  diffContent: FileDiff[];
  loadingContent: boolean;
  expandedFiles: Set<string>;
  onExpandedFilesChange: (v: Set<string>) => void;
}

export function DiffTab({ diffContent, loadingContent, expandedFiles, onExpandedFilesChange }: DiffTabProps) {
  return (
    <div className="flex min-w-0 flex-1 overflow-x-hidden overflow-y-auto dark-scrollbar">
      <div className="min-w-0 flex-1 px-3 py-3 sm:px-4 sm:py-4">
        {loadingContent ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-gray-500 border-t-transparent" />
          </div>
        ) : diffContent.length > 0 ? (
          <div className="space-y-2">
            {diffContent.map((file) => {
              const isExpanded = expandedFiles.has(file.path);
              const hasPatch = !!file.patch;

              return (
                <div
                  key={file.path}
                  className="bg-gray-50 dark:bg-neutral-900 rounded text-xs sm:text-sm overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (hasPatch) {
                        const next = new Set(expandedFiles);
                        if (isExpanded) {
                          next.delete(file.path);
                        } else {
                          next.add(file.path);
                        }
                        onExpandedFilesChange(next);
                      }
                    }}
                    className={`w-full flex items-center gap-2 sm:gap-3 p-2 text-left ${
                      hasPatch ? "cursor-pointer hover:bg-gray-100 dark:hover:bg-neutral-800" : "cursor-default"
                    }`}
                  >
                    {hasPatch && (
                      <span className="text-gray-400 flex-shrink-0 text-sm">
                        {isExpanded ? "▼" : "▶"}
                      </span>
                    )}
                    <span
                      className={`font-medium flex-shrink-0 ${
                        file.status === "added"
                          ? "text-green-600 dark:text-green-400"
                          : file.status === "deleted"
                          ? "text-red-600 dark:text-red-400"
                          : file.status === "renamed"
                          ? "text-gray-600 dark:text-gray-300"
                          : "text-yellow-600 dark:text-yellow-400"
                      }`}
                    >
                      {file.status === "added" && "+"}
                      {file.status === "deleted" && "-"}
                      {file.status === "renamed" && "→"}
                      {file.status === "modified" && "~"}
                    </span>
                    <span className="font-mono text-gray-900 dark:text-gray-100 flex-1 truncate min-w-0">
                      {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                    </span>
                    <span className="text-gray-500 dark:text-gray-400 flex-shrink-0 whitespace-nowrap">
                      <span className="text-green-600 dark:text-green-400">+{file.additions}</span>
                      {" "}
                      <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
                    </span>
                  </button>
                  {isExpanded && file.patch && (
                    <DiffPatchViewer patch={file.patch} />
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No changes yet.
          </p>
        )}
      </div>
    </div>
  );
}
