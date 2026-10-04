import { useRef, useState } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import type { HarnessInputAdmission, HarnessInputReceipt } from "@/shared/harness-control";
import { apiRequest } from "../lib/api-client";

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
  const recovering = receipt?.admission.status === "unknown" || receipt?.admission.status === "accepted";
  const delivered = receipt?.admission.status === "delivered";
  if (delivered || (!recovering && !canSteer)) return null;

  async function submit(): Promise<void> {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    const collection = kind === "chat" ? "queued-messages" : "pending-inputs";
    try {
      const { admission } = await apiRequest<{ admission: HarnessInputAdmission }>(
        `/api/${kind}s/${encodeURIComponent(entityId)}/${collection}/${encodeURIComponent(inputId)}/${recovering ? "reconcile" : "steer"}`,
        { method: "POST", action: recovering ? "Check native input delivery" : "Steer queued input" },
      );
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
      {recovering && <span className="text-amber-700 dark:text-amber-300">Delivery unconfirmed</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() => void submit()}
        className="font-medium text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-900 disabled:opacity-50 dark:text-gray-400 dark:hover:text-gray-100"
      >
        {pending ? recovering ? "Checking..." : "Steering..." : recovering ? "Check delivery" : "Steer"}
      </button>
    </div>
  );
}
