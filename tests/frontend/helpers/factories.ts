/**
 * Test data factories for creating mock data objects.
 *
 * Each factory creates a valid object with sensible defaults and supports
 * partial overrides via the spread pattern.
 */

import type { Task, TaskConfig, TaskState, TaskStatus, ModelConfig } from "@/types/task";
import type { GitConfig, GitState, GitCommit, IterationSummary, TaskLogEntry, PersistedMessage, PersistedToolCall, TaskError, SessionInfo } from "@/types/task";
import type { Workspace } from "@/types/workspace";
import type { SshSession } from "@/types/ssh-session";
import type { BranchInfo, ModelInfo, FileDiff } from "@/types/api";
import type { MessageData, ToolCallData, TaskEvent } from "@/types/events";
import type { ServerSettings } from "@/types/settings";

let counter = 0;
function nextId(): string {
  counter++;
  return `test-${counter}-${Date.now()}`;
}

function isoNow(): string {
  return new Date().toISOString();
}

// ============================================
// Model
// ============================================

export function createModelConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-20250514",
    variant: "",
    ...overrides,
  };
}

// ============================================
// Server Settings
// ============================================

type LegacyServerSettingsOverrides = {
  mode?: "spawn" | "connect";
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
};

export function createServerSettings(
  overrides?: Partial<ServerSettings> & LegacyServerSettingsOverrides
): ServerSettings {
  const defaults: ServerSettings = {
    agent: {
      provider: "opencode",
      transport: "stdio",
    },
  };

  if (!overrides) {
    return defaults;
  }

  const legacyTransport = overrides.mode === "connect"
    ? "ssh"
    : overrides.mode === "spawn"
      ? "stdio"
      : undefined;
  const requestedTransport = overrides.agent?.transport ?? legacyTransport ?? defaults.agent.transport;

  if (requestedTransport === "ssh") {
    return {
      agent: {
        provider: overrides.agent?.provider ?? defaults.agent.provider,
        transport: "ssh",
        hostname:
          (overrides.agent?.transport === "ssh" && overrides.agent.hostname)
          || overrides.hostname
          || "localhost",
        port:
          (overrides.agent?.transport === "ssh" && overrides.agent.port)
          || overrides.port
          || 22,
        username:
          (overrides.agent?.transport === "ssh" && overrides.agent.username)
          || overrides.username
          || undefined,
        password:
          (overrides.agent?.transport === "ssh" && overrides.agent.password)
          || overrides.password
          || undefined,
      },
    };
  }

  return {
    agent: {
      provider: overrides.agent?.provider ?? defaults.agent.provider,
      transport: "stdio",
    },
  };
}

// ============================================
// Git
// ============================================

export function createGitConfig(overrides?: Partial<GitConfig>): GitConfig {
  return {
    branchPrefix: "",
    commitScope: "",
    ...overrides,
  };
}

export function createGitCommit(overrides?: Partial<GitCommit>): GitCommit {
  return {
    iteration: 1,
    sha: "abc123def456",
    message: "feat: initial implementation",
    timestamp: isoNow(),
    filesChanged: 3,
    ...overrides,
  };
}

export function createGitState(overrides?: Partial<GitState>): GitState {
  return {
    originalBranch: "main",
    workingBranch: "test-task-a1b2c3d",
    commits: [],
    ...overrides,
  };
}

// ============================================
// Session
// ============================================

export function createSessionInfo(overrides?: Partial<SessionInfo>): SessionInfo {
  return {
    id: nextId(),
    serverUrl: "http://localhost:3000",
    ...overrides,
  };
}

export function createSshSession(overrides?: {
  config?: Partial<SshSession["config"]>;
  state?: Partial<SshSession["state"]>;
}): SshSession {
  const id = overrides?.config?.id ?? nextId();
  return {
    config: {
      id,
      name: "SSH Session",
      workspaceId: "workspace-1",
      directory: "/workspaces/test-project",
      connectionMode: "dtach",
      ...overrides?.config,
      useTmux: overrides?.config?.useTmux ?? true,
      remoteSessionName: overrides?.config?.remoteSessionName ?? `clanky-${id.replace(/-/g, "").slice(0, 24)}`,
      createdAt: overrides?.config?.createdAt ?? isoNow(),
      updatedAt: overrides?.config?.updatedAt ?? isoNow(),
    },
    state: {
      status: "ready",
      ...overrides?.state,
    },
  };
}

// ============================================
// Error
// ============================================

export function createTaskError(overrides?: Partial<TaskError>): TaskError {
  return {
    message: "Test error occurred",
    iteration: 1,
    timestamp: isoNow(),
    ...overrides,
  };
}

// ============================================
// Iteration Summary
// ============================================

export function createIterationSummary(overrides?: Partial<IterationSummary>): IterationSummary {
  return {
    iteration: 1,
    startedAt: isoNow(),
    completedAt: isoNow(),
    messageCount: 5,
    toolCallCount: 3,
    outcome: "continue",
    ...overrides,
  };
}

// ============================================
// Log Entry
// ============================================

export function createTaskLogEntry(overrides?: Partial<TaskLogEntry>): TaskLogEntry {
  return {
    id: nextId(),
    level: "info",
    message: "Test log entry",
    timestamp: isoNow(),
    ...overrides,
  };
}

// ============================================
// Persisted Message
// ============================================

export function createPersistedMessage(overrides?: Partial<PersistedMessage>): PersistedMessage {
  return {
    id: nextId(),
    role: "assistant",
    content: "This is a test message",
    timestamp: isoNow(),
    ...overrides,
  };
}

// ============================================
// Persisted Tool Call
// ============================================

export function createPersistedToolCall(overrides?: Partial<PersistedToolCall>): PersistedToolCall {
  return {
    id: nextId(),
    name: "Write",
    input: { filePath: "/src/index.ts", content: "test" },
    status: "completed",
    timestamp: isoNow(),
    ...overrides,
  };
}

// ============================================
// Task Config
// ============================================

export function createTaskConfig(overrides?: Partial<TaskConfig>): TaskConfig {
  const id = overrides?.id ?? nextId();
  return {
    id,
    name: "Test Task",
    directory: "/workspaces/test-project",
    prompt: "Write a test function",
    createdAt: isoNow(),
    updatedAt: isoNow(),
    workspaceId: "workspace-1",
    model: createModelConfig(),
    maxIterations: Infinity,
    maxConsecutiveErrors: 10,
    activityTimeoutSeconds: 180,
    stopPattern: "<promise>COMPLETE</promise>$",
    git: createGitConfig(),
    useWorktree: true,
    clearPlanningFolder: false,
    planMode: true,
    autoAcceptPlan: false,
    mode: "task",
    ...overrides,
  };
}

// ============================================
// Task State
// ============================================

export function createTaskState(overrides?: Partial<TaskState>): TaskState {
  const id = overrides?.id ?? nextId();
  return {
    id,
    status: "idle",
    currentIteration: 0,
    recentIterations: [],
    logs: [],
    messages: [],
    toolCalls: [],
    ...overrides,
  };
}

// ============================================
// Task (combined config + state)
// ============================================

export function createTask(overrides?: {
  config?: Partial<TaskConfig>;
  state?: Partial<TaskState>;
}): Task {
  const id = overrides?.config?.id ?? overrides?.state?.id ?? nextId();
  return {
    config: createTaskConfig({ ...overrides?.config, id }),
    state: createTaskState({ ...overrides?.state, id }),
  };
}

/**
 * Create a task in a specific status with appropriate state.
 */
export function createTaskWithStatus(status: TaskStatus, overrides?: {
  config?: Partial<TaskConfig>;
  state?: Partial<TaskState>;
}): Task {
  const stateOverrides: Partial<TaskState> = { status };

  switch (status) {
    case "running":
    case "waiting":
      stateOverrides.startedAt = isoNow();
      stateOverrides.currentIteration = 1;
      stateOverrides.session = createSessionInfo();
      stateOverrides.git = createGitState();
      break;
    case "planning":
      stateOverrides.startedAt = isoNow();
      stateOverrides.session = createSessionInfo();
      stateOverrides.git = createGitState();
      stateOverrides.planMode = {
        active: true,
        feedbackRounds: 0,
        planningFolderCleared: false,
        isPlanReady: false,
      };
      break;
    case "completed":
    case "stopped":
    case "failed":
    case "max_iterations":
      stateOverrides.startedAt = isoNow();
      stateOverrides.completedAt = isoNow();
      stateOverrides.currentIteration = 3;
      stateOverrides.git = createGitState();
      if (status === "failed") {
        stateOverrides.error = createTaskError();
      }
      break;
    case "merged":
      stateOverrides.startedAt = isoNow();
      stateOverrides.completedAt = isoNow();
      stateOverrides.currentIteration = 3;
      stateOverrides.git = createGitState();
      break;
    case "pushed":
      stateOverrides.startedAt = isoNow();
      stateOverrides.completedAt = isoNow();
      stateOverrides.currentIteration = 3;
      stateOverrides.git = createGitState();
      stateOverrides.reviewMode = {
        addressable: true,
        completionAction: "push",
        reviewCycles: 0,
      };
      break;
    case "deleted":
      stateOverrides.startedAt = isoNow();
      stateOverrides.completedAt = isoNow();
      stateOverrides.git = createGitState();
      break;
  }

  return createTask({
    config: overrides?.config,
    state: { ...stateOverrides, ...overrides?.state },
  });
}

// ============================================
// Workspace
// ============================================

export function createWorkspace(overrides?: Partial<Workspace>): Workspace {
  return {
    id: overrides?.id ?? nextId(),
    name: "Test Workspace",
    directory: "/workspaces/test-project",
    serverSettings: createServerSettings(),
    createdAt: isoNow(),
    updatedAt: isoNow(),
    ...overrides,
  };
}

// ============================================
// API Response Types
// ============================================

export function createBranchInfo(overrides?: Partial<BranchInfo>): BranchInfo {
  return {
    name: "main",
    current: true,
    ...overrides,
  };
}

export function createModelInfo(overrides?: Partial<ModelInfo>): ModelInfo {
  return {
    providerID: "anthropic",
    providerName: "Anthropic",
    modelID: "claude-sonnet-4-20250514",
    modelName: "Claude Sonnet 4",
    connected: true,
    ...overrides,
  };
}

export function createFileDiff(overrides?: Partial<FileDiff>): FileDiff {
  return {
    path: "src/index.ts",
    status: "modified",
    additions: 10,
    deletions: 2,
    ...overrides,
  };
}

// ============================================
// Event Types
// ============================================

export function createMessageData(overrides?: Partial<MessageData>): MessageData {
  return {
    id: nextId(),
    role: "assistant",
    content: "Test message content",
    timestamp: isoNow(),
    ...overrides,
  };
}

export function createToolCallData(overrides?: Partial<ToolCallData>): ToolCallData {
  return {
    id: nextId(),
    name: "Write",
    input: { filePath: "/src/test.ts" },
    status: "completed",
    timestamp: isoNow(),
    ...overrides,
  };
}

/**
 * Create a typed TaskEvent.
 * Use specific factory functions below for convenience.
 */
export function createTaskCreatedEvent(taskId: string, config?: Partial<TaskConfig>): TaskEvent {
  return {
    type: "task.created",
    taskId,
    config: createTaskConfig({ ...config, id: taskId }),
    timestamp: isoNow(),
  };
}

export function createTaskStartedEvent(taskId: string, iteration = 1): TaskEvent {
  return {
    type: "task.started",
    taskId,
    iteration,
    timestamp: isoNow(),
  };
}

export function createTaskCompletedEvent(taskId: string, totalIterations = 3): TaskEvent {
  return {
    type: "task.completed",
    taskId,
    totalIterations,
    timestamp: isoNow(),
  };
}

export function createTaskSshHandoffEvent(taskId: string, totalIterations = 0): TaskEvent {
  return {
    type: "task.ssh_handoff",
    taskId,
    totalIterations,
    timestamp: isoNow(),
  };
}

export function createTaskDeletedEvent(taskId: string): TaskEvent {
  return {
    type: "task.deleted",
    taskId,
    timestamp: isoNow(),
  };
}

export function createTaskMessageEvent(taskId: string, message?: Partial<MessageData>): TaskEvent {
  return {
    type: "task.message",
    taskId,
    iteration: 1,
    message: createMessageData(message),
    timestamp: isoNow(),
  };
}

export function createTaskToolCallEvent(taskId: string, tool?: Partial<ToolCallData>): TaskEvent {
  return {
    type: "task.tool_call",
    taskId,
    iteration: 1,
    tool: createToolCallData(tool),
    timestamp: isoNow(),
  };
}

export function createTaskLogEvent(taskId: string, overrides?: Partial<{ id: string; level: string; message: string; details: Record<string, unknown> }>): TaskEvent {
  return {
    type: "task.log",
    taskId,
    id: overrides?.id ?? nextId(),
    level: (overrides?.level ?? "info") as "info",
    message: overrides?.message ?? "Test log message",
    details: overrides?.details,
    timestamp: isoNow(),
  };
}

export function createTaskProgressEvent(taskId: string, content = "Streaming..."): TaskEvent {
  return {
    type: "task.progress",
    taskId,
    iteration: 1,
    content,
    timestamp: isoNow(),
  };
}

export function createTaskPlanReadyEvent(taskId: string, planContent = "# Plan\n\n1. Do something"): TaskEvent {
  return {
    type: "task.plan.ready",
    taskId,
    planContent,
    timestamp: isoNow(),
  };
}

export function createTaskErrorEvent(taskId: string, error = "Something went wrong", iteration = 1): TaskEvent {
  return {
    type: "task.error",
    taskId,
    error,
    iteration,
    timestamp: isoNow(),
  };
}

export function createTaskAcceptedEvent(taskId: string): TaskEvent {
  return {
    type: "task.accepted",
    taskId,
    timestamp: isoNow(),
  };
}

export function createTaskPushedEvent(taskId: string, remoteBranch = "origin/test-task-a1b2c3d"): TaskEvent {
  return {
    type: "task.pushed",
    taskId,
    remoteBranch,
    timestamp: isoNow(),
  };
}

export function createTaskPendingUpdatedEvent(taskId: string, overrides?: { pendingPrompt?: string; pendingModel?: ModelConfig }): TaskEvent {
  return {
    type: "task.pending.updated",
    taskId,
    ...overrides,
    timestamp: isoNow(),
  };
}

/**
 * Reset the counter (useful between test files if needed).
 */
export function resetFactoryCounter(): void {
  counter = 0;
}
