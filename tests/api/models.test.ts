/**
 * API integration tests for model discovery endpoints.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { serve, type Server } from "bun";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { apiRoutes } from "../../src/api";
import { backendManager } from "../../src/core/backend-manager";
import { runWithCurrentUser } from "../../src/core/user-context";
import { createWorkspace } from "../../src/persistence/workspaces";
import type { AgentProvider } from "../../src/types/settings";
import type { Workspace } from "../../src/types/workspace";
import { setupTestContext, teardownTestContext, testOwnerUser, type TestContext } from "../setup";
import { MockAcpBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";

class VariantTrackingBackend extends MockAcpBackend {
  readonly variantRequests: Array<{ directory: string; modelID: string; provider?: AgentProvider }> = [];

  async getModelVariants(directory: string, modelID: string): Promise<string[]> {
    const provider = this.getConnectionConfigs().at(-1)?.provider;
    this.variantRequests.push({ directory, modelID, provider });
    return [`${provider ?? "unknown"}:${directory}:${modelID}`];
  }
}

function makeWorkspace(
  id: string,
  directory: string,
  provider: AgentProvider,
): Workspace {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    directory,
    createdAt: now,
    updatedAt: now,
    serverSettings: {
      agent: {
        provider,
        transport: "stdio",
      },
    },
  };
}

describe("Models API", () => {
  let ctx: TestContext;
  let server: Server<unknown>;
  let baseUrl: string;
  let backend: VariantTrackingBackend;
  let extraWorkDir: string;

  beforeEach(async () => {
    ctx = await setupTestContext();
    extraWorkDir = await mkdtemp(join(tmpdir(), "clanky-api-models-extra-work-"));
    backend = new VariantTrackingBackend();
    backendManager.setBackendForTesting(backend);
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    server = serve({
      port: 0,
      routes: {
        ...apiRoutes,
      },
    });
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterEach(async () => {
    server.stop();
    await teardownTestContext(ctx);
    await rm(extraWorkDir, { recursive: true, force: true });
  });

  test("validates required query parameters for model variants", async () => {
    const missingWorkspace = await fetch(`${baseUrl}/api/models/variants?modelID=test-model`);
    expect(missingWorkspace.status).toBe(400);
    expect(await missingWorkspace.json()).toMatchObject({ error: "missing_workspace_id" });

    const missingModel = await fetch(`${baseUrl}/api/models/variants?workspaceId=test-workspace-id`);
    expect(missingModel.status).toBe(400);
    expect(await missingModel.json()).toMatchObject({ error: "missing_model_id" });
  });

  test("derives variant backend routing from workspace settings and ignores providerID", async () => {
    const response = await fetch(
      `${baseUrl}/api/models/variants?workspaceId=test-workspace-id&providerID=copilot&modelID=test-model`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      variants: [`opencode:${ctx.workDir}:test-model`],
    });
    expect(backend.variantRequests).toEqual([
      { directory: ctx.workDir, modelID: "test-model", provider: "opencode" },
    ]);
  });

  test("keeps variant cache entries isolated by workspace provider and directory", async () => {
    await runWithCurrentUser(testOwnerUser, () => createWorkspace(
      makeWorkspace("copilot-workspace-id", extraWorkDir, "copilot"),
    ));

    const first = await fetch(
      `${baseUrl}/api/models/variants?workspaceId=test-workspace-id&modelID=test-model`,
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      variants: [`opencode:${ctx.workDir}:test-model`],
    });

    const second = await fetch(
      `${baseUrl}/api/models/variants?workspaceId=copilot-workspace-id&modelID=test-model`,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      variants: [`copilot:${extraWorkDir}:test-model`],
    });

    const repeatedFirst = await fetch(
      `${baseUrl}/api/models/variants?workspaceId=test-workspace-id&modelID=test-model`,
    );
    expect(repeatedFirst.status).toBe(200);
    expect(await repeatedFirst.json()).toEqual({
      variants: [`opencode:${ctx.workDir}:test-model`],
    });
    expect(backend.variantRequests).toEqual([
      { directory: ctx.workDir, modelID: "test-model", provider: "opencode" },
      { directory: extraWorkDir, modelID: "test-model", provider: "copilot" },
    ]);
  });
});
