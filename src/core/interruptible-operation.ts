/**
 * Coordinates abortable multi-phase operations that require an asynchronous
 * interrupt and bounded settlement waiting.
 */

export const INTERRUPTIBLE_OPERATION_SETTLE_TIMEOUT_MS = 5_000;

export type InterruptPhase = "initial" | "late";

export type InterruptiblePhaseRunner = <T>(
  operation: () => Promise<T>,
  phaseName?: string,
) => Promise<T>;

export interface InterruptibleOperationCoordinatorOptions {
  signal?: AbortSignal;
  interrupt: () => Promise<void>;
  settlementTimeoutMs: number;
  createAbortError: () => Error;
  onInterruptError: (error: unknown, phase: InterruptPhase) => void;
  onSettlementTimeout: (phaseName: string | undefined) => void;
}

export interface InterruptibleOperationCoordinator {
  runPhase: InterruptiblePhaseRunner;
  dispose(): Promise<void>;
}

interface ActivePhase {
  promise: Promise<unknown>;
  phaseName?: string;
  started: boolean;
  settled: boolean;
  lateInterruptPromise?: Promise<void>;
}

async function waitForSettlement(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    return result === "settled";
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

class InterruptibleOperationCoordinatorImpl implements InterruptibleOperationCoordinator {
  private readonly options: InterruptibleOperationCoordinatorOptions;
  private readonly abortPromise: Promise<never> | undefined;
  private rejectAbort: ((error: Error) => void) | undefined;
  private abortHandler: (() => void) | undefined;
  private activePhase: ActivePhase | undefined;
  private initialInterruptPromise: Promise<void> | undefined;
  private cancellationPromise: Promise<void> | undefined;
  private abortError: Error | undefined;
  private aborted = false;
  private disposed = false;

  constructor(options: InterruptibleOperationCoordinatorOptions) {
    this.options = options;
    if (!options.signal) {
      this.abortPromise = undefined;
      return;
    }

    this.abortPromise = new Promise<never>((_resolve, reject) => {
      this.rejectAbort = reject;
    });
    void this.abortPromise.catch(() => undefined);
    this.abortHandler = () => {
      this.handleAbort();
    };

    if (options.signal.aborted) {
      this.handleAbort();
    } else {
      options.signal.addEventListener("abort", this.abortHandler, { once: true });
    }
  }

  get runPhase(): InterruptiblePhaseRunner {
    return async <T>(
      operation: () => Promise<T>,
      phaseName?: string,
    ): Promise<T> => {
      if (this.disposed) {
        throw new Error("Interruptible operation coordinator has been disposed");
      }
      this.ensureAbortState();
      if (this.aborted) {
        await this.requestInterrupt();
        throw this.getAbortError();
      }

      let activePhase: ActivePhase | undefined;
      const operationPromise = Promise.resolve().then(() => {
        if (this.isAborted()) {
          throw this.getAbortError();
        }
        if (activePhase) {
          activePhase.started = true;
        }
        return operation();
      });
      if (!this.options.signal || !this.abortPromise) {
        return await operationPromise;
      }

      activePhase = {
        promise: operationPromise,
        phaseName,
        started: false,
        settled: false,
      };
      this.activePhase = activePhase;
      void operationPromise.then(
        () => {
          activePhase.settled = true;
        },
        () => {
          activePhase.settled = true;
        },
      );

      try {
        return await Promise.race([operationPromise, this.abortPromise]);
      } catch (error) {
        if (this.isAborted()) {
          await this.requestInterrupt(activePhase);
          throw this.getAbortError();
        }
        throw error;
      } finally {
        if (this.activePhase === activePhase) {
          this.activePhase = undefined;
        }
      }
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.ensureAbortState();
    if (this.options.signal && this.abortHandler) {
      this.options.signal.removeEventListener("abort", this.abortHandler);
    }
    this.disposed = true;

    if (this.aborted) {
      await this.requestInterrupt(this.activePhase);
    }
  }

  private ensureAbortState(): void {
    if (this.options.signal?.aborted && !this.aborted) {
      this.handleAbort();
    }
  }

  private isAborted(): boolean {
    return this.aborted || this.options.signal?.aborted === true;
  }

  private handleAbort(): void {
    if (this.aborted) {
      return;
    }

    this.aborted = true;
    this.abortError = this.options.createAbortError();
    this.rejectAbort?.(this.abortError);
    void this.requestInterrupt(this.activePhase);
  }

  private getAbortError(): Error {
    return this.abortError ??= this.options.createAbortError();
  }

  private requestInterrupt(activePhase = this.activePhase): Promise<void> {
    if (!this.options.signal) {
      return Promise.resolve();
    }
    if (this.cancellationPromise) {
      return this.cancellationPromise;
    }

    const wasUnsettled = activePhase?.started === true && !activePhase.settled;
    this.cancellationPromise = (async () => {
      await this.invokeInterrupt("initial");
      if (!activePhase || !wasUnsettled) {
        return;
      }

      const lateInterruptPromise = this.scheduleLateInterrupt(activePhase);
      const settled = await waitForSettlement(
        activePhase.promise,
        this.options.settlementTimeoutMs,
      );
      if (!settled) {
        this.options.onSettlementTimeout(activePhase.phaseName);
        return;
      }
      await lateInterruptPromise;
    })();

    return this.cancellationPromise;
  }

  private scheduleLateInterrupt(activePhase: ActivePhase): Promise<void> {
    if (activePhase.lateInterruptPromise) {
      return activePhase.lateInterruptPromise;
    }

    activePhase.lateInterruptPromise = activePhase.promise.then(
      () => this.invokeInterrupt("late"),
      () => this.invokeInterrupt("late"),
    );
    return activePhase.lateInterruptPromise;
  }

  private invokeInterrupt(phase: InterruptPhase): Promise<void> {
    if (phase === "initial" && this.initialInterruptPromise) {
      return this.initialInterruptPromise;
    }

    const interruptPromise = Promise.resolve()
      .then(() => this.options.interrupt())
      .catch((error: unknown) => {
        this.options.onInterruptError(error, phase);
      });
    if (phase === "initial") {
      this.initialInterruptPromise = interruptPromise;
    }
    return interruptPromise;
  }
}

export function createInterruptibleOperationCoordinator(
  options: InterruptibleOperationCoordinatorOptions,
): InterruptibleOperationCoordinator {
  return new InterruptibleOperationCoordinatorImpl(options);
}
