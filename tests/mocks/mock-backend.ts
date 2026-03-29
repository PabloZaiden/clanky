/**
 * Mock AcpBackend for testing.
 * Implements the Backend interface to ensure type safety and API compatibility.
 */

import type {
  AgentSession,
  AgentResponse,
  AgentEvent,
  BackendConnectionConfig,
  CreateSessionOptions,
  PromptInput,
  Backend,
  ConnectionInfo,
} from "../../src/backends/types";
import { createEventStream, type EventStream } from "../../src/utils/event-stream";

/**
 * Mock model information for testing.
 * This type is used across multiple mock backends and test files.
 */
export interface MockModelInfo {
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  connected: boolean;
  /** Optional variant names. Empty string represents the default variant. */
  variants?: string[];
}

/**
 * Options for creating a MockAcpBackend.
 */
export interface MockBackendOptions {
  /** Responses to return for prompts (cycled through in order) */
  responses?: string[];
  /** Models to return from getModels() */
  models?: MockModelInfo[];
}

/**
 * MockAcpBackend provides a mock implementation of the Backend interface.
 * It implements all methods that AcpBackend has, ensuring no runtime errors
 * when BackendManager calls any Backend methods.
 *
 * Supports special response patterns:
 * - "ERROR:message" - Throws an error with the given message
 * - Any other string - Returns as normal response
 */
export class MockAcpBackend implements Backend {
  readonly name = "acp";

  private connected = false;
  private directory = "";
  private responseIndex = 0;
  private pendingPrompt = false;
  private readonly responses: string[];
  private readonly models: MockModelInfo[];
  private readonly sessions = new Map<string, AgentSession>();

  constructor(options: MockBackendOptions = {}) {
    this.responses = options.responses ?? ["<promise>COMPLETE</promise>"];
    this.models = options.models ?? [];
  }

  /**
   * Get the next response from the configured responses.
   */
  private getNextResponse(): string {
    const response = this.responses[this.responseIndex % this.responses.length] ?? "<promise>COMPLETE</promise>";
    this.responseIndex++;
    return response;
  }

  /**
   * Check if a response is an error and throw if so.
   */
  private checkForError(response: string): void {
    if (response.startsWith("ERROR:")) {
      throw new Error(response.slice(6));
    }
  }

  // ============================================
  // Core Backend methods (used by LoopEngine)
  // ============================================

  async connect(config: BackendConnectionConfig, _signal?: AbortSignal): Promise<void> {
    this.connected = true;
    this.directory = config.directory;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.directory = "";
  }

  isConnected(): boolean {
    return this.connected;
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    const session: AgentSession = {
      id: `mock-session-${Date.now()}`,
      title: options.title,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
    const response = this.getNextResponse();
    this.checkForError(response);
    return {
      id: `msg-${Date.now()}`,
      content: response,
      parts: [{ type: "text", text: response }],
    };
  }

  async sendPromptAsync(_sessionId: string, _prompt: PromptInput): Promise<void> {
    this.pendingPrompt = true;
  }

  async abortSession(_sessionId: string): Promise<void> {
    // Mock - no-op
  }

  async subscribeToEvents(_sessionId: string): Promise<EventStream<AgentEvent>> {
    const { stream, push, end } = createEventStream<AgentEvent>();

    (async () => {
      // Wait for pendingPrompt to be set
      let attempts = 0;
      while (!this.pendingPrompt && attempts < 100) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        attempts++;
      }
      this.pendingPrompt = false;

      // Get the next response
      const response = this.responses[this.responseIndex % this.responses.length] ?? "<promise>COMPLETE</promise>";
      this.responseIndex++;

      // Check if this is an error response
      if (response.startsWith("ERROR:")) {
        push({ type: "error", message: response.slice(6) });
        end();
        return;
      }

      // Emit normal message events
      push({ type: "message.start", messageId: `msg-${Date.now()}` });
      push({ type: "message.delta", content: response });
      push({ type: "message.complete", content: response });
      end();
    })();

    return stream;
  }

  async replyToPermission(_requestId: string, _response: string): Promise<void> {
    // Mock - no-op
  }

  async replyToQuestion(_requestId: string, _answers: string[][]): Promise<void> {
    // Mock - no-op
  }

  async setConfigOption(_sessionId: string, _configId: string, _value: string) {
    return [];
  }

  async setSessionModel(_sessionId: string, _modelId: string) {}

  // ============================================
  // Backend-specific methods (used by BackendManager)
  // ============================================

  /**
   * Get the SDK client.
   * Returns null since mock doesn't have a real SDK client.
   */
  getSdkClient(): null {
    return null;
  }

  /**
   * Get the current directory.
   */
  getDirectory(): string {
    return this.directory;
  }

  /**
   * Get connection info for WebSocket and other direct connections.
   * Returns mock connection info.
   */
  getConnectionInfo(): ConnectionInfo | null {
    if (!this.connected) {
      return null;
    }
    return {
      baseUrl: "http://mock-server:4096",
      authHeaders: {},
    };
  }

  /**
   * Abort all active event subscriptions.
   * Mock implementation - no-op.
   */
  abortAllSubscriptions(): void {
    // Mock - no-op
  }

  /**
   * Get available models.
   * Returns the models configured in the constructor options.
   */
  async getModels(_directory: string): Promise<MockModelInfo[]> {
    return this.models;
  }

  /**
   * Get an existing session by ID.
   */
  async getSession(id: string): Promise<AgentSession | null> {
    return this.sessions.get(id) ?? null;
  }

  /**
   * Delete a session.
   */
  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}

/**
 * Default test model that should be used across all tests.
 * Tests should use this model when creating loops.
 */
export const defaultTestModel: MockModelInfo = {
  providerID: "test-provider",
  providerName: "Test Provider",
  modelID: "test-model",
  modelName: "Test Model",
  connected: true,
};

/**
 * Create a mock backend with the given responses.
 * Convenience function for tests.
 * Includes the default test model by default.
 */
export function createMockBackend(responses: string[] = ["<promise>COMPLETE</promise>"]): MockAcpBackend {
  return new MockAcpBackend({ 
    responses,
    models: [defaultTestModel],
  });
}

/**
 * Options for creating a NeverCompletingMockBackend.
 */
export interface NeverCompletingMockBackendOptions {
  /** Models to return from getModels() */
  models?: MockModelInfo[];
}

/**
 * A mock backend that never completes - useful for testing active loop checks,
 * pending message handling, and other scenarios where loops need to stay running.
 */
export class NeverCompletingMockBackend implements Backend {
  readonly name = "acp";

  private connected = false;
  private directory = "";
  private readonly sessions = new Map<string, AgentSession>();
  private readonly models: MockModelInfo[];
  private readonly hangingTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: NeverCompletingMockBackendOptions = {}) {
    this.models = options.models ?? [defaultTestModel];
  }

  private clearHangingTimers(): void {
    for (const timer of this.hangingTimers) {
      clearTimeout(timer);
    }
    this.hangingTimers.clear();
  }

  async connect(config: BackendConnectionConfig, _signal?: AbortSignal): Promise<void> {
    this.connected = true;
    this.directory = config.directory;
  }

  async disconnect(): Promise<void> {
    this.clearHangingTimers();
    this.connected = false;
    this.directory = "";
  }

  isConnected(): boolean {
    return this.connected;
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    const session: AgentSession = {
      id: `mock-session-${Date.now()}`,
      title: options.title,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
    return {
      id: `msg-${Date.now()}`,
      content: "Still working...",
      parts: [{ type: "text", text: "Still working..." }],
    };
  }

  async sendPromptAsync(_sessionId: string, _prompt: PromptInput): Promise<void> {
    // No-op
  }

  async abortSession(_sessionId: string): Promise<void> {
    this.clearHangingTimers();
  }

  async subscribeToEvents(_sessionId: string): Promise<EventStream<AgentEvent>> {
    const { stream, push, end } = createEventStream<AgentEvent>();

    push({ type: "message.start", messageId: `msg-${Date.now()}` });
    push({ type: "message.delta", content: "Still working..." });

    const timer = setTimeout(() => {
      this.hangingTimers.delete(timer);
      end();
    }, 100000);
    this.hangingTimers.add(timer);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }

    return stream;
  }

  async replyToPermission(_requestId: string, _response: string): Promise<void> {
    // No-op
  }

  async replyToQuestion(_requestId: string, _answers: string[][]): Promise<void> {
    // No-op
  }

  async setConfigOption(_sessionId: string, _configId: string, _value: string) {
    return [];
  }

  async setSessionModel(_sessionId: string, _modelId: string) {}

  // Backend-specific methods
  getSdkClient(): null {
    return null;
  }

  getDirectory(): string {
    return this.directory;
  }

  getConnectionInfo(): ConnectionInfo | null {
    if (!this.connected) return null;
    return { baseUrl: "http://mock-server:4096", authHeaders: {} };
  }

  abortAllSubscriptions(): void {
    this.clearHangingTimers();
  }

  async getModels(_directory: string): Promise<MockModelInfo[]> {
    return this.models;
  }

  async getSession(id: string): Promise<AgentSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}

/**
 * Plan Mode mock backend with per-session response tracking.
 * Uses sendPrompt for name generation and subscribeToEvents for planning/execution.
 */
export class PlanModeMockBackend implements Backend {
  readonly name = "acp";

  private connected = false;
  private directory = "";
  private pendingPrompt = false;
  private nameCounter = 0;
  private sessions = new Map<string, AgentSession>();
  private sessionResponseIndex = new Map<string, number>();
  reset(): void {
    this.sessionResponseIndex.clear();
    this.pendingPrompt = false;
  }

  private getNextStreamResponse(sessionId: string): string {
    const idx = this.sessionResponseIndex.get(sessionId) ?? 0;
    this.sessionResponseIndex.set(sessionId, idx + 1);
    
    // Response sequence per session for streaming:
    // 0-8: PLAN_READY for planning phase
    // 9+: COMPLETE for execution phase
    if (idx < 9) {
      return "<promise>PLAN_READY</promise>";
    }
    return "<promise>COMPLETE</promise>";
  }

  async connect(config: BackendConnectionConfig, _signal?: AbortSignal): Promise<void> {
    this.connected = true;
    this.directory = config.directory;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.directory = "";
  }

  isConnected(): boolean {
    return this.connected;
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    const session: AgentSession = {
      id: `session-${Date.now()}-${Math.random()}`,
      title: options.title,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    this.sessionResponseIndex.set(session.id, 0);
    return session;
  }

  async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
    // sendPrompt is used for name generation
    const uniqueName = `test-loop-name-${++this.nameCounter}`;
    return {
      id: `msg-${Date.now()}`,
      content: uniqueName,
      parts: [{ type: "text", text: uniqueName }],
    };
  }

  async sendPromptAsync(_sessionId: string, _prompt: PromptInput): Promise<void> {
    this.pendingPrompt = true;
  }

  async abortSession(_sessionId: string): Promise<void> {
    // No-op
  }

  async subscribeToEvents(sessionId: string): Promise<EventStream<AgentEvent>> {
    const { stream, push, end } = createEventStream<AgentEvent>();
    const self = this;

    (async () => {
      let attempts = 0;
      while (!self.pendingPrompt && attempts < 100) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        attempts++;
      }
      self.pendingPrompt = false;

      const response = self.getNextStreamResponse(sessionId);
      push({ type: "message.start", messageId: `msg-${Date.now()}` });
      push({ type: "message.delta", content: response });
      push({ type: "message.complete", content: response });
      end();
    })();

    return stream;
  }

  async replyToPermission(_requestId: string, _response: string): Promise<void> {
    // No-op
  }

  async replyToQuestion(_requestId: string, _answers: string[][]): Promise<void> {
    // No-op
  }

  async setConfigOption(_sessionId: string, _configId: string, _value: string) {
    return [];
  }

  async setSessionModel(_sessionId: string, _modelId: string) {}

  // Backend-specific methods
  getSdkClient(): null {
    return null;
  }

  getDirectory(): string {
    return this.directory;
  }

  getConnectionInfo(): ConnectionInfo | null {
    if (!this.connected) return null;
    return { baseUrl: "http://mock-server:4096", authHeaders: {} };
  }

  abortAllSubscriptions(): void {
    // No-op
  }

  async getModels(_directory: string): Promise<{ providerID: string; providerName: string; modelID: string; modelName: string; connected: boolean; variants?: string[] }[]> {
    // Return a test model so it can be validated
    return [
      {
        providerID: "test-provider",
        providerName: "Test Provider",
        modelID: "test-model",
        modelName: "Test Model",
        connected: true,
        variants: [],
      },
    ];
  }

  async getSession(id: string): Promise<AgentSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}

interface ContextAwareSession {
  session: AgentSession;
  pendingPrompt?: PromptInput;
  firstThingSaid?: string;
  emitEmptyResponse?: boolean;
  abortGeneration?: number;
}

/**
 * Mock backend that simulates conversational memory per session and loses that
 * memory on disconnect, allowing tests to verify transcript replay after
 * stop/reconnect flows.
 */
export class ContextAwareMockBackend implements Backend {
  readonly name = "acp";

  private connected = false;
  private directory = "";
  private readonly sessions = new Map<string, ContextAwareSession>();
  private readonly models: MockModelInfo[];
  private readonly emitEmptyResponseAfterAbort: boolean;
  private readonly hangingPromptPattern?: RegExp;

  constructor(options: {
    models?: MockModelInfo[];
    emitEmptyResponseAfterAbort?: boolean;
    hangingPromptPattern?: RegExp;
  } = {}) {
    this.models = options.models ?? [defaultTestModel];
    this.emitEmptyResponseAfterAbort = options.emitEmptyResponseAfterAbort ?? false;
    this.hangingPromptPattern = options.hangingPromptPattern;
  }

  private extractPromptText(prompt: PromptInput): string {
    return prompt.parts
      .filter((part): part is Extract<PromptInput["parts"][number], { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }

  private extractFirstThingSaid(text: string): string | undefined {
    const match = text.match(/The first thing I said was:\s*(.+)/i);
    if (!match) {
      return undefined;
    }
    return match[1]!.trim();
  }

  private buildResponse(session: ContextAwareSession, prompt: PromptInput): string {
    const text = this.extractPromptText(prompt);
    const firstThingSaid = this.extractFirstThingSaid(text);
    if (firstThingSaid) {
      session.firstThingSaid = session.firstThingSaid ?? firstThingSaid;
    }

    if (/what was the first thing i said\??/i.test(text)) {
      const remembered = session.firstThingSaid ?? firstThingSaid;
      return remembered
        ? `The first thing you said was: ${remembered}`
        : "I don't know what you said first.";
    }

    return "I will remember that.";
  }

  async connect(config: BackendConnectionConfig, _signal?: AbortSignal): Promise<void> {
    this.connected = true;
    this.directory = config.directory;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.directory = "";
    this.sessions.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    const session: AgentSession = {
      id: `context-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: options.title,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, { session });
    return session;
  }

  async sendPrompt(sessionId: string, prompt: PromptInput): Promise<AgentResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const response = this.buildResponse(session, prompt);
    return {
      id: `msg-${Date.now()}`,
      content: response,
      parts: [{ type: "text", text: response }],
    };
  }

  async sendPromptAsync(sessionId: string, prompt: PromptInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session.pendingPrompt = prompt;
  }

  async abortSession(_sessionId: string): Promise<void> {
    const session = this.sessions.get(_sessionId);
    if (!session) {
      return;
    }

    session.abortGeneration = (session.abortGeneration ?? 0) + 1;
    if (this.emitEmptyResponseAfterAbort) {
      session.emitEmptyResponse = true;
    }
  }

  async subscribeToEvents(sessionId: string): Promise<EventStream<AgentEvent>> {
    const { stream, push, end } = createEventStream<AgentEvent>();

    (async () => {
      const session = this.sessions.get(sessionId);
      if (!session) {
        push({ type: "error", message: `Session not found: ${sessionId}` });
        end();
        return;
      }

      let attempts = 0;
      while (!session.pendingPrompt && attempts < 100) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        attempts++;
      }

      const prompt = session.pendingPrompt;
      session.pendingPrompt = undefined;
      if (!prompt) {
        push({ type: "error", message: "No prompt was queued for the session." });
        end();
        return;
      }

      const promptText = this.extractPromptText(prompt);
      if (
        this.hangingPromptPattern?.test(promptText)
        && !/what was the first thing i said\??/i.test(promptText)
      ) {
        push({ type: "message.start", messageId: `msg-${Date.now()}` });
        push({ type: "message.delta", content: "Still working..." });
        const abortGeneration = session.abortGeneration ?? 0;
        let attempts = 0;
        while ((session.abortGeneration ?? 0) === abortGeneration && attempts < 10000) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          attempts++;
        }
        return;
      }

      if (session.emitEmptyResponse) {
        session.emitEmptyResponse = false;
        push({ type: "message.start", messageId: `msg-${Date.now()}` });
        push({ type: "message.complete", content: "" });
        end();
        return;
      }

      const response = this.buildResponse(session, prompt);
      push({ type: "message.start", messageId: `msg-${Date.now()}` });
      push({ type: "message.delta", content: response });
      push({ type: "message.complete", content: response });
      end();
    })();

    return stream;
  }

  async replyToPermission(_requestId: string, _response: string): Promise<void> {
    // No-op for the mock.
  }

  async replyToQuestion(_requestId: string, _answers: string[][]): Promise<void> {
    // No-op for the mock.
  }

  async setConfigOption(_sessionId: string, _configId: string, _value: string) {
    return [];
  }

  async setSessionModel(_sessionId: string, _modelId: string) {}

  getSdkClient(): null {
    return null;
  }

  getDirectory(): string {
    return this.directory;
  }

  getConnectionInfo(): ConnectionInfo | null {
    if (!this.connected) {
      return null;
    }
    return { baseUrl: "http://mock-server:4096", authHeaders: {} };
  }

  abortAllSubscriptions(): void {
    // No-op for the mock.
  }

  async getModels(_directory: string): Promise<MockModelInfo[]> {
    return this.models;
  }

  async getSession(id: string): Promise<AgentSession | null> {
    return this.sessions.get(id)?.session ?? null;
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}
