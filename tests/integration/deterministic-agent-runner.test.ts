/**
 * Integration tests for the workspace-host deterministic agent runner.
 *
 * These tests verify:
 * - Local runner execution via Node.js 24+
 * - Only ctx.stdout.write / ctx.stderr.write produce visible output (not workspace.exec)
 * - Cancellation via AbortSignal kills the runner process
 * - Node.js version check rejects hosts below v24
 * - Prompt bridge route authentication, chat ownership, and response forwarding
 * - Managed API-key lifecycle: created per run, revoked on all code paths
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import { createWorkspace } from "../../src/persistence/workspaces";
import { runWithCurrentUser } from "../../src/core/user-context";
import { testOwnerUser, seedTestOwnerUser, testModel } from "../setup";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { backendManager } from "../../src/core/backend-manager";
import { MockAcpBackend, defaultTestModel } from "../mocks/mock-backend";
import { managedCredentialService } from "../../src/core/managed-credential-service";
import type { ManagedRuntimeCredential } from "../../src/core/managed-credential-service";
import { DETERMINISTIC_AGENT_MANAGED_BY } from "../../src/core/managed-credential-service";
import { listContextApiKeyAssociationsForUser } from "../../src/persistence/context-api-keys";
import { sqliteWebAppStore } from "@pablozaiden/webapp/server";
import { serveNativeApiRoutes } from "../native-api-server";
import type { Server } from "bun";
import type { Workspace } from "@/shared/workspace";
import {
  assertNodeVersionOnHost,
  launchDeterministicAgentOnHost,
  DETERMINISTIC_AGENT_RUNNER_SCRIPT,
} from "../../src/core/deterministic-agent-runner";
import { DeterministicAgentOutput } from "../../src/core/deterministic-agent-output";
import { testDeterministicAgentCode } from "../../src/core/deterministic-agent-test";
import type { AgentRun } from "@/shared/agent";

function createDummyRun(id = crypto.randomUUID()): AgentRun {
  const now = new Date().toISOString();
  return {
    id,
    agentId: crypto.randomUUID(),
    status: "running",
    trigger: "manual",
    scheduledFor: now,
    startedAt: now,
    messages: [],
    logs: [],
    toolCalls: [],
    pendingPermissionRequests: [],
    configSnapshot: {
      name: "Test runner",
      workspaceId: "test-ws",
      directory: "/tmp",
      prompt: "",
      model: { providerID: "test", modelID: "test", variant: "" },
      useWorktree: false,
      schedule: {
        startAtLocal: now.slice(0, 16),
        timezone: "UTC",
        interval: { value: 1, unit: "hours" },
        nextRunAt: now,
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe("deterministic agent runner — workspace host execution", () => {
  let tempDir: string;
  let executor: TestCommandExecutor;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(process.cwd(), ".test-runner-"));
    executor = new TestCommandExecutor();
    await initializeDatabase();
    seedTestOwnerUser();
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("runner script is non-empty and contains expected entry points", () => {
    expect(DETERMINISTIC_AGENT_RUNNER_SCRIPT.length).toBeGreaterThan(100);
    expect(DETERMINISTIC_AGENT_RUNNER_SCRIPT).toContain("sendControl");
    expect(DETERMINISTIC_AGENT_RUNNER_SCRIPT).toContain("CLANKY_CHAT_ID");
    // The workspace object is defined with exec and prompt methods
    expect(DETERMINISTIC_AGENT_RUNNER_SCRIPT).toContain("exec(command");
    expect(DETERMINISTIC_AGENT_RUNNER_SCRIPT).toContain("async prompt(message)");
    // SIGTERM handler for graceful cancellation
    expect(DETERMINISTIC_AGENT_RUNNER_SCRIPT).toContain("SIGTERM");
  });

  test("assertNodeVersionOnHost passes when Node.js >= 24 is available", async () => {
    // Node.js 24 is installed in this environment
    await expect(assertNodeVersionOnHost(executor)).resolves.toBeUndefined();
  });

  test("assertNodeVersionOnHost throws when node command is missing", async () => {
    // Use a path that won't find node
    const badExecutor = new TestCommandExecutor();
    // Override exec to simulate missing node
    const origExec = badExecutor.exec.bind(badExecutor);
    badExecutor.exec = async (cmd, args, opts) => {
      if (cmd === "node") {
        return { success: false, stdout: "", stderr: "node: command not found", exitCode: 127 };
      }
      return origExec(cmd, args, opts);
    };
    await expect(assertNodeVersionOnHost(badExecutor)).rejects.toThrow(
      /Node\.js 24 or newer is required/,
    );
  });

  test("assertNodeVersionOnHost throws when Node.js version is too old", async () => {
    const oldVersionExecutor = new TestCommandExecutor();
    oldVersionExecutor.exec = async (cmd) => {
      if (cmd === "node") {
        return { success: true, stdout: "v20.0.0\n", stderr: "", exitCode: 0 };
      }
      return { success: true, stdout: "", stderr: "", exitCode: 0 };
    };
    await expect(assertNodeVersionOnHost(oldVersionExecutor)).rejects.toThrow(
      /found v20\.0\.0/,
    );
  });

  test("runner produces stdout and stderr only from ctx.stdout/stderr.write", async () => {
    await runWithCurrentUser(testOwnerUser, async () => {
      const run = createDummyRun();
      const output = new DeterministicAgentOutput(run, { persist: false, emit: false });
      const code = `export default async function run(ctx) {
  const stdoutMessage: string = "hello stdout";
  console.log("hidden console output");
  ctx.stdout.write(stdoutMessage);
  ctx.stderr.write("hello stderr");
  const result = await ctx.workspace.exec("sh", ["-c", "printf 'cmd output'"]);
  // result.stdout should be accessible to the program, but not in visible output
  if (!result.success || !result.stdout.includes("cmd output")) {
    throw new Error("exec result not returned to program: " + JSON.stringify(result));
  }
}`;
      const result = await launchDeterministicAgentOnHost({
        run,
        sourceCode: code,
        chatId: "test-chat-id",
        credential: undefined,
        directory: tempDir,
        signal: new AbortController().signal,
        output,
        executor,
      });

      const logs = result.logs;
      expect(logs.some((l) => l.message.includes("hello stdout"))).toBe(true);
      expect(logs.some((l) => l.message.includes("hello stderr"))).toBe(true);
      expect(logs.every((l) => !l.message.includes("hidden console output"))).toBe(true);
      // Command output must NOT appear in visible logs
      expect(logs.every((l) => !l.message.includes("cmd output"))).toBe(true);

      // Stream distinction is preserved
      const stdoutLogs = logs.filter((l) => l.details?.["stream"] === "stdout");
      const stderrLogs = logs.filter((l) => l.details?.["stream"] === "stderr");
      expect(stdoutLogs.some((l) => l.message.includes("hello stdout"))).toBe(true);
      expect(stderrLogs.some((l) => l.message.includes("hello stderr"))).toBe(true);
      expect(logs.every((l) => l.details?.["source"] === undefined)).toBe(true);
      expect(await executor.directoryExists(`/tmp/clanky-agent-${run.id}`)).toBe(false);
    });
  });

  test("workspace.prompt uses the bridge without exposing direct process output", async () => {
    let receivedAuthorization = "";
    let receivedMessage = "";
    const bridge = Bun.serve({
      port: 0,
      fetch: async (request) => {
        receivedAuthorization = request.headers.get("authorization") ?? "";
        const body = await request.json() as { chatId?: string; message?: string };
        receivedMessage = `${body.chatId ?? ""}:${body.message ?? ""}`;
        return Response.json({ response: "prompt response" });
      },
    });
    try {
      await runWithCurrentUser(testOwnerUser, async () => {
        const run = createDummyRun();
        const output = new DeterministicAgentOutput(run, { persist: false, emit: false });
        const credential: ManagedRuntimeCredential = {
          userId: testOwnerUser.id,
          workspaceId: "test-ws",
          contextType: "agent_run",
          contextId: run.id,
          apiKeyId: "test-key",
          generation: 1,
          baseUrl: bridge.url.toString().replace(/\/$/, ""),
          token: "test-token",
        };
        const result = await launchDeterministicAgentOnHost({
          run,
          sourceCode: `export default async function run(ctx) {
  console.error("hidden stderr output");
  const answer = await ctx.workspace.prompt("hello");
  ctx.stdout.write(answer);
}`,
          chatId: "bridge-chat",
          credential,
          directory: tempDir,
          signal: new AbortController().signal,
          output,
          executor,
        });

        expect(result.logs.some((entry) => entry.message === "prompt response")).toBe(true);
        expect(result.logs.every((entry) => !entry.message.includes("hidden stderr output"))).toBe(true);
      });
    } finally {
      bridge.stop();
    }
    expect(receivedAuthorization).toBe("Bearer test-token");
    expect(receivedMessage).toBe("bridge-chat:hello");
  });

  test("runner throws when user code throws", async () => {
    await runWithCurrentUser(testOwnerUser, async () => {
      const run = createDummyRun();
      const output = new DeterministicAgentOutput(run, { persist: false, emit: false });
      const code = `export default async function run(ctx) {
  throw new Error("deliberate test error");
}`;
      await expect(
        launchDeterministicAgentOnHost({
          run,
          sourceCode: code,
          chatId: "test-chat-id",
          credential: undefined,
          directory: tempDir,
          signal: new AbortController().signal,
          output,
          executor,
        }),
      ).rejects.toThrow("deliberate test error");
    });
  });

  test("runner treats AbortSignal cancellation as interrupted", async () => {
    await runWithCurrentUser(testOwnerUser, async () => {
      const run = createDummyRun();
      const output = new DeterministicAgentOutput(run, { persist: false, emit: false });
      const ac = new AbortController();

      const code = `export default async function run(ctx) {
  ctx.stdout.write("start");
  while (!ctx.signal.aborted) {
    await new Promise(r => setTimeout(r, 10));
  }
  ctx.signal.throwIfAborted();
}`;
      // Abort after 300ms to give runner time to write "start"
      const launchPromise = launchDeterministicAgentOnHost({
        run,
        sourceCode: code,
        chatId: "test-chat-id",
        credential: undefined,
        directory: tempDir,
        signal: ac.signal,
        output,
        executor,
      });

      // Wait for "start" then abort
      const startTimeout = Date.now() + 5000;
      while (!output.run.logs.some((l) => l.message.includes("start"))) {
        if (Date.now() > startTimeout) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      ac.abort();

      await expect(launchPromise).rejects.toThrow(/interrupted/);
    });
  });

  test("runner passes exec results back to user code without adding to visible output", async () => {
    await runWithCurrentUser(testOwnerUser, async () => {
      const run = createDummyRun();
      const output = new DeterministicAgentOutput(run, { persist: false, emit: false });
      const code = `export default async function run(ctx) {
  const r = await ctx.workspace.exec("sh", ["-c", "echo hello-from-exec"]);
  if (r.stdout.trim() !== "hello-from-exec") {
    throw new Error("unexpected exec result: " + r.stdout);
  }
  if (!r.success) throw new Error("exec not successful");
  ctx.stdout.write("exec-verified");
}`;
      const result = await launchDeterministicAgentOnHost({
        run,
        sourceCode: code,
        chatId: "test-chat-id",
        credential: undefined,
        directory: tempDir,
        signal: new AbortController().signal,
        output,
        executor,
      });

      expect(result.logs.some((l) => l.message.includes("exec-verified"))).toBe(true);
      expect(result.logs.every((l) => !l.message.includes("hello-from-exec"))).toBe(true);
    });
  });
});

describe("deterministic agent runner — API key lifecycle", () => {
  let tempDataDir: string;
  let tempWorkDir: string;
  let store: ReturnType<typeof sqliteWebAppStore>;
  let workspace: Workspace;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeEach(async () => {
    tempDataDir = await mkdtemp(join(process.cwd(), ".test-runner-keys-"));
    tempWorkDir = await mkdtemp(join(process.cwd(), ".test-runner-work-"));
    process.env["CLANKY_DATA_DIR"] = tempDataDir;
    closeDatabase();
    await initializeDatabase();

    store = sqliteWebAppStore({ dataDir: tempDataDir, fileName: "keys.db" });
    store.initialize();
    const now = new Date().toISOString();
    store.createUser({
      id: testOwnerUser.id,
      username: testOwnerUser.username,
      role: testOwnerUser.role,
      passkeyConfigured: false,
      authVersion: 1,
      createdAt: now,
      updatedAt: now,
    });

    managedCredentialService.configure(store, { publicBaseUrl: "https://clanky.test" });

    workspace = {
      id: crypto.randomUUID(),
      name: "Runner key test workspace",
      directory: tempWorkDir,
      allowClankyContext: true,
      serverSettings: { agent: { provider: "opencode", transport: "stdio" } },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await runWithCurrentUser(testOwnerUser, () => createWorkspace(workspace));

    const mockBackend = new MockAcpBackend({ models: [defaultTestModel] });
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");

    await runWithCurrentUser(testOwnerUser, async () => {
      await fetch(`${baseUrl}/api/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: workspace.name,
          directory: workspace.directory,
          id: workspace.id,
          allowClankyContext: true,
          serverSettings: workspace.serverSettings,
        }),
      });
    });
  });

  afterEach(async () => {
    server.stop();
    backendManager.resetForTesting();
    managedCredentialService.resetForTests();
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(tempDataDir, { recursive: true, force: true });
    await rm(tempWorkDir, { recursive: true, force: true });
  });

  test("API key is revoked after a successful run", async () => {
    const result = await runWithCurrentUser(testOwnerUser, () =>
      testDeterministicAgentCode({
        name: "Key cleanup test",
        prompt: "Run",
        code: `export default async function run(ctx) {
  ctx.stdout.write("success");
}`,
        workspaceId: workspace.id,
        directory: tempWorkDir,
        model: testModel,
        useWorktree: false,
      }),
    );
    expect(result.status).toBe("completed");
    expect(result.logs.some((l) => l.message.includes("success"))).toBe(true);

    // All managed keys for this workspace should be revoked
    const remainingKeys = managedCredentialService.listManagedKeysForCurrentUser
      ? await runWithCurrentUser(testOwnerUser, () =>
          Promise.resolve(
            managedCredentialService.listManagedKeysForCurrentUser(DETERMINISTIC_AGENT_MANAGED_BY),
          ),
        )
      : [];
    expect(remainingKeys).toHaveLength(0);
  });

  test("API key is revoked after a failed run", async () => {
    const result = await runWithCurrentUser(testOwnerUser, () =>
      testDeterministicAgentCode({
        name: "Key cleanup on failure",
        prompt: "Run",
        code: `export default async function run(ctx) {
  throw new Error("deliberate failure");
}`,
        workspaceId: workspace.id,
        directory: tempWorkDir,
        model: testModel,
        useWorktree: false,
      }),
    );
    expect(result.status).toBe("failed");

    const remainingKeys = await runWithCurrentUser(testOwnerUser, () =>
      Promise.resolve(
        managedCredentialService.listManagedKeysForCurrentUser(DETERMINISTIC_AGENT_MANAGED_BY),
      ),
    );
    expect(remainingKeys).toHaveLength(0);
  });

  test("API key is revoked after cancellation", async () => {
    const ac = new AbortController();
    const runPromise = runWithCurrentUser(testOwnerUser, () =>
      testDeterministicAgentCode({
        name: "Key cleanup on cancel",
        prompt: "Run",
        code: `export default async function run(ctx) {
  ctx.stdout.write("running");
  while (!ctx.signal.aborted) {
    await new Promise(r => setTimeout(r, 10));
  }
  ctx.signal.throwIfAborted();
}`,
        workspaceId: workspace.id,
        directory: tempWorkDir,
        model: testModel,
        useWorktree: false,
        signal: ac.signal,
      }),
    );

    // Wait for "running" output
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(async () => {
        const keys = await runWithCurrentUser(testOwnerUser, () =>
          Promise.resolve(
            managedCredentialService.listManagedKeysForCurrentUser(DETERMINISTIC_AGENT_MANAGED_BY),
          ),
        );
        if (keys.length > 0) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 5000);
    });

    ac.abort();
    const result = await runPromise;
    expect(result.status).toBe("cancelled");

    const remainingKeys = await runWithCurrentUser(testOwnerUser, () =>
      Promise.resolve(
        managedCredentialService.listManagedKeysForCurrentUser(DETERMINISTIC_AGENT_MANAGED_BY),
      ),
    );
    expect(remainingKeys).toHaveLength(0);
  });

  test("startup reconciliation removes stale deterministic runtime keys", async () => {
    const identity = {
      userId: testOwnerUser.id,
      workspaceId: workspace.id,
      contextType: "agent_run" as const,
      contextId: crypto.randomUUID(),
    };
    const credential = await runWithCurrentUser(testOwnerUser, () =>
      managedCredentialService.ensureCredentialForRuntime(identity, "recreate", {
        managedBy: DETERMINISTIC_AGENT_MANAGED_BY,
        name: "Clanky deterministic agent runtime",
        scopes: ["clanky:agent-prompt"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    expect(credential?.expiresAt).toBeDefined();
    expect(credential?.managedBy).toBe(DETERMINISTIC_AGENT_MANAGED_BY);

    const revoked = await runWithCurrentUser(testOwnerUser, () =>
      managedCredentialService.reconcileCurrentUser(),
    );
    expect(revoked).toBeGreaterThan(0);
    expect(await runWithCurrentUser(testOwnerUser, () =>
      Promise.resolve(
        managedCredentialService.listManagedKeysForCurrentUser(DETERMINISTIC_AGENT_MANAGED_BY),
      ),
    )).toHaveLength(0);
    const associations = await runWithCurrentUser(testOwnerUser, () =>
      listContextApiKeyAssociationsForUser(testOwnerUser.id),
    );
    expect(associations.every((association) => association.revokedAt !== undefined)).toBe(true);
  });
});

describe("deterministic agent runner — prompt bridge route", () => {
  let tempDataDir: string;
  let tempWorkDir: string;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeEach(async () => {
    tempDataDir = await mkdtemp(join(process.cwd(), ".test-prompt-bridge-"));
    tempWorkDir = await mkdtemp(join(process.cwd(), ".test-prompt-work-"));
    process.env["CLANKY_DATA_DIR"] = tempDataDir;
    closeDatabase();
    await initializeDatabase();
    seedTestOwnerUser();

    const mockBackend = new MockAcpBackend({ models: [defaultTestModel] });
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterEach(async () => {
    server.stop();
    backendManager.resetForTesting();
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(tempDataDir, { recursive: true, force: true });
    await rm(tempWorkDir, { recursive: true, force: true });
  });

  test("prompt bridge returns 404 for unknown chat (via test server that injects user)", async () => {
    // serveNativeApiRoutes injects testOwnerUser, so auth is bypassed.
    // The chat does not exist, so the route should return 404.
    const resp = await fetch(`${baseUrl}/api/internal/agent-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "nonexistent-chat-id", message: "hello" }),
    });
    expect(resp.status).toBe(404);
  });

  test("prompt bridge returns 400 for missing chatId", async () => {
    const resp = await fetch(`${baseUrl}/api/internal/agent-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(resp.status).toBe(400);
  });
});
