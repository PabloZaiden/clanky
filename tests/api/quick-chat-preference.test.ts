import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let testDataDir: string;

describe("Quick chat preference API", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-quick-chat-test-"));
    process.env["RALPHER_DATA_DIR"] = testDataDir;

    const { ensureDataDirectories } = await import("../../src/persistence/database");
    await ensureDataDirectories();
  });

  afterEach(async () => {
    const { closeDatabase } = await import("../../src/persistence/database");
    closeDatabase();

    delete process.env["RALPHER_DATA_DIR"];
    await rm(testDataDir, { recursive: true });
  });

  test("stores and retrieves quick chat workspace and model settings", async () => {
    const { preferencesRoutes } = await import("../../src/api/models");
    const putHandler = preferencesRoutes["/api/preferences/quick-chat"].PUT;
    const getHandler = preferencesRoutes["/api/preferences/quick-chat"].GET;

    const putResponse = await putHandler(new Request("http://localhost/api/preferences/quick-chat", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        model: {
          providerID: "copilot",
          modelID: "gpt-5.5",
          variant: "xhigh",
        },
      }),
    }));

    expect(putResponse.status).toBe(200);

    const getResponse = await getHandler();
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toEqual({
      workspaceId: "workspace-1",
      model: {
        providerID: "copilot",
        modelID: "gpt-5.5",
        variant: "xhigh",
      },
    });
  });

  test("allows clearing quick chat settings", async () => {
    const { preferencesRoutes } = await import("../../src/api/models");
    const putHandler = preferencesRoutes["/api/preferences/quick-chat"].PUT;

    const response = await putHandler(new Request("http://localhost/api/preferences/quick-chat", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "",
        model: null,
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      settings: {
        workspaceId: "",
        model: null,
      },
    });
  });

  test("falls back to default settings when persisted JSON is invalid", async () => {
    const { getDatabase } = await import("../../src/persistence/database");
    getDatabase()
      .prepare("INSERT INTO preferences (key, value) VALUES (?, ?)")
      .run("quickChatSettings", "{invalid");

    const { getQuickChatSettings } = await import("../../src/persistence/preferences");
    await expect(getQuickChatSettings()).resolves.toEqual({
      workspaceId: "",
      model: null,
    });
  });

  test("rejects invalid quick chat model payloads", async () => {
    const { preferencesRoutes } = await import("../../src/api/models");
    const putHandler = preferencesRoutes["/api/preferences/quick-chat"].PUT;

    const response = await putHandler(new Request("http://localhost/api/preferences/quick-chat", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "workspace-1",
        model: {
          providerID: "",
          modelID: "gpt-5.5",
          variant: "",
        },
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "validation_error",
    });
  });
});
