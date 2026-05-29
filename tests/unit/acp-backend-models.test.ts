import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcpBackend } from "../../src/backends/acp/acp-backend";

describe("AcpBackend model discovery", () => {
  let previousMockAcp: string | undefined;
  let workDir: string;
  let backend: AcpBackend;

  beforeEach(async () => {
    previousMockAcp = process.env["CLANKY_MOCK_ACP"];
    process.env["CLANKY_MOCK_ACP"] = "true";
    workDir = await mkdtemp(join(tmpdir(), "clanky-acp-models-"));
    backend = new AcpBackend();
  });

  afterEach(async () => {
    await backend.disconnect();
    if (previousMockAcp === undefined) {
      delete process.env["CLANKY_MOCK_ACP"];
    } else {
      process.env["CLANKY_MOCK_ACP"] = previousMockAcp;
    }
    await rm(workDir, { recursive: true, force: true });
  });

  test("discovers reasoning effort variants for Codex models after an incomplete cache entry", async () => {
    await backend.connect({
      mode: "spawn",
      provider: "codex",
      transport: "stdio",
      directory: workDir,
    });

    await backend.createSession({ directory: workDir, model: "mock-model" });
    const models = await backend.getModels(workDir);

    expect(models.find((model) => model.modelID === "mock-model")?.variants).toEqual([
      "medium",
      "low",
      "high",
    ]);
  });
});
