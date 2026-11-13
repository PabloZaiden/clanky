import type { ReactNode } from "react";
import type { FileDiff } from "@/contracts";
import { getDiffFileStatusPresentation } from "../common/diff-file-status";

interface DiffViewProps {
  diffContent: FileDiff[];
  loadingContent: boolean;
  expandedFiles: Set<string>;
  onExpandedFilesChange: (v: Set<string>) => void;
  renderPatch: (file: FileDiff) => ReactNode;
}

export function DiffView({ diffContent, loadingContent, expandedFiles, onExpandedFilesChange, renderPatch }: DiffViewProps) {
  const hasDiffContent = diffContent.length > 0;

  return (
    <div className="min-w-0">
        {loadingContent && !hasDiffContent ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-gray-500 border-t-transparent" />
          </div>
        ) : hasDiffContent ? (
          <div className="space-y-2">
            {diffContent.map((file) => {
              const isExpanded = expandedFiles.has(file.path);
              const statusPresentation = getDiffFileStatusPresentation(file.status);

              return (
                <div
                  key={file.path}
                  className="bg-gray-50 dark:bg-neutral-900 rounded text-xs sm:text-sm overflow-hidden"
                >
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    onClick={() => {
                      const next = new Set(expandedFiles);
                      if (isExpanded) {
                        next.delete(file.path);
                      } else {
                        next.add(file.path);
                      }
                      onExpandedFilesChange(next);
                    }}
                    className="w-full flex items-center gap-2 sm:gap-3 p-2 text-left cursor-pointer hover:bg-gray-100 dark:hover:bg-neutral-800"
                  >
                    <span className="text-gray-400 flex-shrink-0 text-sm">
                      {isExpanded ? "▼" : "▶"}
                    </span>
                    <span
                      className={`font-medium flex-shrink-0 ${statusPresentation.className}`}
                    >
                      {statusPresentation.symbol}
                    </span>
                    <span className="font-mono text-gray-900 dark:text-gray-100 flex-1 truncate min-w-0">
                      {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                    </span>
                    <span className="text-gray-500 dark:text-gray-400 flex-shrink-0 whitespace-nowrap"
                      title={file.additions === null ? "Line counts load when opened" : undefined}>
                      <span className="text-green-600 dark:text-green-400">{file.additions === null ? "—" : `+${file.additions}`}</span>
                      {" "}
                      <span className="text-red-600 dark:text-red-400">{file.deletions === null ? "—" : `-${file.deletions}`}</span>
                    </span>
                  </button>
                  {isExpanded && renderPatch(file)}
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
  );
}
