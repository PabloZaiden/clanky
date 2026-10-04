/**
 * Owns session bindings, descendant attribution and the native lifetime stream.
 */

import type { SessionInfo as NativeSession, OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import type { AgentSession, ConfigOption, CreateSessionOptions, PromptInput } from "../types";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import type { HarnessEventScope } from "@/shared/harness-events";
import type { HarnessEventHub } from "../harness-event-hub";
import { HarnessError } from "../harness-errors";
import { requireMatchingHarnessBinding } from "../harness-binding";
import type { OpenCodeModelCatalog } from "./model-catalog";
import { OpenCodeEventTranslator } from "./event-translator";
import { toOpenCodePrompt } from "./prompt";

interface Conversation { info: AgentSession; native: NativeSession }
type ActivitySession = Pick<NativeSession, "id" | "parentID" | "projectID" | "location" | "title" | "agent" | "model" | "time" | "outcome">;
interface TrackedSession { rootId: string; native: ActivitySession; translator: OpenCodeEventTranslator }

export class OpenCodeSessionService {
  private readonly conversations = new Map<string, Conversation>();
  private readonly tracked = new Map<string, TrackedSession>();
  private readonly observationAbort = new AbortController();
  private readonly observing: Promise<void>;
  private readonly ready = Promise.withResolvers<void>();
  private readonly operations = new Set<Promise<AgentSession>>();
  private closing = false;
  private observationFailure?: Error;
  private readonly resumes = new Map<string, { binding: HarnessConversationBinding; promise: Promise<AgentSession> }>();

  constructor(private readonly dependencies: {
    client: OpenCodeClient; directory: string; catalog: OpenCodeModelCatalog; events: HarnessEventHub;
  }) {
    void this.ready.promise.catch((error: unknown) => {
      this.observationFailure = error instanceof Error ? error : new Error(String(error));
    });
    this.observing = this.observe();
  }

  create(options: CreateSessionOptions): Promise<AgentSession> {
    return this.runOperation(async () => {
      if (!options.ownership || options.directory !== this.dependencies.directory) {
        throw new HarnessError("harness_session_not_owned", "Native sessions require matching Clanky ownership.");
      }
      await this.ready.promise;
      const model = options.model ? await this.dependencies.catalog.requireModel(options.model) : undefined;
      const native = await this.dependencies.client.session.create({
        title: options.title, location: { directory: options.directory },
        model: model ? { id: model.id, providerID: model.providerID } : undefined,
        permissions: this.questionPermissions(options.ownership),
      });
      const binding: HarnessConversationBinding = { ...options.ownership, adapter: "opencode2", nativeId: native.id, directory: options.directory };
      try {
        await this.dependencies.client.session.update({ sessionID: native.id, metadata: { "clanky/binding": JSON.stringify(binding) } });
        return await this.attach(native, binding);
      } catch (error) {
        try { await this.dependencies.client.session.remove({ sessionID: native.id }); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Native session creation and rollback failed.");
        }
        throw error;
      }
    });
  }

  resume(binding: HarnessConversationBinding): Promise<AgentSession> {
    const pending = this.resumes.get(binding.nativeId);
    if (pending) {
      requireMatchingHarnessBinding(JSON.stringify(pending.binding), binding);
      return pending.promise;
    }
    const promise = this.runOperation(async () => {
      await this.ready.promise;
      if (binding.adapter !== "opencode2" || binding.directory !== this.dependencies.directory) {
        throw new HarnessError("harness_session_not_owned", "The native binding does not match this execution host.");
      }
      const native = await this.dependencies.client.session.get({ sessionID: binding.nativeId });
      const raw = native.metadata?.["clanky/binding"];
      requireMatchingHarnessBinding(typeof raw === "string" ? raw : undefined, binding);
      if (native.location.directory !== binding.directory || native.parentID) throw new HarnessError("harness_session_not_owned", "The native root does not match this binding.");
      await this.dependencies.client.session.update({
        sessionID: native.id, permissions: this.questionPermissions(binding, native.permissions),
        metadata: { "clanky/binding": JSON.stringify(binding) },
      });
      const existing = this.conversations.get(native.id);
      const info = existing?.info ?? await this.attach(native, binding);
      info.binding = binding;
      if (binding.questionPolicy !== "interactive") {
        // Persisted children retain their own permission snapshots on resume.
        const descendants = await this.reconcileDescendants(native.id);
        for (const descendant of descendants) {
          const child = await this.dependencies.client.session.get({ sessionID: descendant.id });
          if (child.parentID !== descendant.parentID) throw new HarnessError("harness_session_not_owned", "The native child lineage changed during resume.");
          const permissions = this.questionPermissions(binding, child.permissions ?? []);
          if (JSON.stringify(permissions) !== JSON.stringify(child.permissions)) {
            await this.dependencies.client.session.update({ sessionID: child.id, permissions });
          }
        }
      }
      return info;
    }).finally(() => { this.resumes.delete(binding.nativeId); });
    this.resumes.set(binding.nativeId, { binding, promise });
    return promise;
  }
  private questionPermissions(
    binding: Pick<HarnessConversationBinding, "questionPolicy">,
    permissions: NonNullable<NativeSession["permissions"]> = [{ action: "*", resource: "*", effect: "allow" }],
  ) {
    if (binding.questionPolicy === "interactive") return permissions;
    return [...permissions.filter((rule) => rule.action !== "question" || rule.resource !== "*"),
      { action: "question", resource: "*", effect: "deny" as const }];
  }
  get(id: string): Conversation {
    if (this.observationFailure) throw this.observationFailure;
    const session = this.conversations.get(id);
    if (!session) throw new HarnessError("harness_session_not_found", "The owned OpenCode conversation is unavailable.");
    return session;
  }
  getInfo(id: string): AgentSession | null { return this.conversations.get(id)?.info ?? null; }
  getTracked(id: string): TrackedSession | undefined { return this.tracked.get(id); }
  roots(): string[] { return [...this.conversations.keys()]; }
  descendants(rootId: string): ActivitySession[] {
    this.get(rootId);
    return [...this.tracked.values()].filter((entry) => entry.rootId === rootId && entry.native.id !== rootId).map((entry) => entry.native);
  }
  async reconcileDescendants(rootId: string): Promise<ActivitySession[]> {
    this.get(rootId);
    const parents = [rootId];
    const descendants: ActivitySession[] = [];
    for (let index = 0; index < parents.length; index += 1) {
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = await this.dependencies.client.session.list({ parentID: parents[index]!, cursor, limit: 50 });
        for (const child of result.data) {
          if (child.parentID !== parents[index]) throw new HarnessError("harness_session_not_owned", "The native descendant list contains a foreign session.");
          if (parents.length >= 1000) throw new HarnessError("harness_event_gap", "The native descendant graph exceeded its limit.");
          this.track(child, rootId);
          if (!parents.includes(child.id)) {
            parents.push(child.id);
            descendants.push(child);
          }
        }
        if (!result.cursor.next) break;
        cursor = result.cursor.next;
        if (page === 19) throw new HarnessError("harness_event_gap", "The native descendant list exceeded its limit.");
      }
    }
    return descendants;
  }
  async send(id: string, prompt: PromptInput): Promise<void> {
    this.get(id);
    if (prompt.model) await this.setModel(id, prompt.model.modelID, prompt.model.variant, prompt.model.providerID);
    await this.dependencies.client.session.prompt({ sessionID: id, delivery: "queue", ...toOpenCodePrompt(prompt) });
  }
  async setModel(id: string, modelID: string, variant?: string, providerID?: string): Promise<ConfigOption[]> {
    const session = this.get(id);
    if ((await this.dependencies.client.session.active())[id]) throw new HarnessError("harness_invalid_model_option", "Native model changes must wait for the current execution.");
    const model = await this.dependencies.catalog.requireModel(modelID, variant, providerID);
    await this.dependencies.client.session.switchModel({ sessionID: id, model: { id: model.id, providerID: model.providerID, variant: variant || undefined } });
    session.native = await this.dependencies.client.session.get({ sessionID: id });
    await this.updateInfo(session);
    return session.info.configOptions ?? [];
  }
  async finishOperations(): Promise<void> {
    this.closing = true;
    this.ready.reject(new HarnessError("harness_transport_closed", "Native conversations are closing."));
    await Promise.allSettled(this.operations);
  }
  async close(): Promise<void> {
    this.observationAbort.abort();
    await this.observing;
    this.dependencies.events.closeAll();
    this.conversations.clear();
    this.tracked.clear();
  }
  forget(id: string): void {
    this.get(id);
    this.conversations.delete(id);
    for (const [key, entry] of this.tracked) if (entry.rootId === id) this.tracked.delete(key);
    this.dependencies.events.closeSession(id);
  }
  private async attach(native: NativeSession, binding: HarnessConversationBinding): Promise<AgentSession> {
    if (this.observationFailure) throw this.observationFailure;
    const conversation: Conversation = {
      native, info: { id: native.id, binding, title: native.title, createdAt: new Date(native.time.created).toISOString() },
    };
    await this.updateInfo(conversation);
    this.conversations.set(native.id, conversation);
    this.track(native, native.id);
    return conversation.info;
  }
  private async updateInfo(session: Conversation): Promise<void> {
    const models = await this.dependencies.catalog.getModels();
    session.info.model = session.native.model?.id;
    session.info.configOptions = [{
      id: "model", name: "Model", category: "model", type: "select",
      currentValue: session.native.model?.id ?? "", options: models.filter((model) => model.connected).map((model) => ({ value: model.modelID, name: model.modelName })),
    }];
    const variants = models.find((model) => model.modelID === session.native.model?.id)?.variants;
    if (variants?.length) session.info.configOptions.push({
      id: "variant", name: "Variant", category: "thought_level", type: "select",
      currentValue: session.native.model?.variant ?? "", options: variants.map((value) => ({ value, name: value || "Default" })),
    });
  }
  private track(native: ActivitySession, rootId: string): void {
    const previous = this.tracked.get(native.id);
    if (!previous && this.tracked.size >= 1000) throw new HarnessError("harness_event_gap", "The native session graph exceeded its limit.");
    this.tracked.set(native.id, { rootId, native, translator: previous?.translator ?? new OpenCodeEventTranslator() });
  }
  private async observe(): Promise<void> {
    const timeout = setTimeout(() => {
      this.ready.reject(new HarnessError("harness_event_gap", "The native event stream did not become ready."));
      this.observationAbort.abort();
    }, 30_000);
    try {
      for await (const event of this.dependencies.client.event.subscribe({ signal: this.observationAbort.signal })) {
        this.ready.resolve();
        clearTimeout(timeout);
        await this.receive(event);
      }
      if (!this.observationAbort.signal.aborted) throw new HarnessError("harness_event_gap", "The native event stream ended unexpectedly.");
    } catch (error) {
      if (this.observationAbort.signal.aborted) return;
      const failure = new HarnessError("harness_event_gap", "Native session observation failed.", { cause: error });
      this.observationFailure = failure;
      this.ready.reject(failure);
      for (const id of this.conversations.keys()) this.dependencies.events.failSession(id, failure);
    } finally { clearTimeout(timeout); }
  }
  private async receive(event: OpenCodeEvent): Promise<void> {
    if (event.type === "session.created") {
      const parent = event.data.parentID ? this.tracked.get(event.data.parentID) : undefined;
      if (parent) {
        const native: ActivitySession = {
          id: event.data.sessionID, parentID: event.data.parentID, projectID: event.data.projectID,
          location: { directory: event.data.location.directory }, title: event.data.title, agent: event.data.agent, model: event.data.model,
          time: { created: event.created, updated: event.created },
        };
        this.track(native, parent.rootId);
      }
    }
    const sessionID = "durable" in event ? event.durable.aggregateID
      : "sessionID" in event.data ? event.data.sessionID : undefined;
    if (!sessionID) return;
    const tracked = this.tracked.get(sessionID);
    if (!tracked) return;
    const native = { adapter: "opencode2" as const, conversationId: tracked.native.id, activityId: tracked.native.id };
    const scope = tracked.rootId === tracked.native.id ? { kind: "principal" as const, native }
      : { kind: "child" as const, activityId: tracked.native.id, native };
    if ("durable" in event && tracked.translator.sequence !== undefined && event.durable.seq > tracked.translator.sequence + 1) {
      await this.reconcileEvents(tracked, event.durable.seq, scope);
    }
    for (const translated of tracked.translator.translate(event, scope)) this.dependencies.events.publish(tracked.rootId, translated);
  }
  private async reconcileEvents(tracked: TrackedSession, through: number, scope: HarnessEventScope): Promise<void> {
    // The public live stream omits storage-only events that still consume a sequence.
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new HarnessError("harness_event_gap", "Native event reconciliation timed out.")), 30_000);
    const signal = AbortSignal.any([abort.signal, this.observationAbort.signal]);
    try {
      let count = 0;
      for await (const event of this.dependencies.client.session.log({
        sessionID: tracked.native.id, after: tracked.translator.sequence, follow: false,
      }, { signal })) {
        if (event.type === "log.synced") break;
        if (++count > 1000) throw new HarnessError("harness_event_gap", "Native event reconciliation exceeded its limit.");
        for (const translated of tracked.translator.translate(event, scope)) this.dependencies.events.publish(tracked.rootId, translated);
        if (event.durable.seq >= through) break;
      }
      if ((tracked.translator.sequence ?? -1) < through) throw new HarnessError("harness_event_gap", "The native log could not reconcile the live event gap.");
    } finally { clearTimeout(timeout); }
  }
  private runOperation(operation: () => Promise<AgentSession>): Promise<AgentSession> {
    if (this.closing) throw new HarnessError("harness_transport_closed", "Native conversations are closing.");
    if (this.observationFailure) throw this.observationFailure;
    if (this.conversations.size + this.operations.size >= 128) throw new HarnessError("harness_request_failed", "Native conversation capacity reached.");
    const pending = operation().finally(() => { this.operations.delete(pending); });
    this.operations.add(pending);
    return pending;
  }
}
