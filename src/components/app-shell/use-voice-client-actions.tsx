/**
 * Originating-tab context, framework confirmations and private SSH prompts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmModal, ErrorState, useToast, type WebAppRootController } from "@pablozaiden/webapp/web";
import type { ControlUiActionEvent, ControlUiActionOutcome } from "@/shared/clanky-control";
import type { VoiceConfirmation } from "@/shared/live-voice";
import type { UseLiveVoiceResult } from "../../hooks/useLiveVoice";
import { apiRequest } from "../../lib/api-client";
import { getClankyClientId } from "../../lib/clanky-client-id";
import { getStoredSshCredentialToken, storeSshServerPassword } from "../../lib/ssh-browser-credentials";
import { ServerPasswordModal } from "./server-password-modal";

export function useVoiceClientActions(options: {
  voice: UseLiveVoiceResult;
  rootRef: React.RefObject<WebAppRootController | null>;
}) {
  const toast = useToast();
  const [confirmation, setConfirmation] = useState<{ callId: string; value: VoiceConfirmation; shown: () => void } | null>(null);
  const [credential, setCredential] = useState<{ callId: string; requestId: string; serverId: string; serverName: string; expiresAt: number } | null>(null);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const confirming = useRef(false);
  const presentations = useRef(new Set<() => void>());
  useEffect(() => {
    controller.current?.abort();
    controller.current = new AbortController();
    setConfirmation(null);
    setCredential(null);
    setPassword("");
    setError(null);
    setSubmitting(false);
    return () => {
      controller.current?.abort();
      for (const resolve of presentations.current) resolve();
      presentations.current.clear();
    };
  }, [options.voice.callId]);

  const handoff = useCallback(async (request: { callId: string; requestId: string }, token: string | null): Promise<void> => {
    await apiRequest(`/api/voice/live/${encodeURIComponent(request.callId)}/credentials/${encodeURIComponent(request.requestId)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: getClankyClientId(), credentialToken: token }),
      signal: controller.current?.signal, action: "Supply SSH credential",
    });
  }, []);

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
    if (!["get_context", "confirm_operation", "request_ssh_credential"].includes(action.type)) return null;
    if (event.source.kind !== "live_voice" || event.source.callId !== options.voice.callId) {
      return { status: "failed", code: "navigation_failed", message: "The originating Live call is no longer active." };
    }
    const callId = event.source.callId;
    if (action.type === "get_context") return { status: "context", context: options.voice.getContext() };
    if (action.type === "confirm_operation") {
      if (confirmation || credential) return { status: "failed", code: "control_action_busy", message: "Another voice dialog is open." };
      const signal = controller.current?.signal;
      setError(null);
      const presentation = Promise.withResolvers<void>();
      presentations.current.add(presentation.resolve);
      setConfirmation({ callId, value: action.confirmation, shown: presentation.resolve });
      await presentation.promise;
      presentations.current.delete(presentation.resolve);
      if (signal?.aborted) return { status: "failed", code: "navigation_failed", message: "The call has ended." };
      return { status: "presented" };
    }
    if (action.type === "request_ssh_credential") {
      if (credential || confirmation) return { status: "failed", code: "control_action_busy", message: "Another voice dialog is open." };
      const request = { callId, requestId: action.requestId, serverId: action.serverId, serverName: action.serverName, expiresAt: action.expiresAt };
      const signal = controller.current?.signal;
      // Credential exchange is a private client HTTP operation; its token is never an ACK or model output.
      void (async () => {
        try {
          const token = await getStoredSshCredentialToken(action.serverId);
          if (signal?.aborted) return;
          if (token) await handoff(request, token);
          else { setError(null); setCredential(request); setPassword(""); }
        } catch (failure) {
          if (signal?.aborted) return;
          toast.error(String(failure));
          try { await handoff(request, null); }
          catch (handoffError) { if (!signal?.aborted) toast.error(String(handoffError)); }
        }
      })();
      return { status: "presented" };
    }
    return null;
  }, [options.voice.callId, options.voice.getContext, options.rootRef, confirmation, credential, handoff, toast]);

  useEffect(() => { confirmation?.shown(); }, [confirmation]);
  useEffect(() => {
    if (!credential) return;
    const timer = setTimeout(() => {
      setCredential((current) => current?.requestId === credential.requestId ? null : current);
      setPassword("");
      setError(null);
      toast.error("The SSH credential request expired. Request the operation again.");
    }, Math.max(0, credential.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [credential, toast]);

  const respondConfirmation = useCallback(async (approved: boolean): Promise<void> => {
    if (!confirmation || confirming.current) return;
    const pending = confirmation;
    confirming.current = true;
    setConfirmation(null);
    setError(null);
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
      setError(null);
      toast.error("The voice confirmation expired. Request the action again.");
    }, Math.max(0, confirmation.value.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [confirmation, toast]);

  const cancelCredential = useCallback(async (): Promise<void> => {
    if (!credential || submitting) return;
    const pending = credential;
    setCredential(null);
    setPassword("");
    try { await handoff(pending, null); }
    catch (failure) { if (!controller.current?.signal.aborted) toast.error(String(failure)); }
  }, [credential, submitting, handoff, toast]);
  const submitCredential = useCallback(async (): Promise<void> => {
    if (!credential || submitting) return;
    const pending = credential;
    setSubmitting(true);
    setError(null);
    const signal = controller.current?.signal;
    try {
      await storeSshServerPassword(pending.serverId, password);
      if (signal?.aborted) return;
      const token = await getStoredSshCredentialToken(pending.serverId);
      if (signal?.aborted) return;
      await handoff(pending, token);
      setCredential(null);
      setPassword("");
    } catch (failure) { if (!signal?.aborted) setError(String(failure)); }
    finally { if (!signal?.aborted) setSubmitting(false); }
  }, [credential, password, submitting, handoff]);

  return {
    handleAction,
    dialogs: (
      <>
        <ConfirmModal isOpen={confirmation !== null} title="Confirm action"
          message={confirmation?.value.description ?? ""}
          confirmLabel="Approve" cancelLabel="Reject" loading={submitting}
          onConfirm={() => void respondConfirmation(true)} onClose={() => void respondConfirmation(false)}>
          {error ? <ErrorState description={error} /> : null}
        </ConfirmModal>
        <ServerPasswordModal isOpen={credential !== null} serverName={credential?.serverName ?? ""}
          password={password} error={error} submitting={submitting} onPasswordChange={setPassword}
          description={`Supply the credential for ${credential?.serverName ?? "this SSH server"}. It is never sent to the voice model.`}
          onClose={() => void cancelCredential()} onSubmit={submitCredential} />
      </>
    ),
  };
}
