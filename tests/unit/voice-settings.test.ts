/**
 * Persistence boundary coverage for voice settings recovery and credentials.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { getDatabase } from "../../src/persistence/database";
import { serveNativeApiRoutes } from "../native-api-server";
import { setupTestContext, teardownTestContext, type TestContext } from "../setup";

describe("Voice settings persistence", () => {
  let context: TestContext;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeEach(async () => {
    context = await setupTestContext();
    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterEach(async () => {
    server.stop();
    await teardownTestContext(context);
  });

  test("treats corrupt settings as empty and allows repair", async () => {
    getDatabase()
      .query("INSERT INTO preferences (key, user_id, value) VALUES (?, ?, ?)")
      .run("voiceProviderSettings", "admin", "{not-json");

    const initial = await fetch(`${baseUrl}/api/voice/settings`);
    expect(initial.status).toBe(200);
    expect((await initial.json()).apiKeyConfigured).toBe(false);

    const repaired = await fetch(`${baseUrl}/api/voice/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "",
        apiKey: "repair-key",
        models: {
          transcription: "gpt-transcribe",
          speech: "tts",
          text: "gpt-5.6-luna",
        },
        languageHints: [],
      }),
    });
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toMatchObject({ apiKeyConfigured: true });

    const stored = getDatabase()
      .query("SELECT value FROM preferences WHERE key = ? AND user_id = ?")
      .get("voiceProviderSettings", "admin") as { value: string };
    expect(stored.value).not.toContain("repair-key");
    expect(JSON.parse(stored.value).apiKeyCiphertext).toMatch(/^v1\./);

    const unsafe = JSON.parse(stored.value) as Record<string, unknown>;
    unsafe["baseUrl"] = "https://provider.example/openai/v1?api-key=leaked";
    getDatabase()
      .query("UPDATE preferences SET value = ? WHERE key = ? AND user_id = ?")
      .run(JSON.stringify(unsafe), "voiceProviderSettings", "admin");
    const unsafeRead = await fetch(`${baseUrl}/api/voice/settings`);
    expect(unsafeRead.status).toBe(200);
    expect(await unsafeRead.json()).toMatchObject({
      baseUrl: "",
      apiKeyConfigured: false,
    });
  });
});
