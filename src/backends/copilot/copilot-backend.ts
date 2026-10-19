/**
 * Provider-neutral facade; collaborators own every mutable runtime resource.
 */

import type {
  Backend, BackendConnectionConfig, CreateSessionOptions, AgentSession,
  PromptInput, AgentResponse, ConfigOption,
} from "../types";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import { HarnessError } from "../harness-errors";
import { consumeHarnessPrompt } from "../harness-prompt";
import { CopilotConnection } from "./connection";
import { CopilotControl } from "./control";
import { readCopilotSessionHistory } from "./session-history";
import { NativeHistoryReader } from "../native-history-reader";

export class CopilotBackend implements Backend {
  readonly name = "copilot";
  private readonly connection = new CopilotConnection();
  private readonly history = new NativeHistoryReader();
  readonly harness = new CopilotControl(this.connection);

  async connect(config: BackendConnectionConfig, signal?: AbortSignal): Promise<void> {
    await this.history.close();
    await this.connection.connect(config, signal);
    this.history.open();
  }
  async disconnect(): Promise<void> {
    try { await this.history.close(); } finally { await this.connection.disconnect(); }
  }
  isConnected(): boolean { return this.connection.isConnected(); }
  createSession(options: CreateSessionOptions): Promise<AgentSession> {
    return this.connection.requireServices().sessions.create(options);
  }
  resumeSession(binding: HarnessConversationBinding): Promise<AgentSession> {
    return this.connection.requireServices().sessions.resume(binding);
  }
  async sendPromptAsync(sessionId: string, prompt: PromptInput): Promise<void> {
    await this.connection.requireServices().sessions.send(sessionId, prompt);
  }
  async sendPrompt(sessionId: string, prompt: PromptInput): Promise<AgentResponse> {
    const response = await consumeHarnessPrompt(this, sessionId, prompt);
    if (!response.id) throw new HarnessError("harness_request_failed", "The native prompt produced no principal response.");
    return response;
  }
  abortSession(sessionId: string): Promise<void> {
    return this.connection.requireServices().sessions.abort(sessionId);
  }
  async subscribeToEvents(sessionId: string) {
    this.connection.requireServices().sessions.get(sessionId);
    return this.connection.events.subscribe(sessionId);
  }
  async readSessionHistory(sessionId: string, cursor?: string) {
    const session = this.connection.requireServices().sessions.get(sessionId).native;
    return await this.history.read({
      sessionId, cursor,
      source: () => readCopilotSessionHistory(session),
      processing: async () => (await session.rpc.metadata.isProcessing()).processing,
    });
  }
  async replyToPermission(_requestId: string, _response: string): Promise<void> {
    throw new HarnessError("harness_unsupported_feature", "Native permissions are automatically approved.");
  }
  async replyToQuestion(requestId: string, answers: string[][]): Promise<void> {
    this.connection.requireServices().questions.reply(requestId, answers);
  }
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
    const { sessions } = this.connection.requireServices();
    if (configId === "model") return sessions.setModel(sessionId, value);
    if (configId === "reasoning_effort") {
      const info = sessions.get(sessionId).info;
      if (!info.model) throw new HarnessError("harness_invalid_model_option", "The native model is not resolved.");
      return sessions.setModel(sessionId, info.model, value);
    }
    throw new HarnessError("harness_invalid_model_option", "The native option is unsupported.");
  }
  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    await this.connection.requireServices().sessions.setModel(sessionId, modelId);
  }
  abortAllSubscriptions(): void { this.connection.events.closeAll(); }
  getSdkClient(): unknown { return this.connection.requireServices().runtime.client; }
  getDirectory(): string { return this.connection.getDirectory(); }
  getConnectionInfo(): null { return null; }
  async getSession(id: string): Promise<AgentSession | null> {
    return this.connection.requireServices().sessions.getInfo(id);
  }
  async deleteSession(id: string): Promise<void> {
    const cleanup = await this.harness.settleOwnedWork(id);
    if (cleanup.status !== "settled") throw new HarnessError("harness_request_failed", "Owned native work has not settled.");
    await this.history.forget(id);
    await this.connection.requireServices().sessions.delete(id);
  }
  async getModels(_directory: string) { return this.connection.requireServices().catalog.getModels(); }
  async getModelVariants(_directory: string, modelID: string): Promise<string[]> {
    const { model } = await this.connection.requireServices().catalog.requireModel(modelID);
    return model.supportedReasoningEfforts ? ["", ...model.supportedReasoningEfforts] : [];
  }

}
