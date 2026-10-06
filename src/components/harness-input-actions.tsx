import { useRef, useState } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import type { HarnessInputAdmission, HarnessInputReceipt } from "@/shared/harness-control";
import { apiRequest } from "../lib/api-client";
import {
  useHarnessInputReconciliation,
  useResetHarnessInputReconciliation,
} from "./harness-input-reconciliation";

export function HarnessInputActions({
  kind,
  entityId,
  inputId,
  canSteer,
  receipt,
  onUpdated,
}: {
  kind: "chat" | "task";
  entityId: string;
  inputId: string;
  canSteer: boolean;
  receipt?: HarnessInputReceipt;
  onUpdated: () => Promise<void>;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const reconciliation = useHarnessInputReconciliation(inputId);
  const resetReconciliation = useResetHarnessInputReconciliation();
  const admission = reconciliation?.admission ?? receipt?.admission;
  const recovering = admission?.status === "unknown" || admission?.status === "accepted";
  const delivered = admission?.status === "delivered";
  const automaticallyRejected = reconciliation?.admission?.status === "rejected";
  if ((delivered && !reconciliation?.error)
    || (!recovering && !canSteer && !automaticallyRejected && !reconciliation?.error)) return null;

  async function submit(): Promise<void> {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    const collection = kind === "chat" ? "queued-messages" : "pending-inputs";
    try {
      const { admission } = await apiRequest<{ admission: HarnessInputAdmission }>(
        `/api/${kind}s/${encodeURIComponent(entityId)}/${collection}/${encodeURIComponent(inputId)}/steer`,
        { method: "POST", action: "Steer queued input" },
      );
      resetReconciliation(inputId);
      await onUpdated();
      if (admission.status === "rejected") toast.warning("Steering was not admitted. The message remains queued.");
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
        <span className="text-amber-700 dark:text-amber-300">
          {delivered
            ? `Delivery confirmed; entity refresh failed: ${reconciliation.error}`
            : automaticallyRejected
              ? `Steering was not admitted; entity refresh failed: ${reconciliation.error}`
              : `Delivery check failed; retrying automatically: ${reconciliation.error}`}
        </span>
      )}
      {recovering && !reconciliation?.error && (
        <span className="text-amber-700 dark:text-amber-300">
          {reconciliation?.checking ? "Checking delivery…" : "Delivery unconfirmed; checking automatically."}
        </span>
      )}
      {automaticallyRejected && !reconciliation?.error && (
        <span className="text-amber-700 dark:text-amber-300">Steering was not admitted.</span>
      )}
      {!recovering && !delivered && canSteer && (
        <button
          type="button"
          disabled={pending}
          onClick={() => void submit()}
          className="font-medium text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-900 disabled:opacity-50 dark:text-gray-400 dark:hover:text-gray-100"
        >
          {pending ? "Steering..." : "Steer"}
        </button>
      )}
    </div>
  );
}
