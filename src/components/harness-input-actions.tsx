import { useRef, useState } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import type { Chat } from "@/shared";
import type { HarnessInputAdmission, HarnessInputReceipt } from "@/shared/harness-control";
import { apiRequest } from "../lib/api-client";
import {
  getEffectiveHarnessInputAdmission,
  useHarnessInputReconciliation,
  useRetryHarnessInputReconciliation,
  useResetHarnessInputReconciliation,
} from "./harness-input-reconciliation";

export function HarnessInputActions({
  kind,
  entityId,
  inputId,
  canSteer,
  receipt,
  onUpdated,
  onChatSnapshot,
}: {
  kind: "chat" | "task";
  entityId: string;
  inputId: string;
  canSteer: boolean;
  receipt?: HarnessInputReceipt;
  onUpdated: () => Promise<void>;
  onChatSnapshot?: (chat: Chat) => void;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const reconciliation = useHarnessInputReconciliation(inputId);
  const resetReconciliation = useResetHarnessInputReconciliation();
  const retryReconciliation = useRetryHarnessInputReconciliation();
  const admission = getEffectiveHarnessInputAdmission(reconciliation?.admission, receipt?.admission);
  const recovering = admission?.status === "unknown" || admission?.status === "accepted";
  const delivered = admission?.status === "delivered";
  const rejected = admission?.status === "rejected";
  const permanentReconciliationError = reconciliation?.error?.kind === "reconciliation"
    && !reconciliation.error.retrying;
  if ((delivered && !reconciliation?.error)
    || (!recovering && !canSteer && !rejected && !reconciliation?.error)) return null;

  async function submit(): Promise<void> {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    const collection = kind === "chat" ? "queued-messages" : "pending-inputs";
    try {
      const response = await apiRequest<{ admission: HarnessInputAdmission; chat?: Chat }>(
        `/api/${kind}s/${encodeURIComponent(entityId)}/${collection}/${encodeURIComponent(inputId)}/steer`,
        { method: "POST", action: "Steer queued input" },
      );
      resetReconciliation(inputId);
      if (kind === "chat" && onChatSnapshot) {
        if (!response.chat) throw new Error("Chat steering response did not include an updated chat.");
        onChatSnapshot(response.chat);
      }
      await onUpdated();
    } catch (inputError) {
      toast.error(String(inputError));
      await onUpdated();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      {reconciliation?.error && (
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="text-amber-700 dark:text-amber-300"
        >
          {reconciliation.error.kind === "refresh"
            ? delivered
              ? `Delivery confirmed; entity refresh failed: ${reconciliation.error.message}`
              : `Entity refresh failed; delivery reconciliation continues: ${reconciliation.error.message}`
            : reconciliation.error.retrying
              ? `Delivery check failed; retrying automatically: ${reconciliation.error.message}`
              : `Delivery check failed; automatic retries stopped: ${reconciliation.error.message}`}
        </span>
      )}
      {recovering && (
        <span role="status" aria-live="polite" aria-atomic="true" className="text-amber-700 dark:text-amber-300">
          Admitting
        </span>
      )}
      {delivered && (
        <span role="status" aria-live="polite" aria-atomic="true" className="text-amber-700 dark:text-amber-300">
          Steered
        </span>
      )}
      {rejected && !reconciliation?.error && (
        <span role="status" aria-live="polite" aria-atomic="true" className="text-amber-700 dark:text-amber-300">
          Steering was not admitted.
        </span>
      )}
      {permanentReconciliationError && (
        <button
          type="button"
          onClick={() => retryReconciliation(inputId)}
          className="font-medium text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
        >
          Retry check
        </button>
      )}
      {!recovering && !delivered && canSteer && (
        <button
          type="button"
          disabled={pending}
          onClick={() => void submit()}
          className="font-medium text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-900 disabled:opacity-50 dark:text-gray-400 dark:hover:text-gray-100"
        >
          {pending ? "Admitting" : "Steer"}
        </button>
      )}
    </div>
  );
}
