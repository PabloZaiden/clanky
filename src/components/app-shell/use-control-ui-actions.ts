import { useCallback, useEffect, useRef, useState } from "react";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import type {
  ControlUiAction,
  ControlUiActionEvent,
  ControlUiActionOutcome,
} from "@/shared/clanky-control";
import { ControlUiActionEventSchema } from "@/shared/clanky-control";
import { apiRequest } from "../../lib/api-client";
import { getClankyClientId } from "../../lib/clanky-client-id";
import { useRealtimeStream } from "../../hooks/useRealtimeStream";
import { getExecutionHostSourceId } from "@/shared";
import type { useShellResources } from "./use-shell-resources";

const NAVIGATION_ACK_TIMEOUT_MS = 5_000;
const FILE_OPEN_ACK_TIMEOUT_MS = 18_000;
const MAX_RECENT_ACTIONS = 128;

export interface PendingControlFileOpen {
  actionId: string;
  workspaceId: string;
  filePath: string;
  action: Extract<ControlUiAction, { type: "open_workspace_file" }>;
}

interface PendingFileAction extends PendingControlFileOpen {
  resolve: (outcome: ControlUiActionOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingNavigation {
  expected: WebAppRoute;
  resolve: (applied: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

type NavigationResources = Pick<ReturnType<typeof useShellResources>,
  | "tasks" | "tasksError" | "refreshTasks"
  | "chats" | "chatsError" | "refreshChats"
  | "workspaces" | "workspaceError" | "refreshWorkspaces"
  | "agents"
  | "terminalSessions" | "terminalSessionsError" | "refreshTerminalSessions"
  | "servers" | "sshServersError" | "refreshSshServers"
  | "executionHosts" | "executionHostsError" | "refreshExecutionHosts"
>;

interface UseControlUiActionsOptions {
  route: WebAppRoute;
  navigateWithinShell: (route: WebAppRoute) => void;
  resources: NavigationResources;
  handleClientAction: (event: ControlUiActionEvent) => Promise<ControlUiActionOutcome | null>;
}

function isRouteActive(route: WebAppRoute, expected: WebAppRoute): boolean {
  return Object.entries(expected).every(([key, value]) => route[key] === value);
}

function getActionRoute(action: ControlUiAction): WebAppRoute | null {
  switch (action.type) {
    case "open_workspace":
      return { view: "workspace", workspaceId: action.workspaceId };
    case "open_workspace_file":
      return {
        view: "code-explorer",
        contentType: "workspace",
        workspaceId: action.workspaceId,
        filePath: action.filePath,
      };
    case "open_chat":
      return { view: "chat", chatId: action.chatId };
    case "open_task": return { view: "task", taskId: action.taskId };
    case "open_agent": return { view: "agent", agentId: action.agentId };
    case "open_terminal": return { view: "terminal", terminalSessionId: action.terminalSessionId };
    case "open_ssh_server": return { view: "execution-host", hostKind: "ssh", hostId: action.serverId };
    case "open_execution_host": return { view: "execution-host", hostKind: action.kind, hostId: action.id };
    case "open_home": return { view: "home" };
    case "open_settings": return { view: "settings" };
    default: return null;
  }
}

async function refreshNavigationTarget(action: ControlUiAction, resources: NavigationResources): Promise<void> {
  const options = { showLoading: false, afterCurrent: true };
  switch (action.type) {
    case "open_workspace":
    case "open_workspace_file": await resources.refreshWorkspaces(options); break;
    case "open_chat": await resources.refreshChats(options); break;
    case "open_task": await resources.refreshTasks(options); break;
    case "open_agent": await resources.agents.refresh(options); break;
    case "open_terminal": await resources.refreshTerminalSessions(options); break;
    case "open_ssh_server":
    case "open_execution_host":
      await Promise.all([
        resources.refreshExecutionHosts(options),
        ...(action.type === "open_ssh_server" || action.kind === "ssh"
          ? [resources.refreshSshServers(options)] : []),
      ]);
      break;
  }
}

function isNavigationTargetReady(expected: WebAppRoute, resources: NavigationResources): boolean {
  switch (expected.view) {
    case "workspace":
    case "code-explorer":
      return !resources.workspaceError && resources.workspaces.some((workspace) => workspace.id === expected["workspaceId"]);
    case "chat":
      return !resources.chatsError && resources.chats.some((chat) => chat.config.id === expected["chatId"]);
    case "task":
      return !resources.tasksError && resources.tasks.some((task) => task.config.id === expected["taskId"]);
    case "agent":
      return !resources.agents.error && resources.agents.agents.some((agent) => agent.config.id === expected["agentId"]);
    case "terminal":
      return !resources.terminalSessionsError && resources.terminalSessions.some((session) => session.config.id === expected["terminalSessionId"]);
    case "execution-host":
      return !resources.executionHostsError && resources.executionHosts.some((host) =>
        host.ref.kind === expected["hostKind"] && getExecutionHostSourceId(host.ref) === expected["hostId"])
        && (expected["hostKind"] !== "ssh" || !resources.sshServersError
          && resources.servers.some((server) => server.config.id === expected["hostId"]));
    default: return true;
  }
}

function actionFailure(
  code: Extract<ControlUiActionOutcome, { status: "failed" }>["code"],
  message: string,
): ControlUiActionOutcome {
  return { status: "failed", code, message };
}

export function useControlUiActions({
  route,
  navigateWithinShell,
  resources,
  handleClientAction,
}: UseControlUiActionsOptions) {
  const clientId = getClankyClientId();
  const resourcesRef = useRef(resources);
  const [navigationToCheck, setNavigationToCheck] = useState<WebAppRoute | null>(null);
  const [pendingFileOpen, setPendingFileOpen] = useState<PendingControlFileOpen | null>(null);
  const pendingFileActionRef = useRef<PendingFileAction | null>(null);
  const pendingNavigationRef = useRef<PendingNavigation | null>(null);
  const queuedActionsRef = useRef<Promise<void>>(Promise.resolve());
  const inFlightActionIdsRef = useRef(new Set<string>());
  const recentOutcomesRef = useRef(new Map<string, {
    event: ControlUiActionEvent;
    outcome: ControlUiActionOutcome;
  }>());

  const reportFileOpenResult = useCallback((
    actionId: string,
    outcome: ControlUiActionOutcome,
  ): void => {
    const pending = pendingFileActionRef.current;
    if (!pending || pending.actionId !== actionId) {
      return;
    }
    clearTimeout(pending.timer);
    pendingFileActionRef.current = null;
    setPendingFileOpen(null);
    pending.resolve(outcome);
  }, []);

  const waitForFileOpen = useCallback((event: ControlUiActionEvent): Promise<ControlUiActionOutcome> => {
    if (event.action.type !== "open_workspace_file") {
      return Promise.resolve(actionFailure("file_open_failed", "The requested file action is invalid."));
    }
    if (pendingFileActionRef.current) {
      return Promise.resolve(actionFailure("control_action_busy", "Another file-open action is still being applied."));
    }

    const action = event.action;
    const remainingTime = event.expiresAt - Date.now();
    if (remainingTime <= 0) {
      return Promise.resolve(actionFailure("control_action_timeout", "The UI action expired before the file could be opened."));
    }
    return new Promise((resolve) => {
      const request: PendingControlFileOpen = {
        actionId: event.actionId,
        workspaceId: action.workspaceId,
        filePath: action.filePath,
        action,
      };
      const timer = setTimeout(() => {
        reportFileOpenResult(
          event.actionId,
          actionFailure("control_action_timeout", "The originating tab did not finish opening the requested file."),
        );
      }, Math.min(FILE_OPEN_ACK_TIMEOUT_MS, remainingTime));
      pendingFileActionRef.current = { ...request, resolve, timer };
      setPendingFileOpen(request);
    });
  }, [reportFileOpenResult]);

  const waitForNavigation = useCallback((
    expected: WebAppRoute,
    expiresAt: number,
  ): Promise<boolean> => {
    const remainingTime = expiresAt - Date.now();
    if (remainingTime <= 0) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let pending: PendingNavigation;
      const timer = setTimeout(() => {
        if (pendingNavigationRef.current === pending) {
          pendingNavigationRef.current = null;
          resolve(false);
        }
      }, Math.min(NAVIGATION_ACK_TIMEOUT_MS, remainingTime));
      pending = { expected, resolve, timer };
      pendingNavigationRef.current = pending;
      // Even an already-active route must check refreshed resources after React commits.
      setNavigationToCheck(expected);
      try {
        navigateWithinShell(expected);
      } catch {
        clearTimeout(timer);
        pendingNavigationRef.current = null;
        resolve(false);
      }
    });
  }, [navigateWithinShell]);

  useEffect(() => {
    resourcesRef.current = resources;
    const pending = pendingNavigationRef.current;
    if (!pending || !isRouteActive(route, pending.expected)
      || !isNavigationTargetReady(pending.expected, resources)) {
      return;
    }
    clearTimeout(pending.timer);
    pendingNavigationRef.current = null;
    pending.resolve(true);
  }, [route, resources, navigationToCheck]);

  const acknowledge = useCallback(async (
    event: ControlUiActionEvent,
    outcome: ControlUiActionOutcome,
  ): Promise<void> => {
    await apiRequest(`/api/control/ui-actions/${encodeURIComponent(event.actionId)}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: event.clientId,
        source: event.source,
        outcome,
      }),
      action: "acknowledge control UI action",
      fallbackMessage: "The Clanky action acknowledgement was not accepted.",
    });
  }, []);

  const applyAction = useCallback(async (event: ControlUiActionEvent): Promise<ControlUiActionOutcome> => {
    const action = event.action;
    const clientResult = await handleClientAction(event);
    if (clientResult) return clientResult;
    const expected = getActionRoute(action);
    if (!expected) return actionFailure("navigation_failed", "This client action is unavailable.");
    try {
      await refreshNavigationTarget(action, resourcesRef.current);
    } catch {
      return actionFailure(
        action.type === "open_workspace" || action.type === "open_workspace_file"
          ? "workspace_unavailable" : "navigation_failed",
        "The requested navigation target could not be loaded.",
      );
    }

    if (event.expiresAt <= Date.now()) {
      return actionFailure("control_action_timeout", "The UI action expired before it could be applied.");
    }

    if (action.type === "open_workspace_file") {
      const fileResult = waitForFileOpen(event);
      const navigationApplied = await waitForNavigation(expected, event.expiresAt);
      if (!navigationApplied) {
        reportFileOpenResult(
          event.actionId,
          actionFailure("navigation_failed", "The file explorer route did not open in the originating tab."),
        );
      }
      return await fileResult;
    }

    const navigationApplied = await waitForNavigation(expected, event.expiresAt);
    return navigationApplied
      ? { status: "opened", action }
      : actionFailure("navigation_failed", "The requested route and its data did not become available in the originating tab.");
  }, [
    reportFileOpenResult,
    waitForFileOpen,
    waitForNavigation,
    handleClientAction,
  ]);

  const rememberOutcome = useCallback((
    event: ControlUiActionEvent,
    outcome: ControlUiActionOutcome,
  ): void => {
    recentOutcomesRef.current.set(event.actionId, { event, outcome });
    while (recentOutcomesRef.current.size > MAX_RECENT_ACTIONS) {
      const oldestActionId = recentOutcomesRef.current.keys().next().value;
      if (!oldestActionId) {
        break;
      }
      recentOutcomesRef.current.delete(oldestActionId);
    }
  }, []);

  const processAction = useCallback(async (event: ControlUiActionEvent): Promise<void> => {
    if (event.expiresAt <= Date.now()) {
      inFlightActionIdsRef.current.delete(event.actionId);
      return;
    }
    let outcome: ControlUiActionOutcome;
    try {
      outcome = await applyAction(event);
    } catch (error) {
      console.error("Failed to apply Clanky UI action", {
        actionId: event.actionId,
        action: event.action.type,
        error: String(error),
      });
      if (event.action.type === "open_workspace_file") {
        reportFileOpenResult(
          event.actionId,
          actionFailure("file_open_failed", "The requested file could not be opened."),
        );
      }
      outcome = actionFailure("navigation_failed", "The Clanky UI action could not be applied.");
    }
    if (event.expiresAt <= Date.now()) {
      inFlightActionIdsRef.current.delete(event.actionId);
      return;
    }

    rememberOutcome(event, outcome);
    try {
      await acknowledge(event, outcome);
    } catch (error) {
      console.error("Failed to acknowledge Clanky UI action", {
        actionId: event.actionId,
        error: String(error),
      });
    } finally {
      inFlightActionIdsRef.current.delete(event.actionId);
    }
  }, [acknowledge, applyAction, rememberOutcome]);

  const handleRealtimeEvent = useCallback((rawEvent: ControlUiActionEvent): void => {
    const parsed = ControlUiActionEventSchema.safeParse(rawEvent);
    if (!parsed.success || parsed.data.clientId !== clientId || parsed.data.expiresAt <= Date.now()) {
      return;
    }
    const event = parsed.data;
    const recent = recentOutcomesRef.current.get(event.actionId);
    if (recent) {
      void acknowledge(recent.event, recent.outcome).catch((error: unknown) => {
        console.error("Failed to repeat Clanky UI action acknowledgement", {
          actionId: event.actionId,
          error: String(error),
        });
      });
      return;
    }
    if (inFlightActionIdsRef.current.has(event.actionId)) {
      return;
    }
    inFlightActionIdsRef.current.add(event.actionId);
    queuedActionsRef.current = queuedActionsRef.current.then(() => processAction(event));
  }, [acknowledge, clientId, processAction]);

  useRealtimeStream<ControlUiActionEvent>({
    filters: { clientId },
    predicate: (event) => event.type === "control.ui_action" && event.clientId === clientId,
    onEvent: handleRealtimeEvent,
  });

  useEffect(() => () => {
    const pendingNavigation = pendingNavigationRef.current;
    if (pendingNavigation) {
      clearTimeout(pendingNavigation.timer);
      pendingNavigationRef.current = null;
      pendingNavigation.resolve(false);
    }
    const pendingFileAction = pendingFileActionRef.current;
    if (pendingFileAction) {
      clearTimeout(pendingFileAction.timer);
      pendingFileActionRef.current = null;
      pendingFileAction.resolve(actionFailure(
        "control_action_timeout",
        "The originating tab closed before the requested file was opened.",
      ));
    }
  }, []);

  return {
    pendingFileOpen,
    reportFileOpenResult,
  };
}
