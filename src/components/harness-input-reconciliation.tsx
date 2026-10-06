import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  HarnessInputAdmission,
  HarnessInputReceipt,
} from "@/shared/harness-control";
import { apiRequest } from "../lib/api-client";

const RECONCILIATION_INTERVAL_MS = 2_000;
const MAX_RETRY_INTERVAL_MS = 30_000;
const MAX_FAILED_ATTEMPTS = 5;

export interface HarnessInputReconciliationStatus {
  admission?: HarnessInputAdmission;
  checking: boolean;
  error?: string;
}

interface HarnessInputReconciliationContextValue {
  statuses: ReadonlyMap<string, HarnessInputReconciliationStatus>;
  reset: (inputId: string) => void;
}

interface HarnessInputReconciliationProviderProps {
  kind: "chat" | "task";
  entityId: string;
  inputs?: readonly HarnessInputReceipt[];
  onUpdated?: () => Promise<void>;
  children: ReactNode;
}

interface ActiveReconciliation {
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  failedAttempts: number;
  unresolvedAttempts: number;
}

type StatusPublisher = (statuses: ReadonlyMap<string, HarnessInputReconciliationStatus>) => void;

const EMPTY_STATUSES: ReadonlyMap<string, HarnessInputReconciliationStatus> = new Map();
const EMPTY_CONTEXT: HarnessInputReconciliationContextValue = {
  statuses: EMPTY_STATUSES,
  reset: () => {},
};
const HarnessInputReconciliationContext = createContext(EMPTY_CONTEXT);

function getRetryInterval(retryAttempts: number): number {
  return Math.min(
    RECONCILIATION_INTERVAL_MS * 2 ** Math.max(0, retryAttempts - 1),
    MAX_RETRY_INTERVAL_MS,
  );
}

function cancelReconciliation(entry: ActiveReconciliation): void {
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  entry.controller?.abort();
}

class HarnessInputReconciliationController {
  private inputs = new Map<string, HarnessInputReceipt>();
  private readonly statuses = new Map<string, HarnessInputReconciliationStatus>();
  private readonly active = new Map<string, ActiveReconciliation>();
  private onUpdated?: () => Promise<void>;
  private disposed = false;

  constructor(
    private readonly kind: "chat" | "task",
    private readonly entityId: string,
    private readonly publish: StatusPublisher,
  ) {}

  update(inputs: readonly HarnessInputReceipt[], onUpdated?: () => Promise<void>): void {
    if (this.disposed) return;
    this.inputs = new Map(inputs.map((receipt) => [receipt.admission.inputId, receipt]));
    this.onUpdated = onUpdated;

    for (const [inputId, entry] of this.active) {
      const receipt = this.inputs.get(inputId);
      if (receipt && this.isUnresolved(inputId)) continue;
      cancelReconciliation(entry);
      this.active.delete(inputId);
      if (!receipt) {
        this.setStatus(inputId, undefined);
      } else {
        const status = this.statuses.get(inputId);
        if (status) {
          this.setStatus(inputId, {
            ...status,
            admission: this.getAdmission(inputId) ?? status.admission,
            checking: false,
            ...(receipt.admission.status === "delivered" || receipt.admission.status === "rejected"
              ? { error: undefined }
              : {}),
          });
        }
      }
    }

    for (const inputId of this.statuses.keys()) {
      if (!this.inputs.has(inputId)) this.setStatus(inputId, undefined);
    }

    for (const inputId of this.inputs.keys()) {
      if (this.isUnresolved(inputId) && !this.active.has(inputId)) this.start(inputId);
    }
  }

  reset(inputId: string): void {
    const entry = this.active.get(inputId);
    if (entry) {
      cancelReconciliation(entry);
      this.active.delete(inputId);
    }
    this.setStatus(inputId, undefined);
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.active.values()) cancelReconciliation(entry);
    this.active.clear();
  }

  private getAdmission(inputId: string): HarnessInputAdmission | undefined {
    const receipt = this.inputs.get(inputId);
    if (!receipt) return undefined;
    if (receipt.admission.status === "delivered" || receipt.admission.status === "rejected") {
      return receipt.admission;
    }
    return this.statuses.get(inputId)?.admission ?? receipt.admission;
  }

  private isUnresolved(inputId: string): boolean {
    const status = this.getAdmission(inputId)?.status;
    return status === "accepted" || status === "unknown";
  }

  private setStatus(
    inputId: string,
    status: HarnessInputReconciliationStatus | undefined,
  ): void {
    if (status) this.statuses.set(inputId, status);
    else this.statuses.delete(inputId);
    this.publish(new Map(this.statuses));
  }

  private start(inputId: string): void {
    const entry: ActiveReconciliation = { failedAttempts: 0, unresolvedAttempts: 0 };
    this.active.set(inputId, entry);
    this.schedule(inputId, entry, 0);
  }

  private schedule(
    inputId: string,
    entry: ActiveReconciliation,
    delayMs: number,
  ): void {
    if (this.disposed || this.active.get(inputId) !== entry || entry.timer !== undefined || entry.controller) return;
    if (!this.isUnresolved(inputId)) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.disposed || this.active.get(inputId) !== entry || !this.isUnresolved(inputId)) return;
      void this.reconcile(inputId, entry);
    }, delayMs);
  }

  private async reconcile(inputId: string, entry: ActiveReconciliation): Promise<void> {
    if (this.disposed || this.active.get(inputId) !== entry || !this.isUnresolved(inputId)) return;
    const controller = new AbortController();
    entry.controller = controller;
    const currentStatus = this.statuses.get(inputId);
    this.setStatus(inputId, {
      admission: this.getAdmission(inputId),
      checking: true,
      error: currentStatus?.error,
    });
    const collection = this.kind === "chat" ? "queued-messages" : "pending-inputs";
    const path = `/api/${this.kind}s/${encodeURIComponent(this.entityId)}/${collection}/${encodeURIComponent(inputId)}/reconcile`;

    try {
      const { admission } = await apiRequest<{ admission: HarnessInputAdmission }>(path, {
        method: "POST",
        signal: controller.signal,
        action: "Check native input delivery",
      });
      if (controller.signal.aborted) return;
      if (admission.inputId !== inputId) {
        throw new Error("Input reconciliation returned an unrelated receipt.");
      }

      const previousAdmission = this.getAdmission(inputId);
      const nextAdmission = admission.status === "unknown" && previousAdmission?.status === "accepted"
        ? previousAdmission
        : admission;
      this.setStatus(inputId, { admission: nextAdmission, checking: true });
      await this.onUpdated?.();
      if (controller.signal.aborted) return;
      entry.failedAttempts = 0;
      entry.unresolvedAttempts = admission.status === "unknown"
        ? Math.min(entry.unresolvedAttempts + 1, MAX_FAILED_ATTEMPTS)
        : 0;
      this.setStatus(inputId, { admission: nextAdmission, checking: false });
    } catch (error) {
      if (controller.signal.aborted) return;
      entry.failedAttempts = Math.min(entry.failedAttempts + 1, MAX_FAILED_ATTEMPTS);
      this.setStatus(inputId, {
        admission: this.getAdmission(inputId),
        checking: false,
        error: String(error),
      });
    } finally {
      this.finishReconciliation(inputId, entry, controller);
    }
  }

  private finishReconciliation(
    inputId: string,
    entry: ActiveReconciliation,
    controller: AbortController,
  ): void {
    if (this.active.get(inputId) !== entry) return;
    entry.controller = undefined;
    if (controller.signal.aborted) return;
    if (this.isUnresolved(inputId)) {
      this.schedule(
        inputId,
        entry,
        getRetryInterval(Math.max(entry.failedAttempts, entry.unresolvedAttempts)),
      );
      return;
    }

    this.active.delete(inputId);
    const status = this.statuses.get(inputId);
    if (status) {
      this.setStatus(inputId, {
        ...status,
        admission: this.getAdmission(inputId) ?? status.admission,
        checking: false,
      });
    }
  }
}

export function useHarnessInputReconciliation(
  inputId: string,
): HarnessInputReconciliationStatus | undefined {
  return useContext(HarnessInputReconciliationContext).statuses.get(inputId);
}

export function useResetHarnessInputReconciliation(): (inputId: string) => void {
  return useContext(HarnessInputReconciliationContext).reset;
}

export function HarnessInputReconciliationProvider({
  kind,
  entityId,
  inputs,
  onUpdated,
  children,
}: HarnessInputReconciliationProviderProps) {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, HarnessInputReconciliationStatus>>(
    () => new Map(),
  );
  const controllerRef = useRef<HarnessInputReconciliationController | null>(null);
  const inputsRef = useRef(inputs);
  const onUpdatedRef = useRef(onUpdated);
  inputsRef.current = inputs;
  onUpdatedRef.current = onUpdated;

  useEffect(() => {
    setStatuses(new Map());
    const controller = new HarnessInputReconciliationController(kind, entityId, setStatuses);
    controllerRef.current = controller;
    controller.update(inputsRef.current ?? [], onUpdatedRef.current);
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [entityId, kind]);

  useEffect(() => {
    controllerRef.current?.update(inputs ?? [], onUpdated);
  }, [inputs, onUpdated]);

  const reset = useCallback((inputId: string) => {
    controllerRef.current?.reset(inputId);
  }, []);
  const contextValue = useMemo(() => ({ statuses, reset }), [reset, statuses]);

  return (
    <HarnessInputReconciliationContext.Provider value={contextValue}>
      {children}
    </HarnessInputReconciliationContext.Provider>
  );
}
