/**
 * Originating-tab context and framework confirmations.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmModal, useToast, type WebAppRootController } from "@pablozaiden/webapp/web";
import type { ControlUiActionEvent, ControlUiActionOutcome } from "@/shared/clanky-control";
import type { ControlConfirmation } from "@/shared/control-interactions";
import type { UseLiveVoiceResult } from "../../hooks/useLiveVoice";
import { apiRequest } from "../../lib/api-client";
import { getClankyClientId } from "../../lib/clanky-client-id";

export function useVoiceClientActions(options: {
  voice: UseLiveVoiceResult;
  rootRef: React.RefObject<WebAppRootController | null>;
}) {
  const toast = useToast();
  const [confirmation, setConfirmation] = useState<{ callId: string; value: ControlConfirmation; shown: () => void } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const confirming = useRef(false);
  const presentations = useRef(new Set<() => void>());
  useEffect(() => {
    controller.current?.abort();
    controller.current = new AbortController();
    setConfirmation(null);
    return () => {
      controller.current?.abort();
      for (const resolve of presentations.current) resolve();
      presentations.current.clear();
    };
  }, [options.voice.callId]);

  const handleAction = useCallback(async (event: ControlUiActionEvent): Promise<ControlUiActionOutcome | null> => {
    const action = event.action;
    if (action.type === "sidebar") {
      const sidebar = options.rootRef.current?.sidebar;
      if (!sidebar) return { status: "failed", code: "navigation_failed", message: "The sidebar is unavailable." };
      if (action.command === "open") sidebar.open();
      else if (action.command === "search") sidebar.focusSearch();
      else {
        if (!action.tabId || !["active", "workspaces", "servers"].includes(action.tabId)) {
          return { status: "failed", code: "navigation_failed", message: "The sidebar tab is unavailable." };
        }
        sidebar.selectTab(action.tabId);
        sidebar.open();
      }
      return { status: "opened", action };
    }
    if (!["get_context", "confirm_operation"].includes(action.type)) return null;
    if (action.type === "get_context" && event.source.kind === "chat_turn") {
      return { status: "context", context: options.voice.getContext() };
    }
    if (event.source.kind !== "live_voice" || event.source.callId !== options.voice.callId) {
      return { status: "failed", code: "navigation_failed", message: "The originating Live call is no longer active." };
    }
    const callId = event.source.callId;
    if (action.type === "get_context") return { status: "context", context: options.voice.getContext() };
    if (action.type === "confirm_operation") {
      if (confirmation) return { status: "failed", code: "control_action_busy", message: "Another voice dialog is open." };
      const signal = controller.current?.signal;
      const presentation = Promise.withResolvers<void>();
      presentations.current.add(presentation.resolve);
      setConfirmation({ callId, value: action.confirmation, shown: presentation.resolve });
      await presentation.promise;
      presentations.current.delete(presentation.resolve);
      if (signal?.aborted) return { status: "failed", code: "navigation_failed", message: "The call has ended." };
      return { status: "presented" };
    }
    return null;
  }, [options.voice.callId, options.voice.getContext, options.rootRef, confirmation]);

  useEffect(() => { confirmation?.shown(); }, [confirmation]);
  const respondConfirmation = useCallback(async (approved: boolean): Promise<void> => {
    if (!confirmation || confirming.current) return;
    const pending = confirmation;
    confirming.current = true;
    setConfirmation(null);
    const signal = controller.current?.signal;
    try {
      const result = await apiRequest<{ ok: boolean; message?: string }>(
        `/api/voice/live/${encodeURIComponent(pending.callId)}/confirmations/${encodeURIComponent(pending.value.requestId)}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId: getClankyClientId(), approved }),
          signal, action: approved ? "Confirm voice operation" : "Reject voice operation",
        },
      );
      if (!signal?.aborted && !result.ok) toast.error(result.message ?? "The operation was not completed. Inspect its target before repeating it.");
    } catch (failure) {
      if (!signal?.aborted) toast.error(String(failure));
    } finally { confirming.current = false; }
  }, [confirmation, toast]);

  useEffect(() => {
    if (!confirmation) return;
    const timer = setTimeout(() => {
      setConfirmation(null);
      toast.error("The voice confirmation expired. Request the action again.");
    }, Math.max(0, confirmation.value.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [confirmation, toast]);

  return {
    handleAction,
    dialogs: (
      <>
        <ConfirmModal isOpen={confirmation !== null} title="Confirm action"
          message={confirmation?.value.description ?? ""}
          confirmLabel="Approve" cancelLabel="Reject"
          onConfirm={() => void respondConfirmation(true)} onClose={() => void respondConfirmation(false)} />
      </>
    ),
  };
}
