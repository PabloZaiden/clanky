/**
 * Session-owned consumption checkpoints, independent of browsers and activity polling.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type { HarnessControl, HarnessConversationBinding } from "@/shared/harness-control";
import type { HarnessContext } from "../persistence/harness-state";
import { markHarnessUsageStale, saveHarnessUsage, type UsageChange } from "../persistence/harness-usage";
import { requireCurrentUser, runWithCurrentUser } from "../context/user-context";
import { harnessEventEmitter } from "./event-emitter";

const log = createLogger("harness-usage");
const USAGE_CHECKPOINT_INTERVAL_MS = 5_000;

export class HarnessUsageObserver {
  private readonly owner = requireCurrentUser();
  private interval?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private dirty = false;
  private closed = false;

  constructor(private readonly options: {
    context: HarnessContext;
    binding: HarnessConversationBinding;
    control: HarnessControl;
  }) {}

  async start(): Promise<void> {
    if (this.options.control.capabilities.usage !== "tokens" || !this.options.control.getUsage) return;
    await this.refresh();
    if (!this.closed) {
      this.interval = setInterval(() => { void this.refresh(); }, USAGE_CHECKPOINT_INTERVAL_MS);
    }
  }

  refresh(): Promise<void> {
    if (this.closed || this.options.control.capabilities.usage !== "tokens" || !this.options.control.getUsage) {
      return Promise.resolve();
    }
    this.dirty = true;
    if (this.pending) return this.pending;
    const pending = this.drain().finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  stop(): void {
    clearInterval(this.interval);
  }

  async close(): Promise<void> {
    this.stop();
    await this.refresh();
    this.closed = true;
  }

  markStale(): void {
    const { context, binding } = this.options;
    try {
      this.publish(runWithCurrentUser(this.owner, () => markHarnessUsageStale(context, binding)));
    } catch (error) {
      log.error("Unable to mark token accounting stale", { context, error: String(error) });
    }
  }

  private async drain(): Promise<void> {
    while (this.dirty && !this.closed) {
      this.dirty = false;
      const { context, binding, control } = this.options;
      try {
        const snapshot = await control.getUsage!(binding.nativeId);
        const change = runWithCurrentUser(this.owner, () => saveHarnessUsage(context, binding, snapshot));
        if (!change) {
          this.closed = true;
          this.stop();
          return;
        }
        this.publish(change);
      } catch (error) {
        log.warn("Native token usage could not be refreshed", { context, adapter: binding.adapter, error: String(error) });
        this.markStale();
      }
    }
  }

  private publish(change: UsageChange | undefined): void {
    if (!change) return;
    for (const context of change.contexts) {
      harnessEventEmitter.emit({
        type: "harness.changed", context,
        ...(context.kind === "chat" ? { runs: change.runs } : {}),
      }, { userId: this.owner.id });
    }
  }
}
