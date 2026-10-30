/**
 * Native runtime 2 facade; ACP remains a separate integration.
 */

import type {
  Backend, BackendConnectionConfig, CreateSessionOptions, AgentSession, AgentResponse,
  ConfigOption, PromptInput,
} from "../types";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import { HarnessError } from "../harness-errors";
import { consumeHarnessPrompt } from "../harness-prompt";
import { OpenCodeConnection } from "./connection";
import { OpenCodeControl } from "./control";
import { readOpenCodeSessionHistory, readOpenCodeSubagentHistory } from "./session-history";
import { NativeHistoryReader } from "../native-history-reader";
import type { HarnessEvent } from "@/shared/harness-events";

export class OpenCodeBackend implements Backend {
  readonly name = "opencode2";
  private readonly connection = new OpenCodeConnection();
  private readonly history = new NativeHistoryReader();
  private readonly childHistory = new NativeHistoryReader<HarnessEvent>();
  readonly harness = new OpenCodeControl(this.connection.requireServices.bind(this.connection));

  async connect(config: BackendConnectionConfig, signal?: AbortSignal): Promise<void> {
    await this.history.close();
    await this.childHistory.close();
    await this.connection.connect(config, signal);
    this.history.open();
    this.childHistory.open();
  }
  async disconnect(): Promise<void> {
    try { await Promise.all([this.history.close(), this.childHistory.close()]); } finally { await this.connection.disconnect(); }
  }
  isConnected(): boolean { return this.connection.isConnected(); }
  createSession(options: CreateSessionOptions): Promise<AgentSession> { return this.connection.requireServices().sessions.create(options); }
  resumeSession(binding: HarnessConversationBinding): Promise<AgentSession> { return this.connection.requireServices().sessions.resume(binding); }
  sendPromptAsync(id: string, prompt: PromptInput): Promise<void> { return this.connection.requireServices().sessions.send(id, prompt); }
  sendPrompt(id: string, prompt: PromptInput): Promise<AgentResponse> { return consumeHarnessPrompt(this, id, prompt); }
  abortSession(id: string): Promise<void> { return this.harness.abort(id); }
  async subscribeToEvents(id: string) {
    this.connection.requireServices().sessions.get(id);
    return this.connection.events.subscribe(id);
  }
  async readSessionHistory(id: string, cursor?: string) {
    const { sessions, client } = this.connection.requireServices();
    sessions.get(id);
    return await this.history.read({
      sessionId: id, cursor,
      source: () => readOpenCodeSessionHistory(client, id),
      processing: async () => (await client.session.active())[id] !== undefined,
    });
  }
  async readSubagentHistory(id: string, activityId: string, cursor?: string) {
    const { sessions, client } = this.connection.requireServices();
    sessions.get(id);
    await sessions.reconcileDescendants(id);
    if (sessions.getTracked(activityId)?.rootId !== id || activityId === id) {
      throw new HarnessError("harness_activity_not_owned", "The native session is not a child of this conversation.");
    }
    const page = await this.childHistory.read({
      sessionId: JSON.stringify([id, activityId]), cursor,
      source: () => readOpenCodeSubagentHistory(client, activityId),
      processing: async () => (await client.session.active())[activityId] !== undefined,
    });
    return { events: page.events, processing: page.principalProcessing, nextCursor: page.nextCursor };
  }
  async replyToPermission(_requestId: string, _response: string): Promise<void> { throw new HarnessError("harness_unsupported_feature", "Native permissions are automatically approved."); }
  replyToQuestion(requestId: string, answers: string[][]): Promise<void> { return this.connection.requireServices().questions.reply(requestId, answers); }
  replyToSecret(requestId: string, value: string | null): Promise<void> { return this.connection.requireServices().secrets.reply(requestId, value); }
  async setConfigOption(id: string, configId: string, value: string): Promise<ConfigOption[]> {
    const { sessions } = this.connection.requireServices();
    if (configId === "model") return sessions.setModel(id, value);
    if (configId === "variant") {
      const model = sessions.get(id).info.model;
      if (!model) throw new HarnessError("harness_invalid_model_option", "The native model is not resolved.");
      return sessions.setModel(id, model, value);
    }
    throw new HarnessError("harness_invalid_model_option", "The native option is unsupported.");
  }
  async setSessionModel(id: string, modelId: string): Promise<void> { await this.connection.requireServices().sessions.setModel(id, modelId); }
  abortAllSubscriptions(): void { this.connection.events.closeAll(); }
  getSdkClient(): unknown { return this.connection.requireServices().client; }
  getDirectory(): string { return this.connection.getDirectory(); }
  getConnectionInfo(): null { return null; }
  async getSession(id: string): Promise<AgentSession | null> { return this.connection.requireServices().sessions.getInfo(id); }
  async deleteSession(id: string): Promise<void> {
    const services = this.connection.requireServices();
    services.sessions.get(id);
    const cleanup = await this.harness.settleOwnedWork(id);
    if (cleanup.status !== "settled") throw new HarnessError("harness_request_failed", "Owned native work has not settled.");
    await this.history.forget(id);
    await services.client.session.remove({ sessionID: id });
    services.sessions.forget(id);
  }
  async getModels(_directory: string) { return this.connection.requireServices().catalog.getModels(); }
  async getModelVariants(_directory: string, modelID: string): Promise<string[]> {
    const model = await this.connection.requireServices().catalog.requireModel(modelID);
    return ["", ...model.variants.map((variant) => variant.id)];
  }

}
