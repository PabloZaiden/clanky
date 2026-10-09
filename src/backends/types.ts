/**
 * Provider-neutral backend interfaces and execution-host connection settings.
 */

import type { AgentProvider } from "@/shared/settings";
import type { EventStream } from "../utils/event-stream";
import type { ModelInfo } from "@/contracts";
import type { HarnessEvent } from "@/shared/harness-events";
import type { HarnessControl, HarnessConversationBinding } from "@/shared/harness-control";
import type { PromptInput } from "@/shared/harness-input";
export type { HarnessEvent, QuestionInfo, QuestionOption } from "@/shared/harness-events";
export type {
  PromptInput,
  PromptPart,
  TextPromptPart,
  ImagePromptPart,
  ResourcePromptPart,
  TextResourcePromptPart,
  BlobResourcePromptPart,
} from "@/shared/harness-input";

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
  /** Selected agent provider (used by ACP backends) */
  provider?: AgentProvider;
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
  /** Environment for the spawned ACP runtime */
  env?: NodeJS.ProcessEnv;
  /** Secret-free process bootstrap data written to the spawned runtime stdin */
  startupStdin?: string;
  /** Managed Clanky runtime environment delivered separately to Mesh workers. */
  managedEnvironment?: Record<string, string>;
  /** Enable Clanky control tools for a normal chat in the designated workspace. */
  controlTools?: boolean;
  /** Working directory for the backend */
  directory: string;
  /** Mesh ownership metadata for remote stdio ACP transport. */
  mesh?: {
    workspaceId: string;
    executionNodeId: string;
  };
}

/**
 * Options for creating a new session.
 */
export interface CreateSessionOptions {
  ownership?: Omit<HarnessConversationBinding, "adapter" | "nativeId" | "directory">;
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
  binding?: HarnessConversationBinding;
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
 * Backend interface that all backend implementations must implement.
 * This includes both the real AcpBackend and MockAcpBackend for tests.
 * 
 * The interface is split into two parts:
 * - Core methods: Used by TaskEngine for task execution
 * - Manager methods: Used by BackendManager for connection management
 */
export interface Backend {
  /** Controls and observations that persist beyond one prompt consumer. */
  readonly harness: HarnessControl;
  /** Backend name identifier */
  readonly name: string;

  // ============================================
  // Core methods (used by TaskEngine)
  // ============================================

  /**
   * Connect to the backend server.
   *
   * Implementations must observe the optional signal, reject promptly after
   * abort, and complete transport cleanup before the rejection settles.
   */
  connect(config: BackendConnectionConfig, signal?: AbortSignal): Promise<void>;

  /** Disconnect from the backend server */
  disconnect(): Promise<void>;

  /** Check if connected to the backend */
  isConnected(): boolean;

  /** Create a new agent session */
  createSession(options: CreateSessionOptions): Promise<AgentSession>;
  resumeSession(binding: HarnessConversationBinding): Promise<AgentSession>;

  /** Send a prompt synchronously and wait for response */
  sendPrompt(sessionId: string, prompt: PromptInput): Promise<AgentResponse>;

  /** Await prompt admission; execution events arrive through the subscription. */
  sendPromptAsync(sessionId: string, prompt: PromptInput): Promise<void>;

  /** Abort a session */
  abortSession(sessionId: string): Promise<void>;

  /** Subscribe to events from a session */
  subscribeToEvents(sessionId: string): Promise<EventStream<HarnessEvent>>;

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

  /** Get available variants for one model, when supported by the backend */
  getModelVariants?(directory: string, modelID: string): Promise<string[]>;
}
