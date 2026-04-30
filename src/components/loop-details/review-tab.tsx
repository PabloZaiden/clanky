import type { Loop, ReviewComment } from "../../types/loop";
import type { EntityLabels } from "../../utils";

interface ReviewTabProps {
  loop: Loop;
  labels: EntityLabels;
  loadingComments: boolean;
  reviewComments: ReviewComment[];
  /** When true, renders without the outer scroll container (for embedding inside another tab). */
  embedded?: boolean;
}

export function ReviewTab({ loop, labels, loadingComments, reviewComments, embedded = false }: ReviewTabProps) {
  const content = (
    <div className="min-w-0 w-full space-y-4">
      {loop.state.reviewMode ? (
          <>
            <div className="bg-gray-50 dark:bg-neutral-900/40 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                Review Mode Status
              </h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Addressable:</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {loop.state.reviewMode.addressable ? "Yes" : "No"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Completion Action:</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100 capitalize">
                    {loop.state.reviewMode.completionAction}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Review Cycles:</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {loop.state.reviewMode.reviewCycles}
                  </span>
                </div>
              </div>
            </div>

            {loop.state.reviewMode.reviewBranches.length > 0 && (
              <div className="bg-gray-50 dark:bg-neutral-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                  Review Branches
                </h3>
                <div className="space-y-2">
                  {loop.state.reviewMode.reviewBranches.map((branch, index) => (
                    <div
                      key={index}
                      className="flex min-w-0 items-center gap-2 text-sm font-mono text-gray-700 dark:text-gray-300"
                    >
                      <span className="text-gray-400">{index + 1}.</span>
                      <span className="break-all">{branch}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Comment History */}
            <div className="bg-gray-50 dark:bg-neutral-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                Comment History
              </h3>

              {loadingComments ? (
                <div className="text-center py-4">
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    Loading comments...
                  </span>
                </div>
              ) : reviewComments.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  No comments yet.
                </p>
              ) : (
                <div className="space-y-4">
                  {/* Group comments by review cycle */}
                  {Object.entries(
                    reviewComments.reduce((acc, comment) => {
                      const cycleComments = acc[comment.reviewCycle] ?? [];
                      cycleComments.push(comment);
                      acc[comment.reviewCycle] = cycleComments;
                      return acc;
                    }, {} as Record<number, ReviewComment[]>)
                  )
                    .sort(([cycleA], [cycleB]) => Number(cycleA) - Number(cycleB))
                    .map(([cycle, comments]) => (
                      <div key={cycle} className="border-l-2 border-gray-300 dark:border-gray-600 pl-3">
                        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                          Review Cycle {cycle}
                        </h4>
                        <div className="space-y-2">
                          {comments.map((comment) => (
                            <div
                              key={comment.id}
                              className="min-w-0 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-gray-700 rounded p-3"
                            >
                              <div className="flex items-start justify-between gap-2 mb-2">
                                <span
                                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                    comment.status === "addressed"
                                      ? "bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300"
                                      : "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300"
                                  }`}
                                >
                                  {comment.status === "addressed" ? "Addressed" : "Pending"}
                                </span>
                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                  {new Date(comment.createdAt).toLocaleString()}
                                </span>
                              </div>
                              <p className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-gray-700 dark:text-gray-300">
                                {comment.commentText}
                              </p>
                              {comment.addressedAt && (
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                                  Addressed on {new Date(comment.addressedAt).toLocaleString()}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="text-center py-8">
            <p className="text-gray-500 dark:text-gray-400">
              This {labels.singular} does not have review mode enabled.
            </p>
          </div>
        )}
      </div>
  );

  if (embedded) return content;

  return (
    <div className="flex min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-4 dark-scrollbar">
      {content}
    </div>
  );
}
