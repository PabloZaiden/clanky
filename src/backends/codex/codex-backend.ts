/**
 * Stable facade over the native app-server collaborators.
 */

import type {
  Backend, BackendConnectionConfig, CreateSessionOptions, AgentSession, AgentResponse,
  ConfigOption, PromptInput,
} from "../types";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import { HarnessError } from "../harness-errors";
import { CodexConnection } from "./connection";
import { CodexControl } from "./control";
import { consumeHarnessPrompt } from "../harness-prompt";

export class CodexBackend implements Backend {
  readonly name = "codex";
  private readonly connection = new CodexConnection();
  readonly harness = new CodexControl(this.connection.requireServices.bind(this.connection));

  connect(config: BackendConnectionConfig, signal?: AbortSignal): Promise<void> { return this.connection.connect(config, signal); }
  disconnect(): Promise<void> { return this.connection.disconnect(); }
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
  async replyToPermission(_requestId: string, _response: string): Promise<void> {
    throw new HarnessError("harness_unsupported_feature", "Native permissions are automatically approved.");
  }
  async replyToQuestion(requestId: string, answers: string[][]): Promise<void> { this.connection.requireServices().questions.reply(requestId, answers); }
  async setConfigOption(id: string, configId: string, value: string): Promise<ConfigOption[]> {
    const { sessions } = this.connection.requireServices();
    if (configId === "model") return sessions.setModel(id, value);
    if (configId === "reasoning_effort") {
      const model = sessions.get(id).info.model;
      if (!model) throw new HarnessError("harness_invalid_model_option", "The native model is not resolved.");
      return sessions.setModel(id, model, value);
    }
    throw new HarnessError("harness_invalid_model_option", "The native option is unsupported.");
  }
  async setSessionModel(id: string, modelId: string): Promise<void> { await this.connection.requireServices().sessions.setModel(id, modelId); }
  abortAllSubscriptions(): void { this.connection.events.closeAll(); }
  getSdkClient(): unknown { return this.connection.requireServices().runtime.rpc; }
  getDirectory(): string { return this.connection.getDirectory(); }
  getConnectionInfo(): null { return null; }
  async getSession(id: string): Promise<AgentSession | null> { return this.connection.requireServices().sessions.getInfo(id); }
  async deleteSession(id: string): Promise<void> {
    const services = this.connection.requireServices();
    services.sessions.get(id);
    const cleanup = await this.harness.settleOwnedWork(id);
    if (cleanup.status !== "settled") throw new HarnessError("harness_request_failed", "Owned native work has not settled.");
    await services.runtime.rpc.request("thread/delete", { threadId: id });
    services.sessions.forget(id);
  }
  async getModels(_directory: string) { return this.connection.requireServices().catalog.getModels(); }
  async getModelVariants(_directory: string, modelID: string): Promise<string[]> {
    const { model } = await this.connection.requireServices().catalog.requireModel(modelID);
    return ["", ...model.supportedReasoningEfforts.map((option) => option.reasoningEffort)];
  }

}
