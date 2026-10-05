/**
 * Owns Clanky-created SDK conversations, native bindings and lifetime listeners.
 */

import { approveAll, type CopilotSession } from "@github/copilot-sdk";
import type { AgentSession, CreateSessionOptions, ConfigOption } from "../types";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import type { HarnessEventHub } from "../harness-event-hub";
import { HarnessError } from "../harness-errors";
import { requireMatchingHarnessBinding } from "../harness-binding";
import { CopilotEventTranslator } from "./event-translator";
import type { CopilotRuntime } from "./runtime";
import type { CopilotModelCatalog } from "./model-catalog";
import type { CopilotQuestionCoordinator } from "./question-coordinator";
import { settleCopilotWork } from "./work-service";

interface Conversation {
  native: CopilotSession;
  info: AgentSession;
  translator: CopilotEventTranslator;
  unsubscribe: () => void;
}

interface SessionServiceDependencies {
  runtime: CopilotRuntime;
  catalog: CopilotModelCatalog;
  events: HarnessEventHub;
  questions: CopilotQuestionCoordinator;
}

export class CopilotSessionService {
  private readonly conversations = new Map<string, Conversation>();
  private readonly resuming = new Map<string, Promise<AgentSession>>();
  private readonly operations = new Set<Promise<AgentSession>>();
  private closing = false;
  private readonly runtime: CopilotRuntime;
  private readonly catalog: CopilotModelCatalog;
  private readonly events: HarnessEventHub;
  private readonly questions: CopilotQuestionCoordinator;

  constructor(dependencies: SessionServiceDependencies) {
    this.runtime = dependencies.runtime;
    this.catalog = dependencies.catalog;
    this.events = dependencies.events;
    this.questions = dependencies.questions;
  }

  create(options: CreateSessionOptions): Promise<AgentSession> {
    return this.runOperation(() => this.createNative(options));
  }

  private async createNative(options: CreateSessionOptions): Promise<AgentSession> {
    if (!options.ownership) throw new HarnessError("harness_session_not_owned", "Native conversations require Clanky ownership.");
    if (options.directory !== this.runtime.directory) throw new HarnessError("harness_session_not_owned", "Native conversations must use their selected execution host directory.");
    const choice = options.model ? await this.catalog.requireModel(options.model) : undefined;
    const session = await this.runtime.client.createSession({
      workingDirectory: options.directory,
      model: choice?.model.id,
      reasoningEffort: choice?.reasoningEffort,
      streaming: true,
      onPermissionRequest: approveAll,
      excludedTools: options.ownership.questionPolicy === "interactive" ? [] : ["ask_user"],
      askUserVariant: "legacy",
      onUserInputRequest: this.questions.handler(options.ownership.questionPolicy),
    });
    const binding: HarnessConversationBinding = {
      ...options.ownership,
      adapter: "copilot",
      nativeId: session.sessionId,
      directory: options.directory,
    };
    try {
      await session.rpc.metadata.updateClientMetadata({ set: { "clanky/binding": JSON.stringify(binding) } });
      return await this.attach(session, binding, options.title);
    } catch (error) {
      await this.rollback(session, error);
      throw error;
    }
  }

  resume(binding: HarnessConversationBinding): Promise<AgentSession> {
    if (binding.adapter !== "copilot" || binding.directory !== this.runtime.directory) {
      throw new HarnessError("harness_session_not_owned", "The native conversation binding does not match this runtime.");
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
    const resumed = this.runOperation(() => this.resumeNative(binding)).finally(() => { this.resuming.delete(binding.nativeId); });
    this.resuming.set(binding.nativeId, resumed);
    return resumed;
  }

  private async resumeNative(binding: HarnessConversationBinding): Promise<AgentSession> {
    const session = await this.runtime.client.resumeSession(binding.nativeId, {
      workingDirectory: binding.directory,
      streaming: true,
      continuePendingWork: false,
      onPermissionRequest: approveAll,
      excludedTools: binding.questionPolicy === "interactive" ? [] : ["ask_user"],
      askUserVariant: "legacy",
      onUserInputRequest: this.questions.handler(binding.questionPolicy),
    });
    try {
      const metadata = await session.rpc.metadata.getClientMetadata();
      requireMatchingHarnessBinding(metadata["clanky/binding"], binding);
      await session.rpc.metadata.updateClientMetadata({ set: { "clanky/binding": JSON.stringify(binding) } });
      return await this.attach(session, binding);
    } catch (error) {
      await this.rollback(session, error);
      throw error;
    }
  }

  get(sessionId: string): Conversation {
    const conversation = this.conversations.get(sessionId);
    if (!conversation) throw new HarnessError("harness_session_not_found", "The Clanky-owned native conversation is unavailable.");
    return conversation;
  }

  getInfo(sessionId: string): AgentSession | null {
    return this.conversations.get(sessionId)?.info ?? null;
  }

  async abort(sessionId: string): Promise<void> {
    const conversation = this.get(sessionId);
    conversation.translator.interrupted = true;
    this.questions.close(sessionId, "cancelled");
    await conversation.native.abort();
  }

  async setModel(sessionId: string, modelID: string, variant?: string): Promise<ConfigOption[]> {
    const conversation = this.get(sessionId);
    if ((await conversation.native.rpc.metadata.isProcessing()).processing) {
      throw new HarnessError("harness_invalid_model_option", "Native model changes must wait for the active execution.");
    }
    const choice = await this.catalog.requireModel(modelID, variant);
    await conversation.native.setModel(choice.model.id, { reasoningEffort: choice.reasoningEffort });
    await this.refreshInfo(conversation);
    return conversation.info.configOptions ?? [];
  }

  async delete(sessionId: string): Promise<void> {
    this.get(sessionId);
    await this.closeSession(sessionId);
    await this.runtime.client.deleteSession(sessionId);
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.operations);
    const errors: unknown[] = [];
    for (const id of [...this.conversations.keys()]) {
      try {
        await this.closeSession(id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Native conversation cleanup failed.");
  }

  private async attach(session: CopilotSession, binding: HarnessConversationBinding, title?: string): Promise<AgentSession> {
    if (this.conversations.size >= 128) throw new HarnessError("harness_request_failed", "Native conversation capacity reached.");
    const translator = new CopilotEventTranslator(session.sessionId);
    const conversation: Conversation = {
      native: session,
      info: { id: session.sessionId, createdAt: new Date().toISOString(), title, binding },
      translator,
      unsubscribe: session.on((event) => {
        try {
          for (const translated of translator.translate(event)) this.events.publish(session.sessionId, translated);
        } catch (error) {
          this.events.failSession(session.sessionId, new HarnessError(
            "harness_event_gap", "Native event observation failed.", { cause: error },
          ));
        }
      }),
    };
    this.conversations.set(session.sessionId, conversation);
    await this.refreshInfo(conversation);
    return conversation.info;
  }

  private async refreshInfo(conversation: Conversation): Promise<void> {
    const current = await conversation.native.rpc.model.getCurrent();
    const models = await this.catalog.getModels();
    const model = models.find((entry) => entry.modelID === current.modelId);
    conversation.info.model = current.modelId;
    conversation.info.configOptions = [{
      id: "model", name: "Model", category: "model", type: "select",
      currentValue: current.modelId ?? "",
      options: models.filter((entry) => entry.connected).map((entry) => ({ value: entry.modelID, name: entry.modelName })),
    }];
    if (model?.variants?.length) {
      conversation.info.configOptions.push({
        id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select",
        currentValue: current.reasoningEffort ?? "",
        options: model.variants.map((value) => ({ value, name: value || "Default" })),
      });
    }
  }

  private async closeSession(sessionId: string): Promise<void> {
    const conversation = this.get(sessionId);
    this.questions.close(sessionId, "expired");
    const errors: unknown[] = [];
    try {
      const cleanup = await settleCopilotWork(conversation.native);
      if (cleanup.status !== "settled") throw new HarnessError("harness_request_failed", "Native conversation cleanup did not settle.");
    } catch (error) {
      errors.push(error);
    }
    this.conversations.delete(sessionId);
    conversation.unsubscribe();
    this.events.closeSession(sessionId);
    try { await conversation.native.disconnect(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Native conversation teardown failed.");
  }

  private async rollback(session: CopilotSession, original: unknown): Promise<void> {
    const conversation = this.conversations.get(session.sessionId);
    this.conversations.delete(session.sessionId);
    conversation?.unsubscribe();
    this.questions.close(session.sessionId, "expired");
    this.events.closeSession(session.sessionId);
    try {
      await session.disconnect();
    } catch (error) {
      throw new AggregateError([original, error], "Native session creation and rollback failed.");
    }
  }

  private runOperation(operation: () => Promise<AgentSession>): Promise<AgentSession> {
    if (this.closing) throw new HarnessError("harness_transport_closed", "Native conversations are closing.");
    if (this.conversations.size + this.operations.size >= 128) throw new HarnessError("harness_request_failed", "Native conversation capacity reached.");
    const pending = operation().finally(() => { this.operations.delete(pending); });
    this.operations.add(pending);
    return pending;
  }
}
