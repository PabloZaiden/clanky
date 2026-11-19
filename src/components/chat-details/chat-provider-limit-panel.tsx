import { useRef, useState } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import type { Chat } from "@/shared/chat";
import { providerLimitLabel } from "@/shared/provider-limit";
import { apiRequest } from "../../lib/api-client";
import { useWorkspaceReadOnly } from "../../context/workspace-access-context";
import { Button } from "../common";

export function ChatProviderLimitPanel({ chat, onChatSnapshot }: {
  chat: Chat;
  onChatSnapshot: (chat: Chat) => void;
}) {
  const toast = useToast();
  const readOnly = useWorkspaceReadOnly();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const limit = chat.state.harness?.providerLimit;
  const blocked = chat.state.status === "blocked";
  if (!limit || !blocked && limit.continuation?.status !== "paused") return null;
  const continuation = limit.continuation;
  const scheduled = continuation?.status === "scheduled";
  const attempting = continuation?.status === "attempting";
  const formatTime = (time: string) => new Date(time).toLocaleString();

  async function recover(action: "continue" | "schedule" | "cancel"): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const next = await apiRequest<Chat>(`/api/chats/${chat.config.id}/provider-recovery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
        action: "Recover provider-blocked chat",
        fallbackMessage: "Failed to update provider continuation",
      });
      onChatSnapshot(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div role="status" className="mx-4 mt-3 min-w-0 shrink-0 rounded-md bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-200">
      <p className="font-medium">{blocked ? `${providerLimitLabel(limit)} - execution stopped` : "Automatic continuation paused"}</p>
      {chat.state.error && <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words">{chat.state.error.message}</p>}
      {blocked && limit.retryAt && <p className="mt-2">Provider retry time: {formatTime(limit.retryAt)}</p>}
      {scheduled && continuation.nextAttemptAt && (
        <p className="mt-2">Next attempt: {formatTime(continuation.nextAttemptAt)}. Attempt {continuation.attempts + 1} of 12.</p>
      )}
      {attempting && <p className="mt-2">Checking the conversation before continuing...</p>}
      {continuation?.status === "paused" && continuation.reason && (
        <p className="mt-2 break-words">Automatic continuation paused: {continuation.reason}</p>
      )}
      {blocked && <fieldset disabled={readOnly || pending || attempting} className="mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => void recover("continue")}>
          Continue now
        </Button>
        {limit.kind !== "billing" && (
          <label className="inline-flex min-w-0 cursor-pointer items-center gap-2">
            <input type="checkbox" checked={scheduled} onChange={(event) => void recover(event.target.checked ? "schedule" : "cancel")} />
            Continue automatically when available
          </label>
        )}
      </fieldset>}
    </div>
  );
}
