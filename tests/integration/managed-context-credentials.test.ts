import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sqliteWebAppStore, listManagedApiKeys } from "@pablozaiden/webapp/server";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import {
  managedCredentialService,
} from "../../src/core/managed-credential-service";
import { createInitialChatState } from "../../src/shared/chat";
import { saveChat } from "../../src/persistence/chats";
import { createWorkspace, updateWorkspace } from "../../src/persistence/workspaces";
import {
  listContextApiKeyAssociationsForContextForUser,
  listContextApiKeyAssociationsForUser,
} from "../../src/persistence/context-api-keys";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import { runWithCurrentUser } from "../../src/core/user-context";
import { testOwnerUser } from "../setup";
import type { Workspace } from "@/shared";

describe("managed execution context credentials", () => {
  let tempDir: string;
  let store: ReturnType<typeof sqliteWebAppStore>;
  let workspace: Workspace;

  beforeEach(async () => {
    tempDir = await mkdtemp(join("/tmp", "clanky-managed-context-"));
    process.env["CLANKY_DATA_DIR"] = join(tempDir, "clanky");
    closeDatabase();
    await initializeDatabase();
    store = sqliteWebAppStore({
      dataDir: join(tempDir, "webapp"),
      fileName: "keys.db",
    });
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
    managedCredentialService.configure(store, {
      publicBaseUrl: "https://clanky.example",
    });

    workspace = {
      id: crypto.randomUUID(),
      name: "Managed Context Workspace",
      directory: join(tempDir, "workspace"),
      allowClankyContext: true,
      serverSettings: {
        agent: {
          provider: "opencode",
          transport: "stdio",
        },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await runWithCurrentUser(testOwnerUser, () => createWorkspace(workspace));
  });

  afterEach(async () => {
    managedCredentialService.resetForTests();
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates one generation, reuses it, rotates it, and revokes every generation", async () => {
    await runWithCurrentUser(testOwnerUser, async () => {
      const identity = {
        userId: testOwnerUser.id,
        workspaceId: workspace.id,
        contextType: "chat" as const,
        contextId: crypto.randomUUID(),
      };

      const first = await managedCredentialService.ensureCredentialForRuntime(identity, "reuse");
      expect(first).toBeDefined();
      const reused = await managedCredentialService.ensureCredentialForRuntime(identity, "reuse");
      expect(reused?.apiKeyId).toBe(first?.apiKeyId);
      expect(reused?.generation).toBe(1);
      expect(reused?.token).toBe(first?.token);

      const recreated = await managedCredentialService.ensureCredentialForRuntime(identity, "recreate");
      expect(recreated?.apiKeyId).not.toBe(first?.apiKeyId);
      expect(recreated?.generation).toBe(2);

      const associations = await listContextApiKeyAssociationsForContextForUser(
        testOwnerUser.id,
        workspace.id,
        identity.contextType,
        identity.contextId,
      );
      expect(associations.map((association) => association.generation)).toEqual([1, 2]);
      expect(associations.every((association) => !("token" in association))).toBe(true);
      expect(listManagedApiKeys(store, testOwnerUser.id, "clanky.execution-context")).toHaveLength(2);

      await managedCredentialService.revokeContext(identity);
      expect(listManagedApiKeys(store, testOwnerUser.id, "clanky.execution-context")).toHaveLength(0);
      const revoked = await listContextApiKeyAssociationsForContextForUser(
        testOwnerUser.id,
        workspace.id,
        identity.contextType,
        identity.contextId,
      );
      expect(revoked.every((association) => association.revokedAt !== undefined)).toBe(true);
    });
  });

  test("does not create new credentials while disabled but preserves existing entitlement", async () => {
    await runWithCurrentUser(testOwnerUser, async () => {
      const existingIdentity = {
        userId: testOwnerUser.id,
        workspaceId: workspace.id,
        contextType: "task" as const,
        contextId: crypto.randomUUID(),
      };
      await managedCredentialService.ensureCredentialForRuntime(existingIdentity);
      await updateWorkspace(workspace.id, { allowClankyContext: false });

      const newIdentity = {
        ...existingIdentity,
        contextId: crypto.randomUUID(),
      };
      expect(await managedCredentialService.ensureCredentialForRuntime(newIdentity)).toBeUndefined();
      expect(listManagedApiKeys(store, testOwnerUser.id, "clanky.execution-context")).toHaveLength(1);

      const rotated = await managedCredentialService.ensureCredentialForRuntime(existingIdentity, "recreate");
      expect(rotated?.generation).toBe(2);
      expect(listManagedApiKeys(store, testOwnerUser.id, "clanky.execution-context")).toHaveLength(2);
    });
  });

  test("serializes concurrent generation creation for one context", async () => {
    await runWithCurrentUser(testOwnerUser, async () => {
      const identity = {
        userId: testOwnerUser.id,
        workspaceId: workspace.id,
        contextType: "agent_run" as const,
        contextId: crypto.randomUUID(),
      };

      const credentials = await Promise.all([
        managedCredentialService.ensureCredentialForRuntime(identity, "recreate"),
        managedCredentialService.ensureCredentialForRuntime(identity, "recreate"),
      ]);
      expect(credentials.map((credential) => credential?.generation).sort()).toEqual([1, 2]);

      const associations = await listContextApiKeyAssociationsForContextForUser(
        testOwnerUser.id,
        workspace.id,
        identity.contextType,
        identity.contextId,
      );
      expect(associations.map((association) => association.generation)).toEqual([1, 2]);
    });
  });

  test("keeps persisted contexts across service restart and reconciles stale contexts", async () => {
    await runWithCurrentUser(testOwnerUser, async () => {
      const persistedChatId = crypto.randomUUID();
      const now = new Date().toISOString();
      await saveChat({
        config: {
          id: persistedChatId,
          name: "Persisted chat",
          workspaceId: workspace.id,
          source: {
            kind: "workspace",
            workspaceId: workspace.id,
          },
          scope: "workspace",
          directory: workspace.directory,
          model: {
            providerID: "opencode",
            modelID: "test-model",
            variant: "",
          },
          useWorktree: false,
          mode: "chat",
          createdAt: now,
          updatedAt: now,
        },
        state: createInitialChatState(persistedChatId),
      });

      const existingIdentity = {
        userId: testOwnerUser.id,
        workspaceId: workspace.id,
        contextType: "chat" as const,
        contextId: persistedChatId,
      };
      const existing = await managedCredentialService.ensureCredentialForRuntime(existingIdentity);
      expect(existing).toBeDefined();

      managedCredentialService.resetForTests();
      managedCredentialService.configure(store, {
        publicBaseUrl: "https://clanky.example",
      });
      expect(await managedCredentialService.reconcileCurrentUser()).toBe(0);
      const recreated = await managedCredentialService.ensureCredentialForRuntime(existingIdentity);
      expect(recreated?.generation).toBe(2);
      expect(listManagedApiKeys(store, testOwnerUser.id, "clanky.execution-context")).toHaveLength(2);

      const staleIdentity = {
        userId: testOwnerUser.id,
        workspaceId: workspace.id,
        contextType: "ssh_session" as const,
        contextId: crypto.randomUUID(),
      };
      await managedCredentialService.ensureCredentialForRuntime(staleIdentity);
      expect(await managedCredentialService.reconcileCurrentUser()).toBe(1);
      expect(listManagedApiKeys(store, testOwnerUser.id, "clanky.execution-context")).toHaveLength(2);
      const associations = await listContextApiKeyAssociationsForUser(testOwnerUser.id);
      expect(associations.filter((association) => association.revokedAt !== undefined)).toHaveLength(1);
    });
  });
});
