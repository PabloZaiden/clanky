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

interface UseControlUiActionsOptions {
  route: WebAppRoute;
  navigateWithinShell: (route: WebAppRoute) => void;
  refreshChats: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
}

function isRouteActive(route: WebAppRoute, expected: WebAppRoute): boolean {
  return Object.entries(expected).every(([key, value]) => route[key] === value);
}

function getActionRoute(action: ControlUiAction): WebAppRoute {
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
  refreshChats,
  refreshWorkspaces,
}: UseControlUiActionsOptions) {
  const clientId = getClankyClientId();
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
    if (isRouteActive(route, expected)) {
      navigateWithinShell(expected);
      return Promise.resolve(true);
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
      try {
        navigateWithinShell(expected);
      } catch {
        clearTimeout(timer);
        pendingNavigationRef.current = null;
        resolve(false);
      }
    });
  }, [navigateWithinShell, route]);

  useEffect(() => {
    const pending = pendingNavigationRef.current;
    if (!pending || !isRouteActive(route, pending.expected)) {
      return;
    }
    clearTimeout(pending.timer);
    pendingNavigationRef.current = null;
    pending.resolve(true);
  }, [route]);

  const acknowledge = useCallback(async (
    event: ControlUiActionEvent,
    outcome: ControlUiActionOutcome,
  ): Promise<void> => {
    await apiRequest(`/api/control/ui-actions/${encodeURIComponent(event.actionId)}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: event.clientId,
        chatId: event.chatId,
        turnId: event.turnId,
        outcome,
      }),
      action: "acknowledge control UI action",
      fallbackMessage: "The Clanky action acknowledgement was not accepted.",
    });
  }, []);

  const applyAction = useCallback(async (event: ControlUiActionEvent): Promise<ControlUiActionOutcome> => {
    const action = event.action;
    if (action.type === "open_workspace" || action.type === "open_workspace_file") {
      try {
        await refreshWorkspaces();
      } catch {
        return actionFailure("workspace_unavailable", "The requested workspace could not be loaded.");
      }
    } else {
      try {
        await refreshChats();
      } catch {
        return actionFailure("navigation_failed", "The requested chat could not be loaded.");
      }
    }

    if (event.expiresAt <= Date.now()) {
      return actionFailure("control_action_timeout", "The UI action expired before it could be applied.");
    }

    if (action.type === "open_workspace_file") {
      const fileResult = waitForFileOpen(event);
      const navigationApplied = await waitForNavigation(getActionRoute(action), event.expiresAt);
      if (!navigationApplied) {
        reportFileOpenResult(
          event.actionId,
          actionFailure("navigation_failed", "The file explorer route did not open in the originating tab."),
        );
      }
      return await fileResult;
    }

    const navigationApplied = await waitForNavigation(getActionRoute(action), event.expiresAt);
    return navigationApplied
      ? { status: "opened", action }
      : actionFailure("navigation_failed", "The requested route did not open in the originating tab.");
  }, [
    refreshChats,
    refreshWorkspaces,
    reportFileOpenResult,
    waitForFileOpen,
    waitForNavigation,
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
