/**
 * Owns created roots, descendant lineage, turn identity and native listeners.
 */

import type { AgentSession, ConfigOption, CreateSessionOptions, PromptInput } from "../types";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import type { HarnessEventScope } from "@/shared/harness-events";
import type { Thread } from "./generated/v2/Thread";
import type { ReasoningEffort } from "./generated/ReasoningEffort";
import type { DynamicToolSpec } from "./generated/v2/DynamicToolSpec";
import type { CodexNotification } from "./protocol";
import type { CodexRuntime } from "./runtime";
import type { CodexModelCatalog } from "./model-catalog";
import type { HarnessEventHub } from "../harness-event-hub";
import type { ClankyControlContext } from "@/shared/clanky-control";
import { HarnessError } from "../harness-errors";
import { requireMatchingHarnessBinding } from "../harness-binding";
import { CodexEventTranslator } from "./event-translator";
import { toCodexInput } from "./prompt";
import { codexQuestionConfig } from "./question-policy";
import { ClankyControlToolService } from "../clanky-control-tools";
import type { ClankyControlToolResult } from "../clanky-control-tools";
import { z } from "zod";
import type { HarnessUsageSnapshot, TokenCounts } from "@/shared/harness-usage";

const DynamicToolCallParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
  namespace: z.string().nullable(),
  tool: z.string().min(1),
  arguments: z.unknown(),
}).strict();

function dynamicToolResponse(result: ClankyControlToolResult) {
  return {
    contentItems: [{ type: "inputText" as const, text: JSON.stringify(result) }],
    success: !(typeof result === "object" && result !== null && "ok" in result && result.ok === false),
  };
}

interface Conversation {
  info: AgentSession;
  model?: string;
  effort?: ReasoningEffort;
  activeControlTurn?: { context?: ClankyControlContext; abort: AbortController };
  admitting?: boolean;
}

interface TrackedThread {
  rootId: string;
  thread: Thread;
  turnId?: string;
  completedTurnId?: string;
  spawningToolCallId?: string;
  translator: CodexEventTranslator;
  usage?: TokenCounts;
}

export class CodexSessionService {
  private readonly conversations = new Map<string, Conversation>();
  private readonly threads = new Map<string, TrackedThread>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeFailure: () => void;
  private readonly operations = new Set<Promise<AgentSession>>();
  private readonly resuming = new Map<string, Promise<AgentSession>>();
  private readonly resumingUsage = new Map<string, TokenCounts>();
  private closing = false;
  private controlTools?: ClankyControlToolService;

  constructor(private readonly dependencies: {
    runtime: CodexRuntime;
    catalog: CodexModelCatalog;
    events: HarnessEventHub;
    managedEnvironment?: Record<string, string | undefined>;
  }) {
    this.unsubscribe = dependencies.runtime.rpc.onNotification((event) => {
      try { this.receive(event); } catch (error) {
        const failure = new HarnessError("harness_event_gap", "Codex event observation failed.", { cause: error });
        for (const [id, conversation] of this.conversations) {
          this.endControlTurn(conversation);
          dependencies.events.failSession(id, failure);
        }
      }
    });
    this.unsubscribeFailure = dependencies.runtime.onFailure((error) => {
      for (const [id, conversation] of this.conversations) {
        this.endControlTurn(conversation);
        dependencies.events.failSession(id, error);
      }
    });
  }

  create(options: CreateSessionOptions): Promise<AgentSession> {
    return this.runOperation(() => this.createNative(options));
  }

  private async createNative(options: CreateSessionOptions): Promise<AgentSession> {
    if (!options.ownership || options.directory !== this.dependencies.runtime.directory) {
      throw new HarnessError("harness_session_not_owned", "Native threads require a matching Clanky ownership binding.");
    }
    if (this.conversations.size >= 128) throw new HarnessError("harness_request_failed", "Native thread capacity reached.");
    if (options.model) await this.dependencies.catalog.requireModel(options.model);
    const dynamicTools = options.ownership.controlTools ? await this.nativeControlTools(options.ownership.controlChatId) : undefined;
    const result = await this.dependencies.runtime.rpc.request("thread/start", {
      cwd: options.directory, model: options.model, ephemeral: false,
      approvalPolicy: "never", sandbox: "danger-full-access", allowProviderModelFallback: false,
      config: await codexQuestionConfig(this.dependencies.runtime, options.ownership.questionPolicy),
      ...(dynamicTools ? { dynamicTools } : {}),
    });
    const binding: HarnessConversationBinding = {
      ...options.ownership, adapter: "codex", nativeId: result.thread.id, directory: options.directory,
    };
    try {
      return await this.attach(result.thread, binding, options.title);
    } catch (error) {
      try { await this.dependencies.runtime.rpc.request("thread/delete", { threadId: result.thread.id }); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Native root creation and rollback failed.");
      }
      throw error;
    }
  }

  resume(binding: HarnessConversationBinding): Promise<AgentSession> {
    if (binding.adapter !== "codex" || binding.directory !== this.dependencies.runtime.directory) {
      throw new HarnessError("harness_session_not_owned", "The native thread binding does not match this execution host.");
    }
    const existing = this.conversations.get(binding.nativeId);
    if (existing) {
      requireMatchingHarnessBinding(JSON.stringify(existing.info.binding), binding);
      return Promise.resolve(existing.info);
    }
    const pending = this.resuming.get(binding.nativeId);
    if (pending) return pending.then((session) => {
      requireMatchingHarnessBinding(JSON.stringify(session.binding), binding);
      return session;
    });
    const resumed = this.runOperation(() => this.resumeNative(binding)).finally(() => {
      this.resuming.delete(binding.nativeId);
      this.resumingUsage.delete(binding.nativeId);
    });
    this.resuming.set(binding.nativeId, resumed);
    return resumed;
  }

  private async resumeNative(binding: HarnessConversationBinding): Promise<AgentSession> {
    if (binding.controlTools) await this.nativeControlTools(binding.controlChatId);
    // Core supplies only its persisted owned binding; no native directory/session import.
    const result = await this.dependencies.runtime.rpc.request("thread/resume", {
      threadId: binding.nativeId, excludeTurns: true, cwd: binding.directory,
      approvalPolicy: "never", sandbox: "danger-full-access",
      config: await codexQuestionConfig(this.dependencies.runtime, binding.questionPolicy),
    });
    if (result.thread.cwd !== binding.directory || result.thread.parentThreadId !== null) {
      throw new HarnessError("harness_session_not_owned", "The native root thread does not match its persisted binding.");
    }

    return this.attach(result.thread, binding);
  }

  get(id: string): Conversation {
    const session = this.conversations.get(id);
    if (!session) throw new HarnessError("harness_session_not_found", "The owned Codex conversation is unavailable.");
    return session;
  }
  getInfo(id: string): AgentSession | null { return this.conversations.get(id)?.info ?? null; }
  getThread(id: string): TrackedThread | undefined { return this.threads.get(id); }
  roots(): string[] { return [...this.conversations.keys()]; }
  async finishOperations(): Promise<void> {
    this.closing = true;
    this.controlTools?.close();
    await Promise.allSettled(this.operations);
  }
  descendants(rootId: string): TrackedThread[] {
    this.get(rootId);
    return [...this.threads.values()].filter((entry) => entry.rootId === rootId && entry.thread.id !== rootId);
  }

  getUsage(rootId: string): HarnessUsageSnapshot {
    this.get(rootId);
    const threads = [...this.threads.values()].filter((entry) => entry.rootId === rootId);
    return {
      observedAt: new Date().toISOString(),
      coverage: threads.every((entry) => entry.usage !== undefined) ? "complete" : "partial",
      contributors: threads.map((entry) => ({ id: entry.thread.id, tokens: entry.usage ?? {} })),
    };
  }

  getScope(threadId: string): HarnessEventScope | null {
    const entry = this.threads.get(threadId);
    if (!entry) return null;
    const native = { adapter: "codex" as const, conversationId: threadId, turnId: entry.turnId };
    return entry.rootId === threadId ? { kind: "principal", native }
      : { kind: "child", activityId: threadId, native: { ...native, activityId: threadId } };
  }

  async reconcileDescendants(rootId: string): Promise<void> {
    this.get(rootId);
    let cursor: string | null | undefined;
    const discovered: Thread[] = [];
    for (let page = 0; page < 20; page += 1) {
      const result = await this.dependencies.runtime.rpc.request("thread/list", {
        ancestorThreadId: rootId, cursor, limit: 50,
        sourceKinds: ["subAgent", "subAgentThreadSpawn", "subAgentOther", "subAgentReview", "subAgentCompact"],
      });
      discovered.push(...result.data);
      if (!result.nextCursor) {
        const remaining = new Map(discovered.map((thread) => [thread.id, thread]));
        while (remaining.size > 0) {
          const connected = [...remaining.values()].filter((thread) => thread.parentThreadId && this.threads.get(thread.parentThreadId)?.rootId === rootId);
          if (!connected.length) throw new HarnessError("harness_event_gap", "The native descendant lineage is incomplete.");
          for (const thread of connected) { this.trackThread(thread, rootId); remaining.delete(thread.id); }
        }
        return;
      }
      cursor = result.nextCursor;
    }
    throw new HarnessError("harness_event_gap", "The native activity graph exceeded its pagination limit.");
  }

  async send(id: string, prompt: PromptInput): Promise<void> {
    await this.admit(id, async (conversation) => {
      await this.requireIdle(id);
      const choice = prompt.model ? await this.dependencies.catalog.requireModel(prompt.model.modelID, prompt.model.variant) : undefined;
      const input = toCodexInput(prompt);
      await this.requireIdle(id);
      this.beginControlTurn(conversation, prompt.controlContext);
      try {
        const result = await this.dependencies.runtime.rpc.request("turn/start", {
          threadId: id, input,
          model: choice?.model.model ?? conversation.model,
          effort: choice ? choice.effort : conversation.effort,
          approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
        });
        const tracked = this.threads.get(id)!;
        if (result.turn.status === "inProgress" && tracked.completedTurnId !== result.turn.id) tracked.turnId = result.turn.id;
      } catch (error) {
        this.endControlTurn(conversation);
        throw error;
      }
    });
  }

  prepareSteering(id: string, clientId: string | undefined): void {
    const conversation = this.get(id);
    const active = conversation.activeControlTurn;
    const context = active?.context;
    // A native turn cannot distinguish which steered input caused a UI tool.
    // Keep domain tools active but remove UI routing after mixed provenance.
    if (active && context?.clientId && context.clientId !== clientId) {
      active.context = { ...context, clientId: undefined };
    }
  }

  async handleToolCall(request: { method: string; params: unknown; signal: AbortSignal }): Promise<unknown> {
    if (request.method !== "item/tool/call") {
      throw new HarnessError("harness_unsupported_feature", "The native callback is unsupported.");
    }
    const params = DynamicToolCallParamsSchema.parse(request.params);
    const tracked = this.threads.get(params.threadId);
    const conversation = tracked?.rootId === params.threadId
      ? this.conversations.get(params.threadId)
      : undefined;
    const active = conversation?.activeControlTurn;
    if (
      !tracked
      || !conversation?.info.binding?.controlTools
      || !active
      || tracked.turnId !== params.turnId
      || params.namespace !== null
    ) {
      return dynamicToolResponse({
        ok: false,
        error: {
          code: "control_context_unavailable",
          message: "This Clanky tool call is not correlated with an active owned turn.",
        },
      });
    }
    return dynamicToolResponse(await this.getControlToolService().invoke(
      params.tool,
      params.arguments,
      active.context,
      AbortSignal.any([request.signal, active.abort.signal]),
    ));
  }

  async setModel(id: string, modelID: string, variant?: string): Promise<ConfigOption[]> {
    return await this.admit(id, async (conversation) => {
      const choice = await this.dependencies.catalog.requireModel(modelID, variant);
      if (conversation.model === choice.model.model && (variant === undefined || conversation.effort === choice.effort)) {
        return conversation.info.configOptions ?? [];
      }
      await this.requireIdle(id);
      conversation.model = choice.model.model;
      conversation.effort = choice.effort;
      await this.updateInfo(conversation);
      return conversation.info.configOptions ?? [];
    });
  }

  private async requireIdle(id: string): Promise<void> {
    const current = await this.dependencies.runtime.rpc.request("thread/read", { threadId: id, includeTurns: false });
    if (current.thread.status.type === "active") {
      throw new HarnessError("harness_session_busy", "The native conversation is already processing.");
    }
    if (current.thread.status.type !== "idle") {
      throw new HarnessError("harness_request_failed", "The native conversation is not ready for input.");
    }
  }

  private async admit<T>(id: string, operation: (conversation: Conversation) => Promise<T>): Promise<T> {
    const conversation = this.get(id);
    if (conversation.admitting) throw new HarnessError("harness_session_busy", "A native input or model change is already being admitted.");
    conversation.admitting = true;
    try { return await operation(conversation); } finally { conversation.admitting = false; }
  }

  forget(id: string): void {
    this.endControlTurn(this.get(id));
    for (const [threadId, entry] of this.threads) if (entry.rootId === id) this.threads.delete(threadId);
    this.conversations.delete(id);
    this.dependencies.events.closeSession(id);
  }
  close(): void {
    this.controlTools?.close();
    for (const conversation of this.conversations.values()) this.endControlTurn(conversation);
    this.unsubscribe();
    this.unsubscribeFailure();
    this.dependencies.events.closeAll();
    this.conversations.clear();
    this.threads.clear();
    this.resumingUsage.clear();
  }

  private async attach(thread: Thread, binding: HarnessConversationBinding, title?: string): Promise<AgentSession> {
    const conversation: Conversation = {
      info: { id: thread.id, binding, title, createdAt: new Date(thread.createdAt * 1000).toISOString() },
      model: thread.model ?? undefined, effort: thread.reasoningEffort ?? undefined,
    };
    await this.updateInfo(conversation);
    this.conversations.set(thread.id, conversation);
    this.trackThread(thread, thread.id);
    return conversation.info;
  }

  private async updateInfo(conversation: Conversation): Promise<void> {
    const models = await this.dependencies.catalog.getModels();
    conversation.info.model = conversation.model;
    const model = models.find((entry) => entry.modelID === conversation.model);
    conversation.info.configOptions = [{
      id: "model", name: "Model", category: "model", type: "select",
      currentValue: conversation.model ?? "",
      options: models.map((entry) => ({ value: entry.modelID, name: entry.modelName })),
    }];
    if (model?.variants?.length) conversation.info.configOptions.push({
      id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select",
      currentValue: conversation.effort ?? "",
      options: model.variants.map((value) => ({ value, name: value || "Default" })),
    });
  }

  private trackThread(thread: Thread, rootId: string): void {
    const previous = this.threads.get(thread.id);
    if (!previous && this.threads.size >= 1000) throw new HarnessError("harness_event_gap", "The native thread graph limit was exceeded.");
    const includeProviderImageFileReference =
      this.conversations.get(rootId)?.info.binding?.executionHost?.host.kind === "mesh";
    this.threads.set(thread.id, previous ? { ...previous, thread } : {
      thread,
      rootId,
      translator: new CodexEventTranslator({ includeProviderImageFileReference }),
      usage: this.resumingUsage.get(thread.id),
    });
  }

  private receive(event: CodexNotification): void {
    if (event.method === "thread/started") {
      const thread = event.params.thread;
      const parent = thread.parentThreadId ? this.threads.get(thread.parentThreadId) : undefined;
      if (parent) this.trackThread(thread, parent.rootId);
      return;
    }
    if (!("threadId" in event.params)) return;
    const entry = this.threads.get(event.params.threadId);
    if (event.method === "thread/tokenUsage/updated") {
      const usage = event.params.tokenUsage.total;
      const tokens: TokenCounts = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningOutputTokens,
        cacheReadTokens: usage.cachedInputTokens,
        cacheWriteTokens: usage.cacheWriteInputTokens,
      };
      if (entry) entry.usage = tokens;
      // Resume can emit its usage checkpoint before the owned thread is attached.
      else if (this.resuming.has(event.params.threadId)) {
        if (!this.resumingUsage.has(event.params.threadId) && this.resumingUsage.size >= 1000) {
          throw new HarnessError("harness_event_gap", "The native usage checkpoint limit was exceeded.");
        }
        this.resumingUsage.set(event.params.threadId, tokens);
      }
      return;
    }
    if (!entry) return;
    if ((event.method === "item/started" || event.method === "item/completed") && event.params.item.type === "collabAgentToolCall") {
      for (const childId of event.params.item.receiverThreadIds) {
        const child = this.threads.get(childId);
        if (child && child.rootId === entry.rootId) child.spawningToolCallId = event.params.item.id;
      }

    }
    if (event.method === "turn/started") entry.turnId = event.params.turn.id;
    if (event.method === "thread/status/changed") entry.thread.status = event.params.status;
    const scope = this.getScope(entry.thread.id)!;
    for (const translated of entry.translator.translate(event, scope)) {
      if (translated.scope.kind === "principal" && translated.type === "error") {
        const conversation = this.conversations.get(entry.rootId);
        if (conversation) this.endControlTurn(conversation);
      }
      this.dependencies.events.publish(entry.rootId, translated);
    }
    if (event.method === "turn/completed") {
      entry.completedTurnId = event.params.turn.id;
      if (entry.rootId === entry.thread.id) {
        const conversation = this.conversations.get(entry.rootId);
        if (conversation?.activeControlTurn && entry.turnId === event.params.turn.id) {
          this.endControlTurn(conversation);
        }
      }
      if (entry.turnId === event.params.turn.id) entry.turnId = undefined;
    }
  }

  private beginControlTurn(conversation: Conversation, context: ClankyControlContext | undefined): void {
    const binding = conversation.info.binding;
    if (binding?.controlTools !== true) {
      if (context) throw new HarnessError("harness_session_not_owned", "Clanky control context is not enabled for this conversation.");
      return;
    }
    if (context && (context.chatId !== binding.controlChatId || !context.workspaceId || !context.turnId)) {
      throw new HarnessError("harness_session_not_owned", "The active Clanky control turn does not match its native conversation.");
    }
    if (conversation.activeControlTurn) {
      throw new HarnessError("harness_request_failed", "A Clanky control turn is already active in this conversation.");
    }
    conversation.activeControlTurn = { context, abort: new AbortController() };
  }

  private endControlTurn(conversation: Conversation): void {
    conversation.activeControlTurn?.abort.abort();
    conversation.activeControlTurn = undefined;
  }

  cancelControlTurn(id: string): void {
    this.endControlTurn(this.get(id));
  }

  private async nativeControlTools(chatId?: string): Promise<DynamicToolSpec[]> {
    return (await this.getControlToolService().listTools({ chatId })).map((definition) => ({
      type: "function",
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    }));
  }

  private getControlToolService(): ClankyControlToolService {
    if (!this.controlTools) {
      try {
        this.controlTools = new ClankyControlToolService(this.dependencies.managedEnvironment ?? {});
      } catch (error) {
        throw new HarnessError("harness_runtime_unavailable", "Managed Clanky API credentials are unavailable for control tools.", { cause: error });
      }
    }
    return this.controlTools;
  }

  private runOperation(operation: () => Promise<AgentSession>): Promise<AgentSession> {
    if (this.closing) throw new HarnessError("harness_transport_closed", "Native conversations are closing.");
    if (this.conversations.size + this.operations.size >= 128) throw new HarnessError("harness_request_failed", "Native conversation capacity reached.");
    const pending = operation().finally(() => { this.operations.delete(pending); });
    this.operations.add(pending);
    return pending;
  }
}
