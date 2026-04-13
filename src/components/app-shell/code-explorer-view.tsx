import { useMemo, type ComponentType } from "react";
import type { Chat, CreateSshSessionRequest, Loop, SshConnectionMode, SshSession, Workspace } from "../../types";
import type { SshServer, SshServerSession } from "../../types/ssh-server";
import type { SshSessionDetailsProps } from "../SshSessionDetails";
import { ShellPanel } from "./shell-panel";
import { FileExplorerView } from "./file-explorer-view";
import { getCodeExplorerOptions, resolveCodeExplorerTarget } from "./code-explorer-targets";
import type { CodeExplorerTarget, ShellRoute } from "./shell-types";

interface CodeExplorerViewProps {
  routeTarget?: CodeExplorerTarget;
  loops: Loop[];
  chats: Chat[];
  workspaces: Workspace[];
  sessions: SshSession[];
  servers: SshServer[];
  sessionsByServerId: Record<string, SshServerSession[]>;
  headerOffsetClassName?: string;
  createSession: (request: CreateSshSessionRequest) => Promise<SshSession>;
  createStandaloneSession: (
    serverId: string,
    options?: { name?: string; connectionMode?: SshConnectionMode },
  ) => Promise<SshServerSession>;
  onNavigate: (route: ShellRoute) => void;
  sshSessionDetailsComponent?: ComponentType<SshSessionDetailsProps>;
}

export function CodeExplorerView({
  routeTarget,
  loops,
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
    loops,
    chats,
    workspaces,
    servers,
  }), [chats, loops, servers, workspaces]);
  const resolvedTarget = resolveCodeExplorerTarget({
    target: routeTarget,
    loops,
    chats,
    workspaces,
    sessions,
    servers,
    sessionsByServerId,
    createSession,
    createStandaloneSession,
  });
  const selectedOptionId = options.find((option) => {
    if (!routeTarget) {
      return false;
    }

    const routeTargetId = routeTarget.contentType === "workspace"
      ? routeTarget.workspaceId
      : routeTarget.contentType === "loop"
        ? routeTarget.loopId
        : routeTarget.contentType === "server"
          ? routeTarget.serverId
          : routeTarget.chatId;
    const optionTargetId = option.target.contentType === "workspace"
      ? option.target.workspaceId
      : option.target.contentType === "loop"
        ? option.target.loopId
        : option.target.contentType === "server"
          ? option.target.serverId
          : option.target.chatId;

    return option.kind === routeTarget.contentType && optionTargetId === routeTargetId;
  })?.id ?? "";
  const contentSwitcher = (
    <select
      value={selectedOptionId}
      onChange={(event) => {
        const nextOption = options.find((option) => option.id === event.target.value);
        if (nextOption) {
          onNavigate({ view: "code-explorer", target: nextOption.target });
        }
      }}
      aria-label="Select code explorer content"
      className="min-w-0 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 sm:w-[18rem] lg:w-[20rem] dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100"
    >
      <option value="">Select code explorer content</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.kind}: {option.label}
        </option>
      ))}
    </select>
  );

  if (!routeTarget || !resolvedTarget) {
    return (
      <ShellPanel
        title="Code explorer"
        description="Choose the content you want to explore."
        variant="compact"
        headerOffsetClassName={headerOffsetClassName}
        actions={contentSwitcher}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Open a workspace, loop, SSH server, or chat path in the unified code explorer.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => onNavigate({ view: "code-explorer", target: option.target })}
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
      testIdPrefix={resolvedTarget.testIdPrefix}
      credentialPromptName={resolvedTarget.credentialPromptName}
      headerActions={contentSwitcher}
      sshSessionDetailsComponent={sshSessionDetailsComponent}
    />
  );
}
