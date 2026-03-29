/**
 * Type definitions for ACP backends.
 * These types define the data structures used by AcpBackend.
 */

import type { EventStream } from "../utils/event-stream";
import type { ModelInfo } from "../types/api";

/**
 * Connection info needed for WebSocket and other direct connections.
 */
export interface ConnectionInfo {
  /** Base URL for the active transport */
  baseUrl: string;
  /** Auth headers to use for connections */
  authHeaders: Record<string, string>;
}

/**
 * Configuration for connecting to an ACP backend.
 */
export interface BackendConnectionConfig {
  /** Backend runtime mode (ACP backends currently use "spawn") */
  mode: "spawn" | "connect";
  /** Selected agent provider (used by ACP backends) */
  provider?: "opencode" | "copilot";
  /** Selected agent transport (used by ACP backends) */
  transport?: "stdio" | "ssh";
  /** SSH hostname */
  hostname?: string;
  /** SSH port */
  port?: number;
  /** SSH username (optional) */
  username?: string;
  /** SSH password (optional) */
  password?: string;
  /** SSH identity file path (optional) */
  identityFile?: string;
  /** Derived command for ACP transport */
  command?: string;
  /** Derived command args for ACP transport */
  args?: string[];
  /** Working directory for the backend */
  directory: string;
}

/**
 * Options for creating a new session.
 */
export interface CreateSessionOptions {
  /** Session title */
  title?: string;
  /** Working directory */
  directory: string;
  /** Default model for the session (modelID string sent to ACP) */
  model?: string;
}

/**
 * A value option within a config option (per ACP session-config-options spec).
 */
export interface ConfigOptionValue {
  /** Value identifier used when setting this option */
  value: string;
  /** Human-readable name */
  name: string;
  /** Optional description */
  description?: string;
}

/**
 * A session-level configuration option (per ACP session-config-options spec).
 * Agents return these in the session/new response and in config_options_update notifications.
 */
export interface ConfigOption {
  /** Unique identifier for this option (e.g. "model", "mode") */
  id: string;
  /** Human-readable label */
  name: string;
  /** Optional description */
  description?: string;
  /** Semantic category for UX (e.g. "model", "mode", "thought_level") */
  category?: string;
  /** Input control type (currently only "select") */
  type: string;
  /** Currently selected value */
  currentValue: string;
  /** Available values */
  options: ConfigOptionValue[];
}

/**
 * Represents a session in the agent backend.
 */
export interface AgentSession {
  /** Session ID */
  id: string;
  /** Session title */
  title?: string;
  /** Creation timestamp (ISO) */
  createdAt: string;
  /** Model reported by the ACP server for this session (if available) */
  model?: string;
  /** Config options returned by the agent (per ACP session-config-options spec) */
  configOptions?: ConfigOption[];
}

/**
 * Part of a prompt message.
 */
export type PromptPart = TextPromptPart | ImagePromptPart;

export interface TextPromptPart {
  /** Part type */
  type: "text";
  /** Text content */
  text: string;
}

export interface ImagePromptPart {
  /** Part type */
  type: "image";
  /** Image MIME type */
  mimeType: string;
  /** Base64-encoded image data */
  data: string;
  /** Original filename, used for debugging/UX only */
  filename?: string;
}

/**
 * Input for sending a prompt.
 */
export interface PromptInput {
  /** Prompt parts */
  parts: PromptPart[];
  /** Model override */
  model?: {
    providerID: string;
    modelID: string;
    /** Model variant (e.g., "thinking"). Empty string or undefined for default. */
    variant?: string;
  };
}

/**
 * Part of an agent response.
 */
export interface AgentPart {
  /** Part type */
  type: "text" | "tool_call" | "tool_result";
  /** Text content (for text type) */
  text?: string;
  /** Tool name (for tool types) */
  toolName?: string;
  /** Tool input (for tool_call) */
  toolInput?: unknown;
  /** Tool output (for tool_result) */
  toolOutput?: unknown;
}

/**
 * Response from the agent backend.
 */
export interface AgentResponse {
  /** Response ID */
  id: string;
  /** Full response content */
  content: string;
  /** Response parts */
  parts: AgentPart[];
  /** Token usage */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Question option for question.asked events.
 */
export interface QuestionOption {
  label: string;
  description: string;
}

/**
 * Question in a question.asked event.
 */
export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

/**
 * Events emitted by ACP backends.
 */
export type AgentEvent =
  | { type: "message.start"; messageId: string }
  | { type: "message.delta"; content: string }
  | { type: "message.complete"; content: string }
  | { type: "reasoning.delta"; content: string }
  | { type: "tool.start"; toolName: string; input: unknown }
  | { type: "tool.complete"; toolName: string; output: unknown }
  | { type: "error"; message: string }
  | { type: "permission.asked"; requestId: string; sessionId: string; permission: string; patterns: string[] }
  | { type: "question.asked"; requestId: string; sessionId: string; questions: QuestionInfo[] }
  | { type: "session.status"; sessionId: string; status: "idle" | "busy" | "retry"; attempt?: number; message?: string };

/**
 * Backend interface that all backend implementations must implement.
 * This includes both the real AcpBackend and MockAcpBackend for tests.
 * 
 * The interface is split into two parts:
 * - Core methods: Used by LoopEngine for loop execution
 * - Manager methods: Used by BackendManager for connection management
 */
export interface Backend {
  /** Backend name identifier */
  readonly name: string;

  // ============================================
  // Core methods (used by LoopEngine)
  // ============================================

  /** Connect to the backend server. Optional signal allows aborting the connection attempt. */
  connect(config: BackendConnectionConfig, signal?: AbortSignal): Promise<void>;

  /** Disconnect from the backend server */
  disconnect(): Promise<void>;

  /** Check if connected to the backend */
  isConnected(): boolean;

  /** Create a new agent session */
  createSession(options: CreateSessionOptions): Promise<AgentSession>;

  /** Send a prompt synchronously and wait for response */
  sendPrompt(sessionId: string, prompt: PromptInput): Promise<AgentResponse>;

  /** Send a prompt asynchronously (fire and forget, events come via subscription) */
  sendPromptAsync(sessionId: string, prompt: PromptInput): Promise<void>;

  /** Abort a session */
  abortSession(sessionId: string): Promise<void>;

  /** Subscribe to events from a session */
  subscribeToEvents(sessionId: string): Promise<EventStream<AgentEvent>>;

  /** Reply to a permission request */
  replyToPermission(requestId: string, response: string): Promise<void>;

  /** Reply to a question request */
  replyToQuestion(requestId: string, answers: string[][]): Promise<void>;

  /** Set a session config option (per ACP session-config-options spec) */
  setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[]>;

  /** Set the model via session/set_model (fallback for agents without config options) */
  setSessionModel(sessionId: string, modelId: string): Promise<void>;

  // ============================================
  // Manager methods (used by BackendManager)
  // ============================================

  /** Abort all active event subscriptions */
  abortAllSubscriptions(): void;

  /**
   * Get the SDK/client instance.
   * Returns `unknown` intentionally — this interface is implemented by both
   * the real AcpBackend and MockAcpBackend. Typing it as a concrete client
   * would couple shared contracts to one provider's SDK shape.
   * Callers should cast as needed.
   */
  getSdkClient(): unknown;

  /** Get the current working directory */
  getDirectory(): string;

  /** Get connection info for WebSocket and other direct connections */
  getConnectionInfo(): ConnectionInfo | null;

  /** Get an existing session by ID */
  getSession(id: string): Promise<AgentSession | null>;

  /** Delete a session */
  deleteSession(id: string): Promise<void>;

  /** Get available models */
  getModels(directory: string): Promise<ModelInfo[]>;
}
