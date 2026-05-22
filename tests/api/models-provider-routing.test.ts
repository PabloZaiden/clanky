/**
 * API tests for provider-aware model discovery routing.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { CommandOptions, CommandResult } from "../../src/core/command-executor";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { MockAcpBackend } from "../mocks/mock-backend";

let testDataDir: string;

class FailOnCopilotExecutionExecutor extends TestCommandExecutor {
  override async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    if (command === "copilot") {
      throw new Error(`Unexpected direct copilot execution: ${command} ${args.join(" ")}`);
    }
    return await super.exec(command, args, options);
  }
}

describe("GET /api/models provider routing", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-model-routing-test-"));
    process.env["CLANKY_DATA_DIR"] = testDataDir;

    const { backendManager } = await import("../../src/core/backend-manager");
    const { ensureDataDirectories } = await import("../../src/persistence/database");
    backendManager.resetForTesting();
    await ensureDataDirectories();
  });

  afterEach(async () => {
    const { backendManager } = await import("../../src/core/backend-manager");
    const { closeDatabase } = await import("../../src/persistence/database");

    backendManager.resetForTesting();
    closeDatabase();

    delete process.env["CLANKY_DATA_DIR"];
    await rm(testDataDir, { recursive: true, force: true });
  });

  test("uses ACP backend model list for copilot workspaces", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "clanky-model-routing-workdir-"));
    try {
      const { backendManager } = await import("../../src/core/backend-manager");
      backendManager.setBackendForTesting(new MockAcpBackend({
        models: [
          {
            providerID: "openai",
            providerName: "OpenAI",
            modelID: "gpt-5.3-codex",
            modelName: "GPT-5.3-Codex",
            connected: true,
          },
          {
            providerID: "anthropic",
            providerName: "Anthropic",
            modelID: "claude-sonnet-4.6",
            modelName: "Claude Sonnet 4.6",
            connected: true,
          },
          {
            providerID: "openai",
            providerName: "OpenAI",
            modelID: "gpt-4.1",
            modelName: "GPT-4.1",
            connected: true,
          },
        ],
      }));
      backendManager.setExecutorFactoryForTesting(() => new FailOnCopilotExecutionExecutor());

      const { createWorkspace } = await import("../../src/persistence/workspaces");
      await createWorkspace({
        id: "copilot-model-workspace",
        name: "Copilot Workspace",
        directory: workDir,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        serverSettings: {
          agent: {
            provider: "copilot",
            transport: "stdio",
          },
        },
      });

      const { modelsRoutes } = await import("../../src/api/models");
      const response = await modelsRoutes["/api/models"].GET(
        new Request(
          `http://localhost/api/models?directory=${encodeURIComponent(workDir)}&workspaceId=copilot-model-workspace`,
        ),
      );

      expect(response.status).toBe(200);
      const models = await response.json() as Array<{
        providerID: string;
        providerName: string;
        modelID: string;
      }>;
      const modelIds = models.map((model) => model.modelID).sort();

      expect(modelIds).toEqual(["claude-sonnet-4.6", "gpt-4.1", "gpt-5.3-codex"]);
      expect(models.every((model) => model.providerID === "copilot")).toBe(true);
      expect(models.every((model) => model.providerName === "Copilot")).toBe(true);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
