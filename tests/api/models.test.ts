/**
 * API integration tests for model discovery endpoints.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { backendManager } from "../../src/core/backend-manager";
import { setupTestContext, teardownTestContext, type TestContext } from "../setup";
import { MockAcpBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";

class VariantTrackingBackend extends MockAcpBackend {
  async getModelVariants(directory: string, modelID: string): Promise<string[]> {
    const provider = this.getConnectionConfigs().at(-1)?.provider;
    return [`${provider ?? "unknown"}:${directory}:${modelID}`];
  }
}

describe("Models API", () => {
  let ctx: TestContext;
  let server: Server<unknown>;
  let baseUrl: string;
  let backend: VariantTrackingBackend;

  beforeEach(async () => {
    ctx = await setupTestContext();
    backend = new VariantTrackingBackend();
    backendManager.setBackendForTesting(backend);
    backendManager.setExecutorFactoryForTesting((directory) => new TestCommandExecutor(directory));

    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterEach(async () => {
    server.stop();
    await teardownTestContext(ctx);
  });

  test("validates required query parameters for model variants", async () => {
    const missingWorkspace = await fetch(`${baseUrl}/api/models/variants?modelID=test-model`);
    expect(missingWorkspace.status).toBe(400);
    expect(await missingWorkspace.json()).toMatchObject({ error: "missing_workspace_id" });

    const missingModel = await fetch(`${baseUrl}/api/models/variants?workspaceId=test-workspace-id`);
    expect(missingModel.status).toBe(400);
    expect(await missingModel.json()).toMatchObject({ error: "missing_model_id" });
  });

  test("derives variant discovery from the workspace provider", async () => {
    const response = await fetch(
      `${baseUrl}/api/models/variants?workspaceId=test-workspace-id&providerID=copilot&modelID=test-model`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      variants: [`opencode:${ctx.workDir}:test-model`],
    });
  });

  test("keeps variant cache entries isolated when the workspace provider changes", async () => {
    const first = await fetch(
      `${baseUrl}/api/models/variants?workspaceId=test-workspace-id&modelID=test-model`,
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      variants: [`opencode:${ctx.workDir}:test-model`],
    });

    const updateResponse = await fetch(`${baseUrl}/api/workspaces/test-workspace-id`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverSettings: {
          agent: {
            provider: "copilot",
          },
        },
      }),
    });
    expect(updateResponse.status).toBe(200);
    backendManager.setSettingsForTesting({
      agent: {
        provider: "copilot",
        transport: "stdio",
      },
    });

    const second = await fetch(
      `${baseUrl}/api/models/variants?workspaceId=test-workspace-id&modelID=test-model`,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      variants: [`copilot:${ctx.workDir}:test-model`],
    });

  });
});
