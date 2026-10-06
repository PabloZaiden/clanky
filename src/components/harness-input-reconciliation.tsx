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
import { ApiError } from "../lib/api-error";
import { apiRequest } from "../lib/api-client";

const RECONCILIATION_INTERVAL_MS = 2_000;
const MAX_RETRY_INTERVAL_MS = 30_000;
const MAX_FAILED_ATTEMPTS = 5;
const MIN_REQUEST_INTERVAL_MS = 250;
const MAX_RECONCILIATIONS_PER_REFRESH = 5;

type ReconciliationError = {
  kind: "reconciliation" | "refresh";
  message: string;
  retrying: boolean;
};

export interface HarnessInputReconciliationStatus {
  admission?: HarnessInputAdmission;
  checking: boolean;
  error?: ReconciliationError;
}

interface HarnessInputReconciliationContextValue {
  statuses: ReadonlyMap<string, HarnessInputReconciliationStatus>;
  reset: (inputId: string) => void;
  retry: (inputId: string) => void;
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
  failedAttempts: number;
  unresolvedAttempts: number;
  nextAttemptAt: number;
}

type StatusPublisher = (statuses: ReadonlyMap<string, HarnessInputReconciliationStatus>) => void;

const EMPTY_STATUSES: ReadonlyMap<string, HarnessInputReconciliationStatus> = new Map();
const EMPTY_CONTEXT: HarnessInputReconciliationContextValue = {
  statuses: EMPTY_STATUSES,
  reset: () => {},
  retry: () => {},
};
const HarnessInputReconciliationContext = createContext(EMPTY_CONTEXT);

function getRetryInterval(retryAttempts: number): number {
  return Math.min(
    RECONCILIATION_INTERVAL_MS * 2 ** Math.max(0, retryAttempts - 1),
    MAX_RETRY_INTERVAL_MS,
  );
}

function isTransientReconciliationError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status >= 500 || [408, 425, 429].includes(error.status);
  }
  return error instanceof TypeError;
}

class HarnessInputReconciliationController {
  private inputs = new Map<string, HarnessInputReceipt>();
  private readonly statuses = new Map<string, HarnessInputReconciliationStatus>();
  private readonly active = new Map<string, ActiveReconciliation>();
  private readonly refreshInputs = new Set<string>();
  private onUpdated?: () => Promise<void>;
  private pumpTimer?: ReturnType<typeof setTimeout>;
  private pumpScheduledAt = 0;
  private lastRequestStartedAt = 0;
  private requestsSinceRefresh = 0;
  private processing = false;
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
      entry.controller?.abort();
      this.active.delete(inputId);
      if (!receipt) {
        this.setStatus(inputId, undefined);
      } else {
        const status = this.statuses.get(inputId);
        this.setStatus(inputId, {
          ...status,
          admission: receipt.admission,
          checking: false,
          ...(receipt.admission.status === "delivered" || receipt.admission.status === "rejected"
            ? { error: undefined }
            : {}),
        });
      }
    }

    for (const inputId of this.statuses.keys()) {
      if (!this.inputs.has(inputId)) this.setStatus(inputId, undefined);
    }

    for (const inputId of this.inputs.keys()) {
      if (!this.isUnresolved(inputId) || this.active.has(inputId)) continue;
      const error = this.statuses.get(inputId)?.error;
      if (error?.kind === "reconciliation" && !error.retrying) continue;
      this.start(inputId);
    }

    this.scheduleNextPump();
  }

  reset(inputId: string): void {
    const entry = this.active.get(inputId);
    entry?.controller?.abort();
    this.active.delete(inputId);
    this.setStatus(inputId, undefined);
    this.scheduleNextPump();
  }

  retry(inputId: string): void {
    const status = this.statuses.get(inputId);
    if (
      status?.error?.kind !== "reconciliation"
      || status.error.retrying
      || !this.isUnresolved(inputId)
      || this.disposed
    ) return;

    this.setStatus(inputId, { admission: this.getAdmission(inputId), checking: false });
    this.start(inputId);
  }

  dispose(): void {
    this.disposed = true;
    if (this.pumpTimer !== undefined) clearTimeout(this.pumpTimer);
    for (const entry of this.active.values()) entry.controller?.abort();
    this.active.clear();
    this.refreshInputs.clear();
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
    if (this.disposed) return;
    if (status) this.statuses.set(inputId, status);
    else this.statuses.delete(inputId);
    this.publish(new Map(this.statuses));
  }

  private start(inputId: string): void {
    const entry: ActiveReconciliation = {
      failedAttempts: 0,
      unresolvedAttempts: 0,
      nextAttemptAt: Date.now(),
    };
    this.active.set(inputId, entry);
    this.scheduleNextPump();
  }

  private scheduleNextPump(): void {
    if (this.disposed || this.processing) return;

    let nextAttemptAt = Number.POSITIVE_INFINITY;
    for (const [inputId, entry] of this.active) {
      if (!entry.controller && this.isUnresolved(inputId)) {
        nextAttemptAt = Math.min(nextAttemptAt, entry.nextAttemptAt);
      }
    }

    if (!Number.isFinite(nextAttemptAt)) {
      if (this.refreshInputs.size > 0) this.schedulePump(0);
      return;
    }

    const nextRequestAt = Math.max(
      nextAttemptAt,
      this.lastRequestStartedAt + MIN_REQUEST_INTERVAL_MS,
    );
    this.schedulePump(Math.max(0, nextRequestAt - Date.now()));
  }

  private schedulePump(delayMs: number): void {
    if (this.disposed || this.processing) return;
    const scheduledAt = Date.now() + delayMs;
    if (this.pumpTimer !== undefined && this.pumpScheduledAt <= scheduledAt) return;
    if (this.pumpTimer !== undefined) clearTimeout(this.pumpTimer);
    this.pumpScheduledAt = scheduledAt;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      this.pumpScheduledAt = 0;
      void this.runNext();
    }, delayMs);
  }

  private async runNext(): Promise<void> {
    if (this.disposed || this.processing) return;
    const now = Date.now();
    let next: [string, ActiveReconciliation] | undefined;

    for (const [inputId, entry] of this.active) {
      if (entry.controller || !this.isUnresolved(inputId)) continue;
      if (entry.nextAttemptAt <= now && (!next || entry.nextAttemptAt < next[1].nextAttemptAt)) {
        next = [inputId, entry];
      }
    }

    if (!next) {
      if (this.refreshInputs.size > 0) {
        this.processing = true;
        await this.refreshEntity();
        this.processing = false;
      }
      this.scheduleNextPump();
      return;
    }

    const nextRequestAt = this.lastRequestStartedAt + MIN_REQUEST_INTERVAL_MS;
    if (nextRequestAt > now) {
      this.schedulePump(nextRequestAt - now);
      return;
    }

    this.processing = true;
    this.lastRequestStartedAt = Date.now();
    const attempted = await this.reconcile(next[0], next[1]);
    this.processing = false;
    if (this.disposed) return;
    if (attempted) this.requestsSinceRefresh += 1;

    const hasDueInput = [...this.active].some(([inputId, entry]) =>
      !entry.controller && entry.nextAttemptAt <= Date.now() && this.isUnresolved(inputId));
    if (
      this.refreshInputs.size > 0
      && (this.requestsSinceRefresh >= MAX_RECONCILIATIONS_PER_REFRESH || !hasDueInput)
    ) {
      this.processing = true;
      await this.refreshEntity();
      this.processing = false;
      if (this.disposed) return;
    }

    this.scheduleNextPump();
  }

  private async reconcile(inputId: string, entry: ActiveReconciliation): Promise<boolean> {
    if (this.disposed || this.active.get(inputId) !== entry || !this.isUnresolved(inputId)) return false;
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
      if (controller.signal.aborted || this.disposed) return true;
      if (admission.inputId !== inputId) {
        throw new Error("Input reconciliation returned an unrelated receipt.");
      }

      const previousAdmission = this.getAdmission(inputId);
      const nextAdmission = admission.status === "unknown" && previousAdmission?.status === "accepted"
        ? previousAdmission
        : admission;
      this.setStatus(inputId, { admission: nextAdmission, checking: false });
      if (admission.status !== "unknown") this.refreshInputs.add(inputId);
      entry.failedAttempts = 0;
      entry.unresolvedAttempts = admission.status === "unknown"
        ? Math.min(entry.unresolvedAttempts + 1, MAX_FAILED_ATTEMPTS)
        : 0;
      entry.nextAttemptAt = Date.now() + getRetryInterval(Math.max(entry.failedAttempts, entry.unresolvedAttempts));
    } catch (error) {
      if (controller.signal.aborted || this.disposed) return true;
      const retrying = isTransientReconciliationError(error);
      this.setStatus(inputId, {
        admission: this.getAdmission(inputId),
        checking: false,
        error: { kind: "reconciliation", message: String(error), retrying },
      });
      if (retrying) {
        entry.failedAttempts = Math.min(entry.failedAttempts + 1, MAX_FAILED_ATTEMPTS);
        entry.nextAttemptAt = Date.now() + getRetryInterval(entry.failedAttempts);
      } else {
        this.active.delete(inputId);
      }
    } finally {
      if (this.active.get(inputId) === entry) {
        entry.controller = undefined;
        if (!this.isUnresolved(inputId)) this.active.delete(inputId);
      }
    }
    return true;
  }

  private async refreshEntity(): Promise<void> {
    const inputIds = [...this.refreshInputs];
    this.refreshInputs.clear();
    this.requestsSinceRefresh = 0;
    if (inputIds.length === 0 || !this.onUpdated || this.disposed) return;

    try {
      await this.onUpdated();
      for (const inputId of inputIds) {
        const status = this.statuses.get(inputId);
        if (status?.error?.kind === "refresh") {
          this.setStatus(inputId, { ...status, error: undefined });
        }
      }
    } catch (error) {
      if (this.disposed) return;
      for (const inputId of inputIds) {
        const status = this.statuses.get(inputId);
        if (!status) continue;
        this.setStatus(inputId, {
          ...status,
          error: { kind: "refresh", message: String(error), retrying: false },
        });
      }
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

export function useRetryHarnessInputReconciliation(): (inputId: string) => void {
  return useContext(HarnessInputReconciliationContext).retry;
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
  const retry = useCallback((inputId: string) => {
    controllerRef.current?.retry(inputId);
  }, []);
  const contextValue = useMemo(() => ({ statuses, reset, retry }), [reset, retry, statuses]);

  return (
    <HarnessInputReconciliationContext.Provider value={contextValue}>
      {children}
    </HarnessInputReconciliationContext.Provider>
  );
}
