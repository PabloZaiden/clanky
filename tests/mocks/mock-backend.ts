/**
 * Mock AcpBackend for testing.
 * Implements the Backend interface to ensure type safety and API compatibility.
 */

import type {
  AgentSession,
  AgentResponse,
  AgentEvent,
  BackendConnectionConfig,
  ConfigOption,
  CreateSessionOptions,
  PromptInput,
  Backend,
  ConnectionInfo,
  ImportableSession,
  ImportSessionOptions,
  ImportSessionResult,
  SessionReplayEvent,
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
  /** Match real ACP provider-scoped model discovery for tests that need it. */
  filterModelsByConnectionProvider?: boolean;
}

let mockSessionIdCounter = 0;

function createMockSessionId(prefix: string): string {
  mockSessionIdCounter += 1;
  return `${prefix}-${Date.now()}-${mockSessionIdCounter}`;
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
  private readonly filterModelsByConnectionProvider: boolean;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly importableSessions = new Map<string, { session: ImportableSession; events: SessionReplayEvent[] }>();
  private readonly sentPrompts: PromptInput[] = [];
  private readonly permissionReplies: Array<{ requestId: string; response: string }> = [];
  private readonly configOptionUpdates: Array<{ sessionId: string; configId: string; value: string }> = [];
  private readonly sessionModelUpdates: Array<{ sessionId: string; modelId: string }> = [];
  private readonly connectionConfigs: BackendConnectionConfig[] = [];
  private nextCreateSessionError: string | null = null;
  private nextGetSessionError: string | null = null;

  constructor(options: MockBackendOptions = {}) {
    this.responses = options.responses ?? ["<promise>COMPLETE</promise>"];
    this.models = options.models ?? [];
    this.filterModelsByConnectionProvider = options.filterModelsByConnectionProvider ?? false;
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
  // Core Backend methods (used by TaskEngine)
  // ============================================

  async connect(config: BackendConnectionConfig, _signal?: AbortSignal): Promise<void> {
    this.connected = true;
    this.directory = config.directory;
    this.connectionConfigs.push(config);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.directory = "";
  }

  isConnected(): boolean {
    return this.connected;
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    if (this.nextCreateSessionError) {
      const message = this.nextCreateSessionError;
      this.nextCreateSessionError = null;
      throw new Error(message);
    }
    const session: AgentSession = {
      id: createMockSessionId("mock-session"),
      title: options.title,
      createdAt: new Date().toISOString(),
      model: options.model,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
    this.sentPrompts.push(_prompt);
    const response = this.getNextResponse();
    this.checkForError(response);
    return {
      id: `msg-${Date.now()}`,
      content: response,
      parts: [{ type: "text", text: response }],
    };
  }

  async sendPromptAsync(_sessionId: string, _prompt: PromptInput): Promise<void> {
    this.sentPrompts.push(_prompt);
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

  async replyToPermission(requestId: string, response: string): Promise<void> {
    this.permissionReplies.push({ requestId, response });
  }

  async replyToQuestion(_requestId: string, _answers: string[][]): Promise<void> {
    // Mock - no-op
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
    this.configOptionUpdates.push({ sessionId, configId, value });
    if (configId === "model") {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.model = value;
      }
    }
    return [];
  }

  async setSessionModel(sessionId: string, modelId: string) {
    this.sessionModelUpdates.push({ sessionId, modelId });
    const session = this.sessions.get(sessionId);
    if (session) {
      session.model = modelId;
    }
  }

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
    if (this.filterModelsByConnectionProvider) {
      const provider = this.connectionConfigs.at(-1)?.provider;
      return this.models.filter((model) => model.providerID === provider);
    }
    return this.models;
  }

  /**
   * Get an existing session by ID.
   */
  async getSession(id: string): Promise<AgentSession | null> {
    if (this.nextGetSessionError) {
      const message = this.nextGetSessionError;
      this.nextGetSessionError = null;
      throw new Error(message);
    }
    return this.sessions.get(id) ?? null;
  }

  async listSessions(directory?: string): Promise<ImportableSession[]> {
    return Array.from(this.importableSessions.values())
      .map((entry) => entry.session)
      .filter((session) => !directory || session.cwd === directory);
  }

  async importSession(options: ImportSessionOptions): Promise<ImportSessionResult> {
    const entry = this.importableSessions.get(options.sessionId);
    if (!entry) {
      throw new Error(`Session ${options.sessionId} not found`);
    }
    const session: AgentSession = {
      id: entry.session.id,
      title: entry.session.title,
      createdAt: new Date().toISOString(),
      model: entry.session.model,
    };
    this.sessions.set(session.id, session);
    return {
      session,
      cwd: options.cwd ?? entry.session.cwd,
      events: options.includeHistory ? [...entry.events] : [],
    };
  }

  /**
   * Delete a session.
   */
  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  failNextCreateSession(message: string): void {
    this.nextCreateSessionError = message;
  }

  failNextGetSession(message: string): void {
    this.nextGetSessionError = message;
  }

  getSentPrompts(): PromptInput[] {
    return [...this.sentPrompts];
  }

  getPermissionReplies(): Array<{ requestId: string; response: string }> {
    return [...this.permissionReplies];
  }

  getConfigOptionUpdates(): Array<{ sessionId: string; configId: string; value: string }> {
    return [...this.configOptionUpdates];
  }

  getSessionModelUpdates(): Array<{ sessionId: string; modelId: string }> {
    return [...this.sessionModelUpdates];
  }

  getConnectionConfigs(): BackendConnectionConfig[] {
    return [...this.connectionConfigs];
  }

  addImportableSession(session: ImportableSession, events: SessionReplayEvent[]): void {
    this.importableSessions.set(session.id, { session, events });
  }
}

/**
 * Default test model that should be used across all tests.
 * Tests should use this model when creating tasks.
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
 * A mock backend that never completes - useful for testing active task checks,
 * pending message handling, and other scenarios where tasks need to stay running.
 */
export class NeverCompletingMockBackend implements Backend {
  readonly name = "acp";

  private connected = false;
  private directory = "";
  private readonly sessions = new Map<string, AgentSession>();
  private readonly models: MockModelInfo[];

  constructor(options: NeverCompletingMockBackendOptions = {}) {
    this.models = options.models ?? [defaultTestModel];
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
      id: createMockSessionId("mock-session"),
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
    // No-op
  }

  async subscribeToEvents(_sessionId: string): Promise<EventStream<AgentEvent>> {
    const { stream, push } = createEventStream<AgentEvent>();

    (async () => {
      push({ type: "message.start", messageId: `msg-${Date.now()}` });
      push({ type: "message.delta", content: "Still working..." });
      // Never end the stream - keep task running forever
      await new Promise((resolve) => setTimeout(resolve, 100000));
    })();

    return stream;
  }

  async replyToPermission(_requestId: string, _response: string): Promise<void> {
    // No-op
  }

  async replyToQuestion(_requestId: string, _answers: string[][]): Promise<void> {
    // No-op
  }

  async setConfigOption(_sessionId: string, _configId: string, _value: string): Promise<ConfigOption[]> {
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

  async getModels(_directory: string): Promise<MockModelInfo[]> {
    return this.models;
  }

  async getSession(id: string): Promise<AgentSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async listSessions(directory?: string): Promise<ImportableSession[]> {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      title: session.title,
      cwd: directory ?? this.directory,
      model: session.model,
    }));
  }

  async importSession(options: ImportSessionOptions): Promise<ImportSessionResult> {
    const session = this.sessions.get(options.sessionId);
    if (!session) {
      throw new Error(`Session ${options.sessionId} not found`);
    }
    return {
      session,
      cwd: options.cwd ?? this.directory,
      events: [],
    };
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
    const uniqueName = `test-task-name-${++this.nameCounter}`;
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

  async setConfigOption(_sessionId: string, _configId: string, _value: string): Promise<ConfigOption[]> {
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

  async listSessions(directory?: string): Promise<ImportableSession[]> {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      title: session.title,
      cwd: directory ?? this.directory,
      model: session.model,
    }));
  }

  async importSession(options: ImportSessionOptions): Promise<ImportSessionResult> {
    const session = this.sessions.get(options.sessionId);
    if (!session) {
      throw new Error(`Session ${options.sessionId} not found`);
    }
    return {
      session,
      cwd: options.cwd ?? this.directory,
      events: [],
    };
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}
