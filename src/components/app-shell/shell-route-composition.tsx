import { useEffect, type ReactNode } from "react";
import { ErrorState, LoadingState, Page, type WebAppRoute } from "@pablozaiden/webapp/web";
import { useWebAppConfig, type WebAppConfigState } from "@/platform/web/webapp-config";
import { type WebAppRootProps } from "@/platform/web/root-types";
import type {
  Automation,
  Chat,
  ExecutionHostDescriptor,
  TerminalSession,
  Workspace,
} from "@/shared";
import { getExecutionHostSourceId } from "@/shared";
import { decodeCollaborationResourceReference } from "@/shared/collaboration-reference";
import { StandaloneChatTranscriptViewer } from "../StandaloneChatTranscriptViewer";
import { AppRouteContent, type ShellMainContentProps } from "./shell-main-content";
import { getRouteString } from "./route-fields";
import { getClankyRouteUnavailableReason } from "../../client-sdk/capabilities";
import { ControlRequestPage } from "../control/control-request-page";
import { ControlConsentPage } from "../control/control-consent-page";

const ROUTE_VIEWS = [
  "home",
  "trash",
  "automations",
  "automation",
  "automation-run",
  "code-explorer",
  "scratchpad",
  "chat",
  "chat-transcript",
  "terminal",
  "workspace",
  "workspace-files",
  "workspace-previews",
  "workspace-settings",
  "execution-host",
  "execution-host-files",
  "provisioning-job",
  "worker-update-job",
  "compose",
  "rebuild-workspace",
  "restart-workspace",
  "control-request",
  "control-consent",
] as const;

const WORKSPACE_ENTITY_ROUTE_VIEWS = new Set([
  "workspace",
  "workspace-files",
  "workspace-previews",
  "workspace-settings",
  "scratchpad",
  "rebuild-workspace",
  "restart-workspace",
]);

export interface ShellRouteSelection {
  chatId: string | undefined;
  composeKind: string | undefined;
  selectedChat: Chat | null;
  selectedWorkspace: Workspace | null;
  composeWorkspace: Workspace | null;
  composeExecutionHost: ExecutionHostDescriptor | null;
  selectedAutomation: Automation | null;
}

type ShellRouteContentSelection = Pick<
  ShellRouteSelection,
  | "selectedChat"
  | "selectedWorkspace"
  | "composeWorkspace"
  | "composeExecutionHost"
>;

function ApprovalSettingsRedirect({ onNavigate }: { onNavigate: (route: WebAppRoute) => void }) {
  useEffect(() => onNavigate({ view: "settings", category: "integrations" }), [onNavigate]);
  return <Page><LoadingState title="Opening approvals settings" /></Page>;
}

export type ShellRouteCompositionContext = Omit<
  ShellMainContentProps,
  "route" | keyof ShellRouteContentSelection
>;

interface ShellRouteSelectionData {
  chats: Chat[];
  workspaces: Workspace[];
  executionHosts: ExecutionHostDescriptor[];
  automations: Automation[];
}

interface ShellRouteEntityCollection<T> {
  items: T[];
  loading: boolean;
  error: string | null;
}

interface ShellRouteEntityResources {
  chats: ShellRouteEntityCollection<Chat>;
  workspaces: ShellRouteEntityCollection<Workspace>;
  executionHosts: ShellRouteEntityCollection<ExecutionHostDescriptor>;
  automations: ShellRouteEntityCollection<Automation>;
  terminalSessions: ShellRouteEntityCollection<TerminalSession>;
}

function isMissingFromCollection<T>(
  id: string | undefined,
  collection: ShellRouteEntityCollection<T>,
  getId: (item: T) => string,
): boolean {
  if (id && decodeCollaborationResourceReference(id)) return false;
  return Boolean(id)
    && !collection.loading
    && collection.error === null
    && !collection.items.some((item) => getId(item) === id);
}

export function isMissingShellRouteTarget(
  route: WebAppRoute,
  resources: ShellRouteEntityResources,
): boolean {
  const codeExplorerType = route.view === "code-explorer"
    ? getRouteString(route, "contentType")
    : undefined;
  const chatId = route.view === "chat"
    ? getRouteString(route, "chatId")
    : codeExplorerType === "chat"
      ? getRouteString(route, "chatId")
      : undefined;
  if (isMissingFromCollection(chatId, resources.chats, (chat) => chat.config.id)) {
    return true;
  }

  const workspaceId = WORKSPACE_ENTITY_ROUTE_VIEWS.has(route.view)
    ? getRouteString(route, "workspaceId")
    : codeExplorerType === "workspace"
      ? getRouteString(route, "workspaceId")
      : undefined;
  if (isMissingFromCollection(workspaceId, resources.workspaces, (workspace) => workspace.id)) {
    return true;
  }

  const automationId = route.view === "automation" || route.view === "automation-run"
    ? getRouteString(route, "automationId")
    : undefined;
  if (isMissingFromCollection(automationId, resources.automations, (automation) => automation.config.id)) {
    return true;
  }

  const terminalSessionId = route.view === "terminal"
    ? getRouteString(route, "terminalSessionId")
    : undefined;
  if (isMissingFromCollection(
    terminalSessionId,
    resources.terminalSessions,
    (session) => session.config.id,
  )) {
    return true;
  }

  const executionHostRoute = route.view === "execution-host"
    || route.view === "execution-host-files"
    || codeExplorerType === "execution-host"
    || (route.view === "compose"
      && ["execution-host-chat", "execution-host-terminal"].includes(
        getRouteString(route, "kind") ?? "",
      ));
  if (executionHostRoute) {
    const hostKind = getRouteString(route, "hostKind");
    const hostId = getRouteString(route, "hostId");
    if (
      hostKind
      && hostId
      && ["local", "mesh"].includes(hostKind)
      && isMissingFromCollection(
        hostId,
        resources.executionHosts,
        (host) => host.ref.kind === hostKind
          ? getExecutionHostSourceId(host.ref)
          : "",
      )
    ) {
      return true;
    }
  }

  return false;
}

export function getShellRouteSelection(
  route: WebAppRoute,
  {
    chats,
    workspaces,
    executionHosts,
    automations,
  }: ShellRouteSelectionData,
): ShellRouteSelection {
  const codeExplorerContentType = route.view === "code-explorer" ? route["contentType"] : undefined;
  const codeExplorerChatId = codeExplorerContentType === "chat"
    ? getRouteString(route, "chatId") ?? null
    : null;
  const codeExplorerWorkspaceId = codeExplorerContentType === "workspace"
    ? getRouteString(route, "workspaceId") ?? null
    : null;
  const chatId = getRouteString(route, "chatId");
  const workspaceId = getRouteString(route, "workspaceId");
  const composeKind = route.view === "compose" ? getRouteString(route, "kind") : undefined;
  const composeScopeId = route.view === "compose" ? getRouteString(route, "scopeId") : undefined;
  const isExecutionHostCompose = composeKind === "execution-host-chat"
    || composeKind === "execution-host-terminal";

  const selectedChat =
    route.view === "chat" || route.view === "chat-transcript"
      ? (chatId ? (chats.find((chat) => chat.config.id === chatId) ?? null) : null)
      : codeExplorerChatId
        ? (chats.find((chat) => chat.config.id === codeExplorerChatId) ?? null)
        : null;
  const selectedWorkspace =
    route.view === "workspace"
      || route.view === "workspace-files"
      || route.view === "workspace-previews"
      || route.view === "workspace-settings"
      || route.view === "scratchpad"
      || route.view === "rebuild-workspace"
      || route.view === "restart-workspace"
      ? (workspaceId ? (workspaces.find((workspace) => workspace.id === workspaceId) ?? null) : null)
      : codeExplorerWorkspaceId
        ? (workspaces.find((workspace) => workspace.id === codeExplorerWorkspaceId) ?? null)
        : codeExplorerChatId
            ? (workspaces.find((workspace) => workspace.id === selectedChat?.config.workspaceId) ?? null)
            : null;
  const composeWorkspace =
    route.view === "compose"
      && !isExecutionHostCompose
      ? (workspaces.find((workspace) => workspace.id === (workspaceId ?? composeScopeId)) ?? null)
      : null;
  const composeExecutionHost =
    route.view === "compose" && isExecutionHostCompose
      ? (executionHosts.find((host) => {
          const hostId = getExecutionHostSourceId(host.ref);
          return host.ref.kind === getRouteString(route, "hostKind")
            && hostId === getRouteString(route, "hostId");
        }) ?? null)
      : null;
  const selectedAutomationId = route.view === "automation" || route.view === "automation-run"
    ? getRouteString(route, "automationId") ?? null
    : null;
  const selectedAutomation = selectedAutomationId
    ? (automations.find((automation) => automation.config.id === selectedAutomationId) ?? null)
    : null;

  return {
    chatId,
    composeKind,
    selectedChat,
    selectedWorkspace,
    composeWorkspace,
    composeExecutionHost,
    selectedAutomation,
  };
}

function renderShellRouteContent(
  route: WebAppRoute,
  context: ShellRouteCompositionContext,
): ReactNode {
  const unavailable = getClankyRouteUnavailableReason(route);
  if (unavailable) {
    return <Page><ErrorState title="Operation unavailable" description={unavailable} /></Page>;
  }
  if (route.view === "control-request") {
    const requestId = getRouteString(route, "requestId");
    return requestId
      ? <ControlRequestPage key={requestId} requestId={requestId} />
      : <ApprovalSettingsRedirect onNavigate={context.navigateWithinShell} />;
  }
  if (route.view === "control-consent") {
    return <ControlConsentPage />;
  }
  if (route.view === "chat-transcript") {
    const transcriptChatId = getRouteString(route, "chatId");
    return (
      <Page layout="full" className="standalone-transcript-page">
        {context.missingRouteTarget
          ? <LoadingState title="Returning home" />
          : transcriptChatId
            ? (
              <StandaloneChatTranscriptViewer
                chatId={transcriptChatId}
                onMissingEntity={() => context.navigateWithinShell({ view: "home" })}
              />
            )
          : (
            <ErrorState
              title="Chat transcript not found"
              description="The transcript route is missing a chat identifier."
            />
          )}
      </Page>
    );
  }

  const selection = getShellRouteSelection(route, {
    chats: context.chats,
    workspaces: context.workspaces,
    executionHosts: context.executionHosts,
    automations: context.automations.automations,
  });

  return (
    <AppRouteContent
      {...context}
      route={route}
      selectedChat={selection.selectedChat}
      selectedWorkspace={selection.selectedWorkspace}
      composeWorkspace={selection.composeWorkspace}
      composeExecutionHost={selection.composeExecutionHost}
    />
  );
}

export function buildShellRoutes(
  context: ShellRouteCompositionContext,
): WebAppRootProps["routes"] {
  const renderRouteContent = (route: WebAppRoute) => renderShellRouteContent(route, context);
  return Object.fromEntries(
    ROUTE_VIEWS.map((view) => [view, renderRouteContent]),
  ) as WebAppRootProps["routes"];
}

export function ShellRuntimeObserver({
  onOwnerChange,
  onConfigChange,
}: {
  onOwnerChange: (isOwner: boolean) => void;
  onConfigChange: (config: WebAppConfigState["config"]) => void;
}) {
  const { config } = useWebAppConfig();
  const isOwner = config?.currentUser?.isOwner === true;
  useEffect(() => {
    onOwnerChange(isOwner);
    onConfigChange(config);
    return () => { onOwnerChange(false); onConfigChange(undefined); };
  }, [config, isOwner, onConfigChange, onOwnerChange]);
  return null;
}
