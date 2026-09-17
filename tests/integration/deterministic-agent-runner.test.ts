/**
 * Integration tests for the workspace-host deterministic agent runner.
 *
 * These tests verify:
 * - Prompt bridge route behavior and response forwarding
 * - Managed API-key lifecycle: created per run, revoked on all code paths
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import { createWorkspace } from "../../src/persistence/workspaces";
import { runWithCurrentUser } from "../../src/core/user-context";
import {
  getTestLocalExecutionHostBinding,
  seedTestOwnerUser,
  testModel,
  testOwnerUser,
} from "../setup";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { backendManager } from "../../src/core/backend-manager";
import { MockAcpBackend, defaultTestModel } from "../mocks/mock-backend";
import { DETERMINISTIC_AGENT_MANAGED_BY, managedCredentialService } from "../../src/core/managed-credential-service";
import { pollUntil } from "../helpers/polling";
import { listContextApiKeyAssociationsForUser } from "../../src/persistence/context-api-keys";
import { sqliteWebAppStore } from "@pablozaiden/webapp/server";
import { serveNativeApiRoutes } from "../native-api-server";
import type { Server } from "bun";
import type { Chat } from "@/shared/chat";
import type { Workspace } from "@/shared/workspace";
import { testDeterministicAgentCode } from "../../src/core/deterministic-agent-test";

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

    const executionHostBinding = await runWithCurrentUser(
      testOwnerUser,
      getTestLocalExecutionHostBinding,
    );
    workspace = {
      id: crypto.randomUUID(),
      name: "Runner key test workspace",
      directory: tempWorkDir,
      workspaceType: "git",
      executionTargetRevision: 1,
      executionHostBinding,
      allowClankyContext: true,
      serverSettings: { agent: { provider: "opencode" } },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await runWithCurrentUser(testOwnerUser, () => createWorkspace(workspace));

    const mockBackend = new MockAcpBackend({ models: [defaultTestModel] });
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting((directory) => new TestCommandExecutor(directory));

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

    await pollUntil(
      () =>
        runWithCurrentUser(testOwnerUser, () =>
          Promise.resolve(
            managedCredentialService.listManagedKeysForCurrentUser(DETERMINISTIC_AGENT_MANAGED_BY),
          ),
        ),
      (keys) => keys.length > 0,
      {
        description: "deterministic agent run to create its managed API key",
        timeoutMs: 5000,
        formatLastObserved: (keys) => `keyCount=${keys.length}`,
      },
    );

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
    expect(
      await runWithCurrentUser(testOwnerUser, () =>
        Promise.resolve(
          managedCredentialService.listManagedKeysForCurrentUser(DETERMINISTIC_AGENT_MANAGED_BY),
        ),
      ),
    ).toHaveLength(0);
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
  let mockBackend: MockAcpBackend;
  let credentialStore: ReturnType<typeof sqliteWebAppStore>;

  beforeEach(async () => {
    tempDataDir = await mkdtemp(join(process.cwd(), ".test-prompt-bridge-"));
    tempWorkDir = await mkdtemp(join(process.cwd(), ".test-prompt-work-"));
    process.env["CLANKY_DATA_DIR"] = tempDataDir;
    closeDatabase();
    await initializeDatabase();
    seedTestOwnerUser();

    credentialStore = sqliteWebAppStore({
      dataDir: tempDataDir,
      fileName: "prompt-bridge-keys.db",
    });
    credentialStore.initialize();
    const now = new Date().toISOString();
    credentialStore.createUser({
      id: testOwnerUser.id,
      username: testOwnerUser.username,
      role: testOwnerUser.role,
      passkeyConfigured: false,
      authVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    managedCredentialService.configure(credentialStore, { publicBaseUrl: "https://clanky.test" });

    mockBackend = new MockAcpBackend({ models: [defaultTestModel] });
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting((directory) => new TestCommandExecutor(directory));

    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
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

  async function createPromptBridgeChat(): Promise<string> {
    const executionHostBinding = await runWithCurrentUser(
      testOwnerUser,
      getTestLocalExecutionHostBinding,
    );
    const workspace: Workspace = {
      id: crypto.randomUUID(),
      name: "Prompt bridge workspace",
      directory: tempWorkDir,
      workspaceType: "git",
      executionTargetRevision: 1,
      executionHostBinding,
      allowClankyContext: true,
      serverSettings: { agent: { provider: "opencode" } },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await runWithCurrentUser(testOwnerUser, () => createWorkspace(workspace));

    const response = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Prompt bridge chat",
        workspaceId: workspace.id,
        model: testModel,
        useWorktree: false,
      }),
    });
    expect(response.status).toBe(201);
    const chat = await response.json() as { config: { id: string } };
    return chat.config.id;
  }

  test("prompt bridge returns 404 for unknown chat", async () => {
    const response = await fetch(`${baseUrl}/api/internal/agent-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "nonexistent-chat-id", message: "hello" }),
    });
    expect(response.status).toBe(404);
  });

  test("prompt bridge returns 400 for missing chatId", async () => {
    const response = await fetch(`${baseUrl}/api/internal/agent-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(response.status).toBe(400);
  });

  test("forwards a prompt and returns the new assistant response", async () => {
    const chatId = await createPromptBridgeChat();

    const response = await fetch(`${baseUrl}/api/internal/agent-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message: "hello from the bridge" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response: "<promise>COMPLETE</promise>" });
  });

  test("interrupts the chat when the prompt client disconnects", async () => {
    const chatId = await createPromptBridgeChat();
    const abortSessionCallsBefore = mockBackend.getAbortSessionCalls();
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    mockBackend.setResponseGate(() => responseGate);
    const controller = new AbortController();

    try {
      const request = fetch(`${baseUrl}/api/internal/agent-prompt`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, message: "cancel this bridge prompt" }),
      });

      await pollUntil(
        () => mockBackend.getSentPrompts().length,
        (count) => count >= 1,
        {
          description: "prompt bridge request to reach the backend",
          timeoutMs: 5000,
          formatLastObserved: (count) => `promptCount=${count}`,
        },
      );
      controller.abort();
      await request.catch(() => undefined);
      releaseResponse();

      const settled = await pollUntil(
        async () => {
          const response = await fetch(`${baseUrl}/api/chats/${chatId}`);
          return await response.json() as Chat;
        },
        (chat) => chat.state.status === "idle",
        {
          description: "cancelled prompt bridge chat to become idle",
          timeoutMs: 5000,
          formatLastObserved: (chat) => `status=${chat.state.status}`,
        },
      );
      expect(settled.state.status).toBe("idle");
      expect(mockBackend.getAbortSessionCalls() - abortSessionCallsBefore).toBe(1);
    } finally {
      controller.abort();
      releaseResponse();
      mockBackend.setResponseGate();
    }
  });
});
