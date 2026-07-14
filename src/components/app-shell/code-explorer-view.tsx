import { useMemo, type ComponentType } from "react";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import type { Chat, Task, SshConnectionMode, SshSession, Workspace } from "@/shared";
import type { CreateSshSessionRequest } from "@/contracts";
import type { SshServer, SshServerSession } from "@/shared/ssh-server";
import type { SshSessionDetailsProps } from "../SshSessionDetails";
import { ShellPanel } from "./shell-panel";
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
  workspaces: Workspace[];
  sessions: SshSession[];
  servers: SshServer[];
  sessionsByServerId: Record<string, SshServerSession[]>;
  headerOffsetClassName?: string;
  createSession: (request: CreateSshSessionRequest) => Promise<SshSession>;
  createStandaloneSession: (
    serverId: string,
    options?: { name?: string; connectionMode?: SshConnectionMode; useTmux?: boolean },
  ) => Promise<SshServerSession>;
  onNavigate: (route: WebAppRoute) => void;
  sshSessionDetailsComponent?: ComponentType<SshSessionDetailsProps>;
}

export function CodeExplorerView({
  routeTarget,
  tasks,
  chats,
  workspaces,
  sessions,
  servers,
  sessionsByServerId,
  headerOffsetClassName,
  createSession,
  createStandaloneSession,
  onNavigate,
  sshSessionDetailsComponent,
}: CodeExplorerViewProps) {
  const options = useMemo(() => getCodeExplorerOptions({
    tasks,
    chats,
    workspaces,
    servers,
  }), [chats, tasks, servers, workspaces]);
  const groupedOptions = useMemo(() => getCodeExplorerOptionGroups(options), [options]);
  const resolvedTarget = resolveCodeExplorerTarget({
    target: routeTarget,
    tasks,
    chats,
    workspaces,
    sessions,
    servers,
    sessionsByServerId,
    createSession,
    createStandaloneSession,
  });

  if (!routeTarget || !resolvedTarget) {
    return (
      <ShellPanel
        title="Code explorer"
        description="Choose the content you want to explore."
        variant="compact"
        headerOffsetClassName={headerOffsetClassName}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Open a workspace, task, SSH server, or chat path in the unified code explorer.
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
                            : option.target.contentType === "server"
                              ? { serverId: option.target.serverId }
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
      </ShellPanel>
    );
  }

  return (
    <FileExplorerView
      title={resolvedTarget.title}
      description={resolvedTarget.description}
      defaultRootDirectory={resolvedTarget.defaultRootDirectory}
      headerOffsetClassName={headerOffsetClassName}
      backLabel={resolvedTarget.backLabel}
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
      sshSessionDetailsComponent={sshSessionDetailsComponent}
    />
  );
}
