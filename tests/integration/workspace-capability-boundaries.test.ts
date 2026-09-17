import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Server } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  POSIX_EXECUTION_HOST_CAPABILITIES,
  type ExecutionHostCapabilities,
  type ExecutionHostBinding,
  type ExecutionHostRef,
  type Workspace,
} from "@/shared";
import { backendManager } from "../../src/core/backend-manager";
import { meshStateEventEmitter } from "../../src/core/event-emitter";
import { executionHostService } from "../../src/core/execution-host-service";
import { runWithCurrentUser } from "../../src/core/user-context";
import {
  closeDatabase,
  getDatabase,
  initializeDatabase,
} from "../../src/persistence/database";
import {
  ensureExecutionHost,
  toExecutionHostBinding,
} from "../../src/persistence/execution-hosts";
import {
  createWorkspace,
  getWorkspace,
} from "../../src/persistence/workspaces";
import { serveNativeApiRoutes } from "../native-api-server";
import {
  seedTestOwnerUser,
  testOwnerUser,
} from "../setup";
import { pollUntil } from "../helpers/polling";
import { TestCommandExecutor } from "../mocks/mock-executor";

const supportedRef = {
  kind: "mesh",
  nodeId: "supported-worker",
} as const satisfies ExecutionHostRef;
const unsupportedRef = {
  kind: "mesh",
  nodeId: "health-only-worker",
} as const satisfies ExecutionHostRef;
const noGitRef = {
  kind: "mesh",
  nodeId: "no-git-worker",
} as const satisfies ExecutionHostRef;

let dataDir: string;
let server: Server<unknown>;
let baseUrl: string;
let supportedBinding: ExecutionHostBinding;
let unsupportedBinding: ExecutionHostBinding;

function workspace(
  id: string,
  executionHostBinding: ExecutionHostBinding,
): Workspace {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    directory: dataDir,
    workspaceType: "directory",
    executionTargetRevision: 1,
    executionHostBinding,
    serverSettings: {
      agent: {
        provider: "copilot",
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

function registerMeshWorker(
  ref: Extract<ExecutionHostRef, { kind: "mesh" }>,
  name: string,
  os: "linux" | "windows",
  capabilities: ExecutionHostCapabilities,
): void {
  const now = new Date().toISOString();
  getDatabase().query(`
    INSERT INTO mesh_worker_registrations (
      worker_node_id, local_user_id, worker_instance_name,
      worker_endpoint, worker_transport,
      worker_public_key, worker_fingerprint,
      route_kind, worker_directory,
      worker_platform_os, worker_platform_architecture,
      worker_capabilities_json, worker_accept_remote_execution,
      worker_config_revision, registration_scope, grant_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ref.nodeId,
    testOwnerUser.id,
    name,
    "http://127.0.0.1:1",
    "http",
    "fixture-public-key",
    "fixture-fingerprint",
    "direct",
    null,
    os,
    "x64",
    JSON.stringify(capabilities),
    1,
    1,
    "global",
    "active",
    now,
    now,
  );
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clanky-workspace-capabilities-"));
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = dataDir;
  await initializeDatabase();
  seedTestOwnerUser();

  await runWithCurrentUser(testOwnerUser, async () => {
    supportedBinding = toExecutionHostBinding(ensureExecutionHost(
      testOwnerUser.id,
      supportedRef,
      "mesh:supported-worker",
      {
        runtime: {
          platform: { os: "linux", architecture: "x64" },
          capabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
        },
      },
    ));
    const filesystemOnlyCapabilities = {
      fileOperations: 2,
      serverHealth: 1,
    };
    unsupportedBinding = toExecutionHostBinding(ensureExecutionHost(
      testOwnerUser.id,
      unsupportedRef,
      "mesh:filesystem-only-worker",
      {
        runtime: {
          platform: { os: "windows", architecture: "x64" },
          capabilities: filesystemOnlyCapabilities,
        },
      },
    ));
    const noGitCapabilities = {
      fileOperations: 2,
      acpRuntime: 1,
      serverHealth: 1,
    };
    ensureExecutionHost(
      testOwnerUser.id,
      noGitRef,
      "mesh:no-git-worker",
      {
        runtime: {
          platform: { os: "linux", architecture: "x64" },
          capabilities: noGitCapabilities,
        },
      },
    );
    registerMeshWorker(
      unsupportedRef,
      "Filesystem-only worker",
      "windows",
      filesystemOnlyCapabilities,
    );
    registerMeshWorker(
      noGitRef,
      "No Git worker",
      "linux",
      noGitCapabilities,
    );
    await createWorkspace(workspace("supported-workspace", supportedBinding));
    await createWorkspace(workspace("unsupported-workspace", unsupportedBinding));
  });

  server = serveNativeApiRoutes();
  baseUrl = server.url.toString().replace(/\/$/, "");
  await backendManager.initialize();
});

afterEach(async () => {
  server.stop();
  backendManager.resetForTesting();
  closeDatabase();
  delete process.env["CLANKY_DATA_DIR"];
  await rm(dataDir, { recursive: true, force: true });
});

describe("workspace capability boundaries", () => {
  // This public-boundary regression preserves the typed capability failure
  // when a new workspace selects an unsupported registered host.
  test("rejects creating a workspace on a host without workspace capabilities", async () => {
    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Unsupported workspace",
        directory: dataDir,
        executionHost: unsupportedRef,
        serverSettings: {
          agent: {
            provider: "copilot",
          },
        },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "execution_host_capability_unavailable",
      capability: "acpRuntime",
    });
  });

  test("rejects a Git workspace on a host without Git transport", async () => {
    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Unsupported Git workspace",
        directory: dataDir,
        workspaceType: "git",
        allowWorktrees: false,
        executionHost: noGitRef,
        serverSettings: {
          agent: {
            provider: "copilot",
          },
        },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "execution_host_capability_unavailable",
      capability: "git",
    });
  });

  // This integration regression verifies the remote execution cache contract
  // through the Mesh state boundary rather than asserting a private map.
  test("rebuilds a cached Mesh executor after execution-host runtime changes", async () => {
    let createdExecutors = 0;
    executionHostService.setExecutorFactoryForTesting((directory) => {
      createdExecutors += 1;
      return new TestCommandExecutor(directory);
    });

    await runWithCurrentUser(testOwnerUser, async () => {
      const firstExecutor = await backendManager.getCommandExecutorAsync(
        "supported-workspace",
        dataDir,
      );
      expect(
        await backendManager.getCommandExecutorAsync(
          "supported-workspace",
          dataDir,
        ),
      ).toBe(firstExecutor);

      meshStateEventEmitter.emit(
        { type: "mesh.changed", executionHostsChanged: true },
        { userId: testOwnerUser.id },
      );

      await pollUntil(
        async () => {
          const executor = await backendManager.getCommandExecutorAsync(
            "supported-workspace",
            dataDir,
          );
          return { createdExecutors, executor };
        },
        (result) => result.createdExecutors === 2,
        {
          description: "Mesh executor cache invalidation",
          formatLastObserved: (result) => (
            `createdExecutors=${String(result.createdExecutors)}`
          ),
        },
      );
    });
  });

  // This public-boundary regression prevents persisted workspaces from
  // bypassing commandExecution after a runtime capability downgrade.
  test("rejects workspace exec before creating an unsupported host executor", async () => {
    const response = await fetch(
      `${baseUrl}/api/workspaces/unsupported-workspace/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "pwd",
          args: [],
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "execution_host_capability_unavailable",
      capability: "commandExecution",
    });
  });

  // This public-boundary regression proves an unsupported rebind is rejected
  // without changing the workspace's persisted execution target.
  test("rejects rebinding a workspace to a host without workspace capabilities", async () => {
    const response = await fetch(
      `${baseUrl}/api/workspaces/supported-workspace`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executionHost: unsupportedRef,
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "execution_host_capability_unavailable",
      capability: "acpRuntime",
    });
    const persisted = await runWithCurrentUser(
      testOwnerUser,
      async () => await getWorkspace("supported-workspace"),
    );
    expect(persisted?.executionHostBinding).toEqual(supportedBinding);
  });
});
