import type { PersistedMessage, PersistedToolCall, LoopLogEntry, PendingPlanQuestion } from "../../types/loop";
import { LogViewer } from "../LogViewer";
import { Button } from "../common";

interface LogTabProps {
  messages: PersistedMessage[];
  toolCalls: PersistedToolCall[];
  logs: LoopLogEntry[];
  showSystemInfo: boolean;
  onShowSystemInfoChange: (v: boolean) => void;
  showReasoning: boolean;
  onShowReasoningChange: (v: boolean) => void;
  showTools: boolean;
  onShowToolsChange: (v: boolean) => void;
  autoScroll: boolean;
  onAutoScrollChange: (v: boolean) => void;
  logsCollapsed: boolean;
  onLogsCollapsedChange: (v: boolean) => void;
  markdownEnabled: boolean;
  isLogActive: boolean;
  pendingPlanQuestion: PendingPlanQuestion | undefined;
  planQuestionSelections: string[][];
  onPlanQuestionSelectionsChange: (v: string[][]) => void;
  planQuestionCustomAnswers: string[];
  onPlanQuestionCustomAnswersChange: (v: string[]) => void;
  planQuestionSubmitting: boolean;
  onAnswerPlanQuestion: () => void;
}

export function LogTab({
  messages,
  toolCalls,
  logs,
  showSystemInfo,
  onShowSystemInfoChange,
  showReasoning,
  onShowReasoningChange,
  showTools,
  onShowToolsChange,
  autoScroll,
  onAutoScrollChange,
  logsCollapsed,
  onLogsCollapsedChange,
  markdownEnabled,
  isLogActive,
  pendingPlanQuestion,
  planQuestionSelections,
  onPlanQuestionSelectionsChange,
  planQuestionCustomAnswers,
  onPlanQuestionCustomAnswersChange,
  planQuestionSubmitting,
  onAnswerPlanQuestion,
}: LogTabProps) {
  return (
    <div className="flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden">
      <div className="flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden p-4">
        <div className={`flex min-w-0 min-h-0 flex-col ${logsCollapsed ? "flex-shrink-0" : "flex-1"}`}>
          <button
            onClick={() => onLogsCollapsedChange(!logsCollapsed)}
            className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex-shrink-0 flex items-center gap-2 hover:text-gray-900 dark:hover:text-gray-100 transition-colors text-left"
            aria-expanded={!logsCollapsed}
            aria-controls="logs-viewer"
          >
            <span className="text-xs">{logsCollapsed ? "▶" : "▼"}</span>
            <span>Logs</span>
          </button>
          {!logsCollapsed && (
            <>
              <LogViewer
                id="logs-viewer"
                messages={messages}
                toolCalls={toolCalls}
                logs={logs}
                showSystemInfo={showSystemInfo}
                showReasoning={showReasoning}
                showTools={showTools}
                autoScroll={autoScroll}
                markdownEnabled={markdownEnabled}
                isActive={isLogActive}
              />
              {pendingPlanQuestion && (
                <div className="mt-4 flex-shrink-0 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/30">
                  <div className="mb-3">
                    <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                      Pending plan question
                    </h3>
                  </div>

                  <div className="space-y-4">
                    {pendingPlanQuestion.questions.map((question, questionIndex) => {
                      const selection = planQuestionSelections[questionIndex] ?? [];
                      const customAnswer = planQuestionCustomAnswers[questionIndex] ?? "";
                      const useCheckboxes = question.multiple === true;

                      return (
                        <div
                          key={`${pendingPlanQuestion.requestId}-${questionIndex}`}
                          className="rounded-md border border-amber-200/80 bg-white/70 p-3 dark:border-amber-900/50 dark:bg-neutral-900/40"
                        >
                          <div className="space-y-1">
                            <p className="text-xs font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
                              {question.header}
                            </p>
                            <p className="text-sm text-gray-900 dark:text-gray-100">
                              {question.question}
                            </p>
                          </div>

                          {question.options.length > 0 && (
                            <div className="mt-3 space-y-2">
                              {question.options.map((option) => {
                                const checked = selection.includes(option.label);
                                return (
                                  <label
                                    key={option.label}
                                    className="flex items-start gap-3 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:border-amber-300 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-200"
                                  >
                                    <input
                                      type={useCheckboxes ? "checkbox" : "radio"}
                                      name={`plan-question-${questionIndex}`}
                                      checked={checked}
                                      onChange={(event) => {
                                        const isChecked = event.target.checked;
                                        if (useCheckboxes) {
                                          onPlanQuestionSelectionsChange(
                                            planQuestionSelections.map((sel, idx) =>
                                              idx === questionIndex
                                                ? (isChecked ? [...sel, option.label] : sel.filter((v) => v !== option.label))
                                                : sel
                                            )
                                          );
                                        } else {
                                          onPlanQuestionSelectionsChange(
                                            planQuestionSelections.map((sel, idx) =>
                                              idx === questionIndex ? (isChecked ? [option.label] : []) : sel
                                            )
                                          );
                                        }
                                      }}
                                      className="mt-0.5 h-4 w-4 border-gray-300 text-amber-600 focus:ring-amber-500 dark:border-gray-600 dark:bg-neutral-700"
                                    />
                                    <span className="min-w-0">
                                      <span className="block font-medium text-gray-900 dark:text-gray-100">
                                        {option.label}
                                      </span>
                                      {option.description && (
                                        <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                                          {option.description}
                                        </span>
                                      )}
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          )}

                          <div className="mt-3">
                            <label
                              htmlFor={`plan-question-custom-${questionIndex}`}
                              className="block text-xs font-medium text-gray-700 dark:text-gray-300"
                            >
                              Your answer
                            </label>
                            <textarea
                              id={`plan-question-custom-${questionIndex}`}
                              value={customAnswer}
                              onChange={(event) => {
                                const value = event.target.value;
                                onPlanQuestionCustomAnswersChange(
                                  planQuestionCustomAnswers.map((ans, idx) => idx === questionIndex ? value : ans)
                                );
                              }}
                              rows={3}
                              placeholder={
                                question.options.length > 0
                                  ? "Optional freeform answer. If provided, it overrides the option selection above."
                                  : "Type your answer here..."
                              }
                              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-4 flex items-center justify-end">
                    <Button
                      type="button"
                      onClick={onAnswerPlanQuestion}
                      loading={planQuestionSubmitting}
                      disabled={planQuestionSubmitting}
                    >
                      Submit answer
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Log filter and autoscroll toggles at the bottom */}
      <div className="p-3 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={showSystemInfo}
              onChange={(e) => onShowSystemInfoChange(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600 text-gray-700 focus:ring-gray-500 focus:ring-offset-0 dark:text-gray-300"
            />
            <span>Show system info</span>
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={showReasoning}
              onChange={(e) => onShowReasoningChange(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600 text-gray-700 focus:ring-gray-500 focus:ring-offset-0 dark:text-gray-300"
            />
            <span>Show reasoning</span>
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={showTools}
              onChange={(e) => onShowToolsChange(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600 text-gray-700 focus:ring-gray-500 focus:ring-offset-0 dark:text-gray-300"
            />
            <span>Show tools</span>
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => onAutoScrollChange(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600 text-gray-700 focus:ring-gray-500 focus:ring-offset-0 dark:text-gray-300"
            />
            <span>Autoscroll</span>
          </label>
        </div>
      </div>
    </div>
  );
}
