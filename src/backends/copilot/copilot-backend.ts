/**
 * Provider-neutral facade; collaborators own every mutable runtime resource.
 */

import type {
  Backend, BackendConnectionConfig, CreateSessionOptions, AgentSession,
  PromptInput, AgentResponse, ConfigOption,
} from "../types";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import { HarnessError } from "../harness-errors";
import { CopilotConnection } from "./connection";
import { CopilotControl } from "./control";
import { toCopilotMessage } from "./prompt";

export class CopilotBackend implements Backend {
  readonly name = "copilot";
  private readonly connection = new CopilotConnection();
  readonly harness = new CopilotControl(this.connection);

  connect(config: BackendConnectionConfig, signal?: AbortSignal): Promise<void> {
    return this.connection.connect(config, signal);
  }
  disconnect(): Promise<void> { return this.connection.disconnect(); }
  isConnected(): boolean { return this.connection.isConnected(); }
  createSession(options: CreateSessionOptions): Promise<AgentSession> {
    return this.connection.requireServices().sessions.create(options);
  }
  resumeSession(binding: HarnessConversationBinding): Promise<AgentSession> {
    return this.connection.requireServices().sessions.resume(binding);
  }
  async sendPromptAsync(sessionId: string, prompt: PromptInput): Promise<void> {
    const { sessions } = this.connection.requireServices();
    if (prompt.model) await sessions.setModel(sessionId, prompt.model.modelID, prompt.model.variant);
    await sessions.get(sessionId).native.send(toCopilotMessage(prompt));
  }
  async sendPrompt(sessionId: string, prompt: PromptInput): Promise<AgentResponse> {
    const { sessions } = this.connection.requireServices();
    if (prompt.model) await sessions.setModel(sessionId, prompt.model.modelID, prompt.model.variant);
    const response = await sessions.get(sessionId).native.sendAndWait(toCopilotMessage(prompt), 120_000);
    if (!response) throw new HarnessError("harness_request_failed", "The native prompt produced no principal response.");
    return { id: response.data.messageId, content: response.data.content, parts: [{ type: "text", text: response.data.content }] };
  }
  abortSession(sessionId: string): Promise<void> {
    return this.connection.requireServices().sessions.abort(sessionId);
  }
  async subscribeToEvents(sessionId: string) {
    this.connection.requireServices().sessions.get(sessionId);
    return this.connection.events.subscribe(sessionId);
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
    await this.connection.requireServices().sessions.delete(id);
  }
  async getModels(_directory: string) { return this.connection.requireServices().catalog.getModels(); }
  async getModelVariants(_directory: string, modelID: string): Promise<string[]> {
    const { model } = await this.connection.requireServices().catalog.requireModel(modelID);
    return model.supportedReasoningEfforts ? ["", ...model.supportedReasoningEfforts] : [];
  }

}
