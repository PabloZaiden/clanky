/**
 * API coverage for provider-owned TTS rate-limit responses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { setupTestContext, teardownTestContext, type TestContext } from "../setup";

describe("Voice TTS rate limit", () => {
  let context: TestContext;
  let server: Server<unknown>;
  let provider: Server<unknown>;
  let baseUrl: string;
  let providerBaseUrl: string;
  let providerRequests = 0;

  beforeEach(async () => {
    context = await setupTestContext();
    provider = Bun.serve({
      port: 0,
      fetch: async () => {
        providerRequests += 1;
        if (providerRequests > 3) {
          return new Response("slow down", {
            status: 429,
            headers: { "Retry-After": "17" },
          });
        }
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    });
    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
    providerBaseUrl = `${provider.url.toString().replace(/\/$/, "")}/openai/v1`;
    const settings = await fetch(`${baseUrl}/api/voice/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: providerBaseUrl,
        apiKey: "provider-secret",
        models: {
          transcription: "gpt-transcribe",
          speech: "tts",
          text: "gpt-5.6-luna",
        },
        languageHints: [],
      }),
    });
    expect(settings.status).toBe(200);
    const validation = await fetch(`${baseUrl}/api/voice/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "speech" }),
    });
    expect(validation.status).toBe(200);
  });

  afterEach(async () => {
    server.stop();
    provider.stop();
    await teardownTestContext(context);
  });

  test("propagates a provider rate limit without a global local bucket", async () => {
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${baseUrl}/api/voice/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `Request ${index}`, mode: "full" }),
      });
      expect(response.status).toBe(200);
    }

    const limited = await fetch(`${baseUrl}/api/voice/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Request 3", mode: "full" }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("17");
    expect(await limited.json()).toMatchObject({
      error: "voice_provider_rate_limited",
    });
  });
});
