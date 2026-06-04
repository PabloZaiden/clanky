/**
 * Shared test utilities for user scenario integration tests.
 * These helpers simulate UI interactions via API calls.
 */

import { mkdtemp, rm, writeFile, mkdir, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { serve, type Server } from "bun";
import { apiRoutes } from "../../../src/api";
import { ensureDataDirectories } from "../../../src/persistence/database";
import { backendManager } from "../../../src/core/backend-manager";
import { taskManager } from "../../../src/core/task-manager";
import { closeDatabase } from "../../../src/persistence/database";
import { TestCommandExecutor } from "../../mocks/mock-executor";
import type { TaskBackend } from "../../../src/core/task-engine";
import type {
  AgentSession,
  AgentResponse,
  AgentEvent,
  BackendConnectionConfig,
  CreateSessionOptions,
  ImportableSession,
  ImportSessionOptions,
  ImportSessionResult,
  PromptInput,
} from "../../../src/backends/types";
import { createEventStream, type EventStream } from "../../../src/utils/event-stream";
import type { Task } from "../../../src/types/task";

/**
 * Test context containing all test dependencies.
 */
export interface TestServerContext {
  /** Temporary data directory for persistence */
  dataDir: string;
  /** Temporary working directory (simulates a project) */
  workDir: string;
  /** Default branch for the test repo */
  defaultBranch: string;
  /** The test server */
  server: Server<unknown>;
  /** Base URL for API calls */
  baseUrl: string;
  /** Mock backend instance */
  mockBackend: ConfigurableMockBackend;
  /** Local git remote path (for push tests) */
  remoteDir?: string;
  /** Default workspace ID for this test context */
  workspaceId: string;
}

/**
 * Configurable mock backend that allows dynamic response configuration.
 * This enables tests to control iteration outcomes.
 */
export class ConfigurableMockBackend implements TaskBackend {
  readonly name = "acp";

  private connected = false;
  private directory = "";
  private responseIndex = 0;
  private responses: string[];
  private readonly sessions = new Map<string, AgentSession>();
  
  // Promise-based synchronization for prompt/subscription coordination
  private promptResolver: (() => void) | null = null;
  private promptPromise: Promise<void> | null = null;
  
  constructor(responses: string[] = ["<promise>COMPLETE</promise>"]) {
    this.responses = responses;
  }

  /**
   * Reset the response index and optionally set new responses.
   */
  reset(responses?: string[]): void {
    this.responseIndex = 0;
    this.promptResolver = null;
    this.promptPromise = null;
    if (responses) {
      this.responses = responses;
    }
  }

  /**
   * Set the responses for subsequent prompts.
   */
  setResponses(responses: string[]): void {
    this.responses = responses;
    this.responseIndex = 0;
  }

  /**
   * Get the current response index.
   */
  getResponseIndex(): number {
    return this.responseIndex;
  }

  private getNextResponse(): string {
    const response = this.responses[this.responseIndex % this.responses.length] ?? "<promise>COMPLETE</promise>";
    this.responseIndex++;
    return response;
  }

  private checkForError(response: string): void {
    if (response.startsWith("ERROR:")) {
      throw new Error(response.slice(6));
    }
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
      id: `mock-session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
    // Resolve any waiting subscription
    if (this.promptResolver) {
      this.promptResolver();
      this.promptResolver = null;
      this.promptPromise = null;
    }
  }

  async abortSession(_sessionId: string): Promise<void> {
    // Mock - no-op
  }

  async subscribeToEvents(_sessionId: string): Promise<EventStream<AgentEvent>> {
    const { stream, push, end } = createEventStream<AgentEvent>();

    // Create a promise that will be resolved when sendPromptAsync is called
    this.promptPromise = new Promise<void>((resolve) => {
      this.promptResolver = resolve;
    });

    const promptPromise = this.promptPromise;

    (async () => {
      // Wait for the prompt to be sent (with timeout for safety)
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Mock backend timeout waiting for prompt")), 30000);
      });

      try {
        await Promise.race([promptPromise, timeoutPromise]);
      } catch (error) {
        // Timeout - emit error and end stream
        push({ type: "error", message: String(error) });
        end();
        return;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }

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

  // OpenCode-specific methods
  getSdkClient(): null {
    return null;
  }

  getDirectory(): string {
    return this.directory;
  }

  getConnectionInfo(): { baseUrl: string; authHeaders: Record<string, string> } | null {
    if (!this.connected) {
      return null;
    }
    return {
      baseUrl: "http://mock-server:4096",
      authHeaders: {},
    };
  }

  abortAllSubscriptions(): void {
    // Mock - no-op
  }

  async getModels(_directory: string): Promise<{ providerID: string; providerName: string; modelID: string; modelName: string; connected: boolean; variants?: string[] }[]> {
    // Return the test model so it can be validated
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

/**
 * Options for setting up a test server context.
 */
export interface SetupServerOptions {
  /** Initial responses for the mock backend */
  mockResponses?: string[];
  /** Create a local git remote for push tests */
  withRemote?: boolean;
  /** Initial files to create in the work directory */
  initialFiles?: Record<string, string>;
  /** Create .clanky-planning directory with default files */
  withPlanningDir?: boolean;
}

/**
 * Set up a test server with all dependencies.
 */
export async function setupTestServer(options: SetupServerOptions = {}): Promise<TestServerContext> {
  const {
    mockResponses = ["<promise>COMPLETE</promise>"],
    withRemote = true,
    initialFiles = {},
    withPlanningDir = false,
  } = options;

  // Create temp directories
  // Resolve symlinks (macOS /var → /private/var) to match git's resolved paths
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), "clanky-scenario-data-")));
  const workDir = await realpath(await mkdtemp(join(tmpdir(), "clanky-scenario-work-")));

  // Set env var for persistence
  process.env["CLANKY_DATA_DIR"] = dataDir;
  await ensureDataDirectories();

  // Create initial files
  for (const [path, content] of Object.entries(initialFiles)) {
    const fullPath = join(workDir, path);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (dir !== workDir) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(fullPath, content);
  }

  // Initialize git repo
  await Bun.$`git init -b main ${workDir}`.quiet();
  await Bun.$`git -C ${workDir} config user.email "test@test.com"`.quiet();
  await Bun.$`git -C ${workDir} config user.name "Test User"`.quiet();
  await writeFile(join(workDir, "README.md"), "# Test Project\n");
  await Bun.$`git -C ${workDir} add .`.quiet();
  await Bun.$`git -C ${workDir} commit -m "Initial commit"`.quiet();
  const defaultBranchResult = await Bun.$`git -C ${workDir} branch --show-current`.quiet();
  const defaultBranch = defaultBranchResult.text().trim() || "main";

  // Create .clanky-planning directory if requested
  if (withPlanningDir) {
    const planningDir = join(workDir, ".clanky-planning");
    await mkdir(planningDir, { recursive: true });
    await writeFile(join(planningDir, "plan.md"), "# Plan\n\nThis is the plan.");
    await writeFile(join(planningDir, "status.md"), "# Status\n\nIn progress.");
    await Bun.$`git -C ${workDir} add .`.quiet();
    await Bun.$`git -C ${workDir} commit -m "Add planning files"`.quiet();
  }

  // Create local git remote if requested
  let remoteDir: string | undefined;
  if (withRemote) {
    remoteDir = await realpath(await mkdtemp(join(tmpdir(), "clanky-scenario-remote-")));
    await Bun.$`git init --bare ${remoteDir}`.quiet();
    await Bun.$`git -C ${workDir} remote add origin ${remoteDir}`.quiet();
    await Bun.$`git -C ${workDir} push -u origin ${defaultBranch}`.quiet();
    // Set bare repo HEAD to the pushed branch so clones work regardless of git defaults
    await Bun.$`git --git-dir=${remoteDir} symbolic-ref HEAD refs/heads/${defaultBranch}`.quiet();
  }

  // Reset task manager to clear any stale engines from previous tests
  taskManager.resetForTesting();

  // Set up mock backend
  const mockBackend = new ConfigurableMockBackend(mockResponses);
  backendManager.setBackendForTesting(mockBackend);
  backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

  // Start test server
  const server = serve({
    port: 0, // Random available port
    routes: {
      ...apiRoutes,
    },
  });

  const baseUrl = server.url.toString().replace(/\/$/, "");

  // Create a default workspace for the test work directory
  const workspaceId = await getOrCreateWorkspace(baseUrl, workDir, "Test Workspace");

  return {
    dataDir,
    workDir,
    defaultBranch,
    server,
    baseUrl,
    mockBackend,
    remoteDir,
    workspaceId,
  };
}

/**
 * Clean up a test server context.
 */
export async function teardownTestServer(ctx?: TestServerContext | null): Promise<void> {
  if (!ctx) {
    return;
  }

  // Stop server
  ctx.server?.stop(true);

  // Reset task manager (clear engines map)
  taskManager.resetForTesting();

  // Reset backend manager
  backendManager.resetForTesting();

  // Close database
  closeDatabase();

  // Clean up env
  delete process.env["CLANKY_DATA_DIR"];

  // Remove temp directories
  await rm(ctx.dataDir, { recursive: true, force: true });
  await rm(ctx.workDir, { recursive: true, force: true });
  if (ctx.remoteDir) {
    await rm(ctx.remoteDir, { recursive: true, force: true });
  }
}

/**
 * Get or create a workspace for a directory.
 * Returns the workspace ID.
 */
export async function getOrCreateWorkspace(
  baseUrl: string,
  directory: string,
  name?: string
): Promise<string> {
  const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: name || directory.split("/").pop() || "Test",
      directory,
      serverSettings: { agent: { provider: "opencode", transport: "stdio" } },
    }),
  });
  const data = await createResponse.json();

  if (createResponse.status === 409 && data.existingWorkspace) {
    return data.existingWorkspace.id;
  }

  if (createResponse.ok && data.id) {
    return data.id;
  }

  throw new Error(`Failed to create workspace: ${JSON.stringify(data)}`);
}

/**
 * Default test model for API-based task creation.
 */
export const testModelForAPI = {
  providerID: "test-provider",
  modelID: "test-model",
  variant: "",
};

let testTaskNameCounter = 0;

/**
 * Create a task via the API.
 */
export async function createTaskViaAPI(
  baseUrl: string,
  options: {
    directory: string;
    name?: string;
    prompt: string;
    planMode: boolean;
    useWorktree?: boolean;
    model?: { providerID: string; modelID: string; variant?: string };
    maxIterations?: number;
    clearPlanningFolder?: boolean;
    autoAcceptPlan?: boolean;
    fullyAutonomous?: boolean;
    baseBranch?: string;
  }
): Promise<{ status: number; body: Task | { error: string; message: string } }> {
  // First, get or create a workspace for the directory
  const workspaceId = await getOrCreateWorkspace(baseUrl, options.directory);

  // Now create the task with workspaceId instead of directory
  const { directory: _directory, ...restOptions } = options;
  
  // Use provided model or default test model
  const model = restOptions.model || testModelForAPI;
  
  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...restOptions,
      name: restOptions.name ?? `Test Task ${++testTaskNameCounter}`,
      workspaceId,
      model,
      attachments: [],
      cheapModel: { mode: "same-as-task" },
      maxIterations: restOptions.maxIterations ?? null,
      maxConsecutiveErrors: 10,
      activityTimeoutSeconds: 300,
      stopPattern: "<promise>COMPLETE</promise>$",
      git: {
        branchPrefix: "",
        commitScope: "",
      },
      baseBranch: restOptions.baseBranch ?? "main",
      clearPlanningFolder: restOptions.clearPlanningFolder ?? false,
      autoAcceptPlan: restOptions.autoAcceptPlan ?? (restOptions.planMode ? true : false),
      fullyAutonomous: restOptions.fullyAutonomous ?? false,
      draft: false,
      useWorktree: restOptions.useWorktree ?? true,
    }),
  });

  const body = await response.json();
  return { status: response.status, body };
}

/**
 * Get a task via the API.
 */
export async function getTaskViaAPI(
  baseUrl: string,
  taskId: string
): Promise<{ status: number; body: Task | { error: string; message: string } }> {
  const response = await fetch(`${baseUrl}/api/tasks/${taskId}`);
  const body = await response.json();
  return { status: response.status, body };
}

/**
 * Wait for a task to reach a specific status.
 */
export async function waitForTaskStatus(
  baseUrl: string,
  taskId: string,
  expectedStatus: string | string[],
  timeoutMs = 15000
): Promise<Task> {
  const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const startTime = Date.now();
  let lastStatus = "";
  let lastTask: Task | null = null;

  while (Date.now() - startTime < timeoutMs) {
    const { status, body } = await getTaskViaAPI(baseUrl, taskId);
    if (status === 200) {
      const task = body as Task;
      lastTask = task;
      lastStatus = task.state?.status ?? "no state";
      if (statuses.includes(task.state.status)) {
        return task;
      }
    } else {
      lastStatus = `HTTP ${status}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Task ${taskId} did not reach status [${statuses.join(", ")}] within ${timeoutMs}ms. Last status: ${lastStatus}${lastTask?.state?.error ? `, error: ${lastTask.state.error.message}` : ""}`
  );
}

export async function waitForTaskCondition(
  baseUrl: string,
  taskId: string,
  predicate: (task: Task) => boolean,
  description: string,
  timeoutMs = 15000,
): Promise<Task> {
  const startTime = Date.now();
  let lastStatus = "";
  let lastTask: Task | null = null;

  while (Date.now() - startTime < timeoutMs) {
    const { status, body } = await getTaskViaAPI(baseUrl, taskId);
    if (status === 200) {
      const task = body as Task;
      lastTask = task;
      lastStatus = task.state?.status ?? "no state";
      if (predicate(task)) {
        return task;
      }
    } else {
      lastStatus = `HTTP ${status}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Task ${taskId} did not satisfy condition "${description}" within ${timeoutMs}ms. Last status: ${lastStatus}${lastTask?.state?.error ? `, error: ${lastTask.state.error.message}` : ""}`,
  );
}

/**
 * Wait for a plan to be ready (isPlanReady = true).
 */
export async function waitForPlanReady(
  baseUrl: string,
  taskId: string,
  timeoutMs = 15000
): Promise<Task> {
  const startTime = Date.now();
  let lastIsPlanReady: boolean | undefined;
  let lastTask: Task | null = null;

  while (Date.now() - startTime < timeoutMs) {
    const { status, body } = await getTaskViaAPI(baseUrl, taskId);
    if (status === 200) {
      const task = body as Task;
      lastTask = task;
      lastIsPlanReady = task.state.planMode?.isPlanReady;
      if (lastIsPlanReady === true) {
        return task;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Task ${taskId} plan did not become ready within ${timeoutMs}ms. Last isPlanReady: ${lastIsPlanReady}, status: ${lastTask?.state.status}`
  );
}

/**
 * Accept a task via the API.
 */
export async function acceptTaskViaAPI(
  baseUrl: string,
  taskId: string
): Promise<{ status: number; body: { success: boolean; error?: string; message?: string } }> {
  const response = await fetch(`${baseUrl}/api/tasks/${taskId}/accept`, {
    method: "POST",
  });
  const body = await response.json();
  return { status: response.status, body };
}

/**
 * Push a task via the API.
 */
export async function pushTaskViaAPI(
  baseUrl: string,
  taskId: string
): Promise<{ status: number; body: { success: boolean; remoteBranch?: string; syncStatus?: string; error?: string; message?: string } }> {
  const response = await fetch(`${baseUrl}/api/tasks/${taskId}/push`, {
    method: "POST",
  });
  const body = await response.json();
  return { status: response.status, body };
}

/**
 * Update branch (sync with base) for a pushed task via the API.
 */
export async function updateBranchViaAPI(
  baseUrl: string,
  taskId: string
): Promise<{ status: number; body: { success: boolean; remoteBranch?: string; syncStatus?: string; error?: string; message?: string } }> {
  const response = await fetch(`${baseUrl}/api/tasks/${taskId}/update-branch`, {
    method: "POST",
  });
  const body = await response.json();
  return { status: response.status, body };
}

/**
 * Discard a task via the API.
 */
export async function discardTaskViaAPI(
  baseUrl: string,
  taskId: string
): Promise<{ status: number; body: { success: boolean; error?: string; message?: string } }> {
  const response = await fetch(`${baseUrl}/api/tasks/${taskId}/discard`, {
    method: "POST",
  });
  const body = await response.json();
  return { status: response.status, body };
}

/**
 * Send plan feedback via the API.
 */
export async function sendPlanFeedbackViaAPI(
  baseUrl: string,
  taskId: string,
  feedback: string
): Promise<{ status: number; body: { success: boolean; error?: string; message?: string } }> {
  const response = await fetch(`${baseUrl}/api/tasks/${taskId}/plan/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ feedback, attachments: [] }),
  });
  const body = await response.json();
  return { status: response.status, body };
}

/**
 * Accept a plan via the API.
 */
export async function acceptPlanViaAPI(
  baseUrl: string,
  taskId: string
): Promise<{ status: number; body: { success: boolean; error?: string; message?: string } }> {
  const response = await fetch(`${baseUrl}/api/tasks/${taskId}/plan/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "start_task" }),
  });
  const body = await response.json();
  return { status: response.status, body };
}

/**
 * Discard a plan via the API.
 */
export async function discardPlanViaAPI(
  baseUrl: string,
  taskId: string
): Promise<{ status: number; body: { success: boolean; error?: string; message?: string } }> {
  const response = await fetch(`${baseUrl}/api/tasks/${taskId}/plan/discard`, {
    method: "POST",
  });
  const body = await response.json();
  return { status: response.status, body };
}

/**
 * Get the diff for a task via the API.
 */
export async function getTaskDiffViaAPI(
  baseUrl: string,
  taskId: string
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/api/tasks/${taskId}/diff`);
  const body = await response.json();
  return { status: response.status, body };
}

/**
 * Get the plan content for a task via the API.
 */
export async function getTaskPlanViaAPI(
  baseUrl: string,
  taskId: string
): Promise<{ status: number; body: { content: string; exists: boolean } | { error: string; message: string } }> {
  const response = await fetch(`${baseUrl}/api/tasks/${taskId}/plan`);
  const body = await response.json();
  return { status: response.status, body };
}

/**
 * Get the status file content for a task via the API.
 */
export async function getTaskStatusFileViaAPI(
  baseUrl: string,
  taskId: string
): Promise<{ status: number; body: { content: string; exists: boolean } | { error: string; message: string } }> {
  const response = await fetch(`${baseUrl}/api/tasks/${taskId}/status-file`);
  const body = await response.json();
  return { status: response.status, body };
}

/**
 * Get the current git branch in a directory.
 */
export async function getCurrentBranch(workDir: string): Promise<string> {
  const result = await Bun.$`git -C ${workDir} rev-parse --abbrev-ref HEAD`.quiet();
  return result.stdout.toString().trim();
}

/**
 * Wait for git to be available (no lock file).
 * This helps prevent race conditions between tests that share a working directory.
 */
export async function waitForGitAvailable(workDir: string, timeoutMs = 5000): Promise<void> {
  const startTime = Date.now();
  const lockFile = join(workDir, ".git/index.lock");
  
  while (Date.now() - startTime < timeoutMs) {
    const lockExists = await Bun.file(lockFile).exists();
    if (!lockExists) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  
  // If we get here, try to remove the stale lock file
  try {
    await rm(lockFile, { force: true });
  } catch {
    // Ignore errors removing lock file
  }
}

/**
 * Check if a branch exists in a directory.
 */
export async function branchExists(workDir: string, branchName: string): Promise<boolean> {
  try {
    const result = await Bun.$`git -C ${workDir} show-ref --verify --quiet refs/heads/${branchName}`.nothrow();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check if a branch exists on a remote.
 */
export async function remoteBranchExists(workDir: string, branchName: string, remote = "origin"): Promise<boolean> {
  try {
    // Fetch first to update remote refs
    await Bun.$`git -C ${workDir} fetch ${remote}`.nothrow();
    const result = await Bun.$`git -C ${workDir} show-ref --verify --quiet refs/remotes/${remote}/${branchName}`.nothrow();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Validate task state for UI display.
 * Returns an array of validation errors, or empty array if valid.
 */
export function validateTaskState(task: Task, expectations: {
  status?: string;
  iterationCount?: number;
  hasGitBranch?: boolean;
  hasError?: boolean;
  planMode?: {
    active?: boolean;
    feedbackRounds?: number;
  };
}): string[] {
  const errors: string[] = [];

  if (expectations.status !== undefined && task.state.status !== expectations.status) {
    errors.push(`Expected status "${expectations.status}" but got "${task.state.status}"`);
  }

  if (expectations.iterationCount !== undefined && task.state.currentIteration !== expectations.iterationCount) {
    errors.push(`Expected ${expectations.iterationCount} iterations but got ${task.state.currentIteration}`);
  }

  if (expectations.hasGitBranch !== undefined) {
    const hasGit = !!task.state.git?.workingBranch;
    if (expectations.hasGitBranch !== hasGit) {
      errors.push(`Expected hasGitBranch=${expectations.hasGitBranch} but got ${hasGit}`);
    }
  }

  if (expectations.hasError !== undefined) {
    const hasError = !!task.state.error;
    if (expectations.hasError !== hasError) {
      errors.push(`Expected hasError=${expectations.hasError} but got ${hasError}`);
    }
  }

  if (expectations.planMode !== undefined) {
    if (expectations.planMode.active !== undefined) {
      const active = task.state.planMode?.active ?? false;
      if (expectations.planMode.active !== active) {
        errors.push(`Expected planMode.active=${expectations.planMode.active} but got ${active}`);
      }
    }
    if (expectations.planMode.feedbackRounds !== undefined) {
      const rounds = task.state.planMode?.feedbackRounds ?? 0;
      if (expectations.planMode.feedbackRounds !== rounds) {
        errors.push(`Expected planMode.feedbackRounds=${expectations.planMode.feedbackRounds} but got ${rounds}`);
      }
    }
  }

  return errors;
}

/**
 * Assert task state matches expectations.
 * Throws if validation fails.
 */
export function assertTaskState(task: Task, expectations: Parameters<typeof validateTaskState>[1]): void {
  const errors = validateTaskState(task, expectations);
  if (errors.length > 0) {
    throw new Error(`Task state validation failed:\n${errors.join("\n")}`);
  }
}
