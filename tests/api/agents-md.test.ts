/**
 * API integration tests for AGENTS.md workspace operations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import {
  setupTestContext,
  teardownTestContext,
  type TestContext,
} from "../setup";

describe("AGENTS.md API integration", () => {
  let context: TestContext;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeEach(async () => {
    context = await setupTestContext({
      initialFiles: {
        "AGENTS.md": "# Project guidance\n",
      },
    });
    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterEach(async () => {
    server.stop();
    await teardownTestContext(context);
  });

  test("reads, previews, and applies optimization through the workspace executor", async () => {
    const readResponse = await fetch(
      `${baseUrl}/api/workspaces/test-workspace-id/agents-md`,
    );
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({
      content: "# Project guidance\n",
      fileExists: true,
      analysis: {
        isOptimized: false,
        currentVersion: null,
        updateAvailable: true,
      },
    });

    const previewResponse = await fetch(
      `${baseUrl}/api/workspaces/test-workspace-id/agents-md/preview`,
      { method: "POST" },
    );
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as {
      currentContent: string;
      proposedContent: string;
      fileExists: boolean;
    };
    expect(preview.currentContent).toBe("# Project guidance\n");
    expect(preview.fileExists).toBe(true);
    expect(preview.proposedContent).toContain("clanky-optimized-v1");

    const optimizeResponse = await fetch(
      `${baseUrl}/api/workspaces/test-workspace-id/agents-md/optimize`,
      { method: "POST" },
    );
    expect(optimizeResponse.status).toBe(200);
    expect(await optimizeResponse.json()).toMatchObject({
      success: true,
      alreadyOptimized: false,
      analysis: {
        isOptimized: true,
        currentVersion: 1,
        updateAvailable: false,
      },
    });
    expect(await Bun.file(`${context.workDir}/AGENTS.md`).text()).toContain(
      "clanky-optimized-v1",
    );

    const repeatedOptimizeResponse = await fetch(
      `${baseUrl}/api/workspaces/test-workspace-id/agents-md/optimize`,
      { method: "POST" },
    );
    expect(repeatedOptimizeResponse.status).toBe(200);
    expect(await repeatedOptimizeResponse.json()).toMatchObject({
      success: true,
      alreadyOptimized: true,
    });
  });

  test("maps an unknown workspace to a not-found response", async () => {
    const response = await fetch(
      `${baseUrl}/api/workspaces/missing-workspace/agents-md`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "workspace_not_found",
    });
  });
});
