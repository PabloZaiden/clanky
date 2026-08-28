/**
 * Test setup and utilities for Clanky Tasks Management System.
 */

import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { AcpBackend } from "../src/backends/acp";
import { SimpleEventEmitter } from "../src/core/event-emitter";
import { GitService } from "../src/core/git";
import { TaskManager } from "../src/core/task-manager";
import { backendManager } from "../src/core/backend-manager";
import { initializeDatabase } from "../src/persistence/database";
import { closeDatabase, getDatabase } from "../src/persistence/database";
import { createWorkspace } from "../src/persistence/workspaces";
import { loadTask } from "../src/persistence/tasks";
import { TestCommandExecutor } from "./mocks/mock-executor";
import { MockAcpBackend, defaultTestModel } from "./mocks/mock-backend";
import type { TaskEvent } from "@/shared/events";
import { getDefaultServerSettings } from "@/shared/settings";
import { runWithCurrentUser } from "../src/core/user-context";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import { initializeGitRepository } from "./helpers/git-fixtures";
import { pollUntil } from "./helpers/polling";

/**
 * Default test workspace ID that can be used in tests.
 * This workspace is automatically created by setupTestContext().
 */
export const testWorkspaceId = "test-workspace-id";

/**
 * Default test model configuration for task creation.
 * Use this in tests to satisfy the required model field.
 */
export const testModel = {
  providerID: "test-provider",
  modelID: "test-model",
  variant: "",
};

/**
 * Default test model fields for CreateTaskOptions.
 * Use spread operator: { ...testModelFields, ... }
 */
export const testModelFields = {
  modelProviderID: testModel.providerID,
  modelID: testModel.modelID,
  modelVariant: testModel.variant,
};

export const testOwnerUser: CurrentUser = {
  id: "admin",
  username: "admin",
  role: "owner",
  isOwner: true,
  isAdmin: true,
};

export function seedTestOwnerUser(): void {
  const now = new Date().toISOString();
  getDatabase()
    .query(`
      INSERT OR IGNORE INTO webapp_users (id, username, role, auth_version, created_at, updated_at, last_login_at, disabled_at)
      VALUES (?, ?, ?, 1, ?, ?, NULL, NULL)
    `)
    .run(testOwnerUser.id, testOwnerUser.username, testOwnerUser.role, now, now);
}

/**
 * Test context containing all test dependencies.
 */
export interface TestContext {
  /** Temporary data directory for persistence */
  dataDir: string;
  /** Temporary working directory (simulates a project) */
  workDir: string;
  /** Event emitter for task events */
  emitter: SimpleEventEmitter<TaskEvent>;
  /** Collected events for assertions */
  events: TaskEvent[];
  /** Git service instance */
  git: GitService;
  /** Task manager instance */
  manager: TaskManager;
  /** Mock backend instance (if using mock) */
  mockBackend?: MockAcpBackend;
  /** Original CLANKY_MOCK_ACP env value before test setup */
  originalMockAcpEnv?: string;
}

/**
 * Options for setting up a test context.
 */
export interface SetupOptions {
  /** Use mock backend (default: true) */
  useMockBackend?: boolean;
  /** Use the process-backed mock ACP runtime instead of the in-memory backend */
  useMockAcpProcess?: boolean;
  /** Mock backend responses */
  mockResponses?: string[];
  /** Initialize git in work directory (default: false) */
  initGit?: boolean;
  /** Create initial files in work directory */
  initialFiles?: Record<string, string>;
}

/**
 * Set up a test context with all dependencies.
 */
export async function setupTestContext(options: SetupOptions = {}): Promise<TestContext> {
  const {
    useMockBackend = true,
    useMockAcpProcess = false,
    mockResponses = ["<promise>COMPLETE</promise>"],
    initGit = false,
    initialFiles = {},
  } = options;

  // Create temp directories
  const dataDir = await mkdtemp(join(tmpdir(), "clanky-test-data-"));
  const workDir = await mkdtemp(join(tmpdir(), "clanky-test-work-"));

  // Start every test context from a fresh database connection so suite-order
  // leaks from earlier tests cannot leave persistence pointed at another temp dir.
  closeDatabase();

  // Set env var for persistence
  process.env["CLANKY_DATA_DIR"] = dataDir;
  await initializeDatabase();
  seedTestOwnerUser();

  // Create the default test workspace (required for tasks with workspaceId)
  await runWithCurrentUser(testOwnerUser, () => createWorkspace({
    id: testWorkspaceId,
    name: "Test Workspace",
    directory: workDir,
    workspaceType: "git",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    serverSettings: getDefaultServerSettings(),
  }));

  // Create initial files
  for (const [path, content] of Object.entries(initialFiles)) {
    const fullPath = join(workDir, path);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (dir !== workDir) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(fullPath, content);
  }

  // Initialize git if requested
  const executor = new TestCommandExecutor();
  const git = new GitService(executor);
  if (initGit) {
    await initializeGitRepository(workDir, {
      initialCommit: "all",
      initialFiles: { ".gitkeep": "", ...initialFiles },
    });
  }

  // Set up event emitter
  const events: TaskEvent[] = [];
  const emitter = new SimpleEventEmitter<TaskEvent>();
  emitter.subscribe((event) => events.push(event));

  // Register mock backend if requested
  let mockBackend: MockAcpBackend | undefined;
  const originalMockAcpEnv = process.env["CLANKY_MOCK_ACP"];
  if (useMockAcpProcess) {
    process.env["CLANKY_MOCK_ACP"] = "true";
    backendManager.setBackendForTesting(new AcpBackend());
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
  } else if (useMockBackend) {
    mockBackend = new MockAcpBackend({ 
      responses: mockResponses,
      models: [defaultTestModel],
    });
    backendManager.setBackendForTesting(mockBackend);
    // Set the executor factory for testing (uses local Bun.$ execution)
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
  }

  // Create manager
  const manager = new TaskManager({
    eventEmitter: emitter,
  });

  return {
    dataDir,
    workDir,
    emitter,
    events,
    git,
    manager,
    mockBackend,
    originalMockAcpEnv,
  };
}

/**
 * Clean up a test context.
 */
export async function teardownTestContext(ctx: TestContext): Promise<void> {
  // Shutdown manager
  await ctx.manager.shutdown();

  // Reset global backend manager
  backendManager.resetForTesting();

  // Close the database connection
  closeDatabase();

  // Clean up env
  delete process.env["CLANKY_DATA_DIR"];
  if (ctx.originalMockAcpEnv === undefined) {
    delete process.env["CLANKY_MOCK_ACP"];
  } else {
    process.env["CLANKY_MOCK_ACP"] = ctx.originalMockAcpEnv;
  }

  // Remove temp directories (force: true ignores ENOENT if already deleted)
  await rm(ctx.dataDir, { recursive: true, force: true });
  await rm(ctx.workDir, { recursive: true, force: true });
}

/**
 * Wait for a specific event type to be emitted.
 */
export function waitForEvent<T extends TaskEvent["type"]>(
  events: TaskEvent[],
  eventType: T,
  timeout = 5000,
): Promise<Extract<TaskEvent, { type: T }>> {
  return pollUntil(
    () => events.find((event): event is Extract<TaskEvent, { type: T }> => event.type === eventType),
    (event): event is Extract<TaskEvent, { type: T }> => event !== undefined,
    {
      description: `event ${eventType}`,
      timeoutMs: timeout,
      formatLastObserved: (event) => event === undefined ? "none" : JSON.stringify(event) ?? "unserializable event",
    },
  );
}

/**
 * Wait for an event matching a predicate.
 */
export function waitForEventMatching<T extends TaskEvent>(
  events: TaskEvent[],
  predicate: (event: TaskEvent) => event is T,
  timeout = 5000,
): Promise<T> {
  return pollUntil(
    () => events.find(predicate),
    (event): event is T => event !== undefined,
    {
      description: "a matching event",
      timeoutMs: timeout,
      formatLastObserved: (event) => event === undefined ? "none" : JSON.stringify(event) ?? "unserializable event",
    },
  );
}

/**
 * Count events of a specific type.
 */
export function countEvents(events: TaskEvent[], eventType: TaskEvent["type"]): number {
  return events.filter((e) => e.type === eventType).length;
}

/**
 * Get all events of a specific type.
 */
export function getEvents<T extends TaskEvent["type"]>(
  events: TaskEvent[],
  eventType: T,
): Extract<TaskEvent, { type: T }>[] {
  return events.filter((e) => e.type === eventType) as Extract<TaskEvent, { type: T }>[];
}

/**
 * Delay helper for tests.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until a task reaches expected status (via TaskManager).
 */
export async function waitForTaskStatus(
  manager: TaskManager,
  taskId: string,
  expectedStatuses: string[],
  timeoutMs = 10000
): Promise<import("@/shared").Task> {
  return pollUntil(
    () => manager.getTask(taskId),
    (task): task is import("@/shared").Task =>
      task !== null && expectedStatuses.includes(task.state?.status ?? "unknown"),
    {
      description: `task ${taskId} to reach status [${expectedStatuses.join(", ")}]`,
      timeoutMs,
      formatLastObserved: (task) => task === null ? "not found" : `status=${task.state?.status ?? "unknown"}`,
    },
  );
}

/**
 * Poll until isPlanReady becomes true (via TaskManager).
 */
export async function waitForPlanReady(
  manager: TaskManager,
  taskId: string,
  timeoutMs = 10000
): Promise<import("@/shared").Task> {
  return pollUntil(
    () => manager.getTask(taskId),
    (task): task is import("@/shared").Task => task?.state.planMode?.isPlanReady === true,
    {
      description: `plan for task ${taskId} to become ready`,
      timeoutMs,
      formatLastObserved: (task) => task === null
        ? "not found"
        : `isPlanReady=${task.state.planMode?.isPlanReady}, status=${task.state.status}`,
    },
  );
}

/**
 * Poll until isPlanReady is persisted to the database (via loadTask).
 * Unlike waitForPlanReady() which reads in-memory state, this reads directly
 * from the persistence layer to ensure the plan-ready state has been flushed
 * to disk. Use this before resetForTesting() to ensure recovery tests can
 * load the persisted state reliably.
 */
export async function waitForPersistedPlanReady(
  taskId: string,
  timeoutMs = 10000
): Promise<import("@/shared").Task> {
  return pollUntil(
    () => loadTask(taskId),
    (task): task is import("@/shared").Task => task?.state.planMode?.isPlanReady === true,
    {
      description: `plan for task ${taskId} to be persisted as ready`,
      timeoutMs,
      formatLastObserved: (task) => task === null
        ? "not found"
        : `isPlanReady=${task.state.planMode?.isPlanReady}, status=${task.state.status}`,
    },
  );
}

/**
 * Poll until file no longer exists.
 */
export async function waitForFileDeleted(filePath: string, timeoutMs = 5000): Promise<void> {
  await pollUntil(
    () => Bun.file(filePath).exists(),
    (exists) => !exists,
    {
      description: `file ${filePath} to be deleted`,
      timeoutMs,
      formatLastObserved: (exists) => exists ? "present" : "absent",
    },
  );
}

/**
 * Poll until file exists.
 */
export async function waitForFileExists(filePath: string, timeoutMs = 5000): Promise<void> {
  await pollUntil(
    () => Bun.file(filePath).exists(),
    (exists) => exists,
    {
      description: `file ${filePath} to exist`,
      timeoutMs,
      formatLastObserved: (exists) => exists ? "present" : "absent",
    },
  );
}
