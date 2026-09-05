import { useMemo } from "react";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import type {
  Chat,
  ExecutionHostDescriptor,
  Task,
  Workspace,
  TerminalSession,
} from "@/shared";
import type { CreateTerminalSessionRequest } from "@/contracts";
import { FileExplorerView } from "./file-explorer-view";
import {
  getCodeExplorerOptionGroups,
  getCodeExplorerOptions,
  resolveCodeExplorerTarget,
} from "./code-explorer-targets";
import type { CodeExplorerTarget } from "./shell-types";

interface CodeExplorerViewProps {
  routeTarget?: CodeExplorerTarget;
  tasks: Task[];
  chats: Chat[];
  executionHosts?: ExecutionHostDescriptor[];
  workspaces: Workspace[];
  terminalSessions: TerminalSession[];
  createTerminalSession: (request: CreateTerminalSessionRequest) => Promise<TerminalSession>;
  onNavigate: (route: WebAppRoute) => void;
}

export function CodeExplorerView({
  routeTarget,
  tasks,
  chats,
  executionHosts = [],
  workspaces,
  terminalSessions,
  createTerminalSession,
  onNavigate,
}: CodeExplorerViewProps) {
  const options = useMemo(() => getCodeExplorerOptions({
    tasks,
    chats,
    executionHosts,
    workspaces,
  }), [chats, executionHosts, tasks, workspaces]);
  const groupedOptions = useMemo(() => getCodeExplorerOptionGroups(options), [options]);
  const resolvedTarget = resolveCodeExplorerTarget({
    target: routeTarget,
    tasks,
    chats,
    executionHosts,
    workspaces,
    terminalSessions,
    createTerminalSession,
  });

  if (!routeTarget || !resolvedTarget) {
    return (
      <div className="h-full overflow-auto p-6">
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Open a workspace, task, server, or chat path in the unified code explorer.
          </p>
          <div className="space-y-5">
            {groupedOptions.map((group) => (
              <section key={group.kind} aria-label={group.label} className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">
                  {group.label}
                </h2>
                <div className="grid gap-2 sm:grid-cols-2">
                  {group.options.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => onNavigate({
                        view: "code-explorer",
                        contentType: option.target.contentType,
                        ...(option.target.contentType === "workspace"
                          ? { workspaceId: option.target.workspaceId }
                          : option.target.contentType === "task"
                            ? { taskId: option.target.taskId }
                            : option.target.contentType === "execution-host"
                                ? {
                                    hostKind: option.target.hostKind,
                                    hostId: option.target.hostId,
                                  }
                              : { chatId: option.target.chatId }),
                      })}
                      className="rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300 hover:bg-gray-100 dark:border-gray-800 dark:bg-neutral-900 dark:hover:border-gray-700 dark:hover:bg-neutral-800"
                    >
                      <div className="text-sm font-medium text-gray-950 dark:text-gray-100">{option.label}</div>
                      <div className="mt-1 text-xs uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">
                        {option.kind}
                      </div>
                      <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">{option.description}</div>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <FileExplorerView
      title={resolvedTarget.title}
      defaultRootDirectory={resolvedTarget.defaultRootDirectory}
      backRoute={resolvedTarget.backRoute}
      onNavigate={onNavigate}
      target={resolvedTarget.target}
      buildRoute={resolvedTarget.buildRoute}
      sessions={resolvedTarget.sessions}
      hasTerminal={resolvedTarget.hasTerminal}
      emptyTerminalMessage={resolvedTarget.emptyTerminalMessage}
      terminalSelectLabel={resolvedTarget.terminalSelectLabel}
      onCreateTerminal={resolvedTarget.onCreateTerminal}
      canChooseTerminalTmux={resolvedTarget.canChooseTerminalTmux}
      testIdPrefix={resolvedTarget.testIdPrefix}
      credentialPromptName={resolvedTarget.credentialPromptName}
      initialFilePath={resolvedTarget.initialFilePath}
    />
  );
}
