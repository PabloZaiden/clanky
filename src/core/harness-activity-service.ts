/**
 * Owns session-lived activity observation independently of prompt consumers.
 */

import type { Backend } from "../backends/types";
import type { EventStream } from "../utils/event-stream";
import type { HarnessEvent } from "@/shared/harness-events";
import type { HarnessActivitySnapshot, HarnessConversationBinding, HarnessConversationState } from "@/shared/harness-control";
import { requireCurrentUser, runWithCurrentUser } from "../context/user-context";
import { mergeHarnessProjection, type HarnessContext } from "../persistence/harness-state";
import { harnessEventEmitter } from "./event-emitter";
import { HarnessError } from "../backends/harness-errors";
import { createLogger } from "@pablozaiden/webapp/server";
import { KeyedOperationQueue } from "../utils/keyed-operation-queue";

const log = createLogger("harness-activity");

interface Observation {
  context: HarnessContext;
  binding: HarnessConversationBinding;
  backend: Pick<Backend, "harness" | "subscribeToEvents">;
  stream: EventStream<HarnessEvent>;
  stopped: boolean;
  interval?: ReturnType<typeof setInterval>;
  pending?: ReturnType<typeof setTimeout>;
  refresh?: Promise<void>;
  loop: Promise<void>;
  publish(projection: Pick<HarnessConversationState, "activity" | "cleanup">): boolean;
}

export class HarnessActivityService {
  private readonly observations = new Map<string, Observation>();
  private readonly operations = new KeyedOperationQueue();

  observe(context: HarnessContext, binding: HarnessConversationBinding, backend: Observation["backend"]): Promise<void> {
    return this.operations.run(this.key(context), () => this.observeCurrent(context, binding, backend));
  }

  private async observeCurrent(context: HarnessContext, binding: HarnessConversationBinding, backend: Observation["backend"]): Promise<void> {
    if (backend.harness.capabilities.activity === "unavailable") return;
    const user = requireCurrentUser();
    if (binding.ownerId !== user.id || binding.contextId !== context.id || binding.adapter !== backend.harness.capabilities.adapter) {
      throw new HarnessError("harness_session_not_owned", "Activity observation requires the current owned conversation.");
    }
    const key = this.key(context);
    const previous = this.observations.get(key);
    if (previous?.backend === backend && previous.binding.nativeId === binding.nativeId) return;
    await this.closeCurrent(context);
    if (this.observations.size >= 1000) throw new HarnessError("harness_request_failed", "Activity observation capacity reached.");
    const stream = await backend.subscribeToEvents(binding.nativeId);
    const observation: Observation = {
      context, binding, backend, stream, stopped: false, loop: Promise.resolve(),
      publish: (projection) => runWithCurrentUser(user, () => {
        const saved = mergeHarnessProjection(context, binding, projection);
        if (saved) harnessEventEmitter.emit({ type: "harness.changed", context }, { userId: user.id });
        return saved;
      }),
    };
    this.observations.set(key, observation);
    try {
      const saved = runWithCurrentUser(user, () => mergeHarnessProjection(context, binding, { capabilities: backend.harness.capabilities }));
      if (!saved) throw new HarnessError("harness_session_not_owned", "The activity conversation is not persisted.");
      // The owned loop has its own visible failure path and remains alive after prompt completion.
      observation.loop = this.consume(observation).catch((error) => {
        log.error("Unable to persist observation failure", { context, error: String(error) });
      });
      await this.refresh(observation);
      if (!observation.stopped) observation.interval = setInterval(() => this.scheduleRefresh(observation), 5_000);
    } catch (error) {
      await this.closeCurrent(context);
      throw error;
    }
  }

  close(context: HarnessContext): Promise<void> {
    return this.operations.run(this.key(context), () => this.closeCurrent(context));
  }

  private async closeCurrent(context: HarnessContext): Promise<void> {
    const observation = this.observations.get(this.key(context));
    if (!observation) return;
    this.stop(observation);
    await observation.loop;
    if (observation.refresh) {
      try { await observation.refresh; } catch (error) {
        log.warn("Closing a failed activity refresh", { context, error: String(error) });
      }
    }
    if (this.observations.get(this.key(context)) === observation) this.observations.delete(this.key(context));
  }

  async settle(context: HarnessContext, binding: HarnessConversationBinding, backend: Pick<Backend, "harness">) {
    this.assertOwned(context, binding, backend);
    const cleanup = await backend.harness.settleOwnedWork(binding.nativeId);
    this.publishCurrent(context, binding, { cleanup });
    return cleanup;
  }

  async getActivity(context: HarnessContext, binding: HarnessConversationBinding, backend: Pick<Backend, "harness">): Promise<HarnessActivitySnapshot> {
    this.assertOwned(context, binding, backend);
    const activity = await backend.harness.getActivity(binding.nativeId);
    this.publishCurrent(context, binding, { activity });
    return activity;
  }

  async stopActivity(context: HarnessContext, binding: HarnessConversationBinding, backend: Pick<Backend, "harness">, activityId: string) {
    this.assertOwned(context, binding, backend);
    const result = await backend.harness.stopActivity(binding.nativeId, activityId);
    await this.getActivity(context, binding, backend);
    return result;
  }

  private assertOwned(context: HarnessContext, binding: HarnessConversationBinding, backend: Pick<Backend, "harness">): void {
    if (binding.ownerId !== requireCurrentUser().id || binding.contextId !== context.id || binding.adapter !== backend.harness.capabilities.adapter) {
      throw new HarnessError("harness_session_not_owned", "Activity control requires the current owned conversation.");
    }
  }

  private publishCurrent(context: HarnessContext, binding: HarnessConversationBinding, projection: Pick<HarnessConversationState, "activity" | "cleanup">): void {
    if (!mergeHarnessProjection(context, binding, projection)) throw new HarnessError("harness_session_not_owned", "The activity conversation was replaced.");
    harnessEventEmitter.emit({ type: "harness.changed", context }, { userId: binding.ownerId });
  }

  private async consume(observation: Observation): Promise<void> {
    try {
      while (!observation.stopped) {
        const event = await observation.stream.next();
        if (!event) {
          if (!observation.stopped) observation.publish({ activity: { observation: "unavailable", reason: "disconnected" } });
          break;
        }
        if (event.type === "activity.changed" || event.type === "prompt.complete" || event.type === "session.status" || event.type === "tool.start" || event.type === "tool.complete") {
          this.scheduleRefresh(observation);
        }
      }
    } catch (error) {
      log.error("Harness activity observation failed", { context: observation.context, error: String(error) });
      observation.publish({ activity: { observation: "unavailable", reason: "gap" } });
    } finally {
      this.stop(observation);
      if (this.observations.get(this.key(observation.context)) === observation) this.observations.delete(this.key(observation.context));
    }
  }

  private scheduleRefresh(observation: Observation): void {
    if (observation.stopped || observation.pending) return;
    observation.pending = setTimeout(() => {
      observation.pending = undefined;
      void this.refresh(observation).catch((error) => {
        log.error("Harness activity refresh failed", { context: observation.context, error: String(error) });
        observation.publish({ activity: { observation: "unavailable", reason: "gap" } });
        this.stop(observation);
      });
    }, 100);
  }

  private refresh(observation: Observation): Promise<void> {
    if (observation.refresh) return observation.refresh;
    const operation = (async () => {
      const activity = await observation.backend.harness.getActivity(observation.binding.nativeId);
      if (!observation.stopped && !observation.publish({ activity })) this.stop(observation);
    })();
    observation.refresh = operation;
    void operation.finally(() => { if (observation.refresh === operation) observation.refresh = undefined; }).catch((error) => {
      log.debug("Activity refresh rejected", { context: observation.context, error: String(error) });
    });
    return operation;
  }

  private stop(observation: Observation): void {
    observation.stopped = true;
    clearInterval(observation.interval);
    clearTimeout(observation.pending);
    observation.stream.close();
  }

  private key(context: HarnessContext): string { return `${context.kind}:${context.id}`; }
}

export const harnessActivityService = new HarnessActivityService();
