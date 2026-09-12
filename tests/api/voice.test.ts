/**
 * API integration coverage for per-user voice configuration and provider use.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { buildVoiceProviderUrl, VOICE_AZURE_API_VERSION } from "../../src/core/voice-provider";
import { serveNativeApiRoutes } from "../native-api-server";
import { setupTestContext, teardownTestContext, type TestContext } from "../setup";

describe("Voice API", () => {
  let context: TestContext;
  let server: Server<unknown>;
  let provider: Server<unknown>;
  let baseUrl: string;
  let providerBaseUrl: string;
  let providerRequestPaths: string[];

  beforeEach(async () => {
    context = await setupTestContext();
    providerRequestPaths = [];
    provider = Bun.serve({
      port: 0,
      fetch: async (_request) => {
        const path = new URL(_request.url).pathname;
        providerRequestPaths.push(path);
        if (path.endsWith("/chat/completions")) {
          return Response.json({
            choices: [{ message: { content: "A concise spoken summary." } }],
          });
        }
        if (path.endsWith("/audio/transcriptions")) {
          return Response.json({ text: "hola from the provider" });
        }
        if (path.endsWith("/audio/speech")) {
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "Content-Type": "audio/mpeg" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
    providerBaseUrl = `${provider.url.toString().replace(/\/$/, "")}/openai/v1`;
  });

  afterEach(async () => {
    server.stop();
    provider.stop();
    await teardownTestContext(context);
  });

  test("only enables capabilities after validation", async () => {
    const initial = await fetch(`${baseUrl}/api/voice/settings`);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      apiKeyConfigured: false,
      capabilities: {
        transcription: { validated: false, state: "unconfigured" },
        speech: { validated: false, state: "unconfigured" },
        text: { validated: false, state: "unconfigured" },
      },
      languageHints: ["es", "en"],
    });

    const save = await fetch(`${baseUrl}/api/voice/settings`, {
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
        languageHints: ["es", "en"],
      }),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({ apiKeyConfigured: true });

    const saved = await fetch(`${baseUrl}/api/voice/settings`);
    const savedSettings = await saved.json();
    expect(savedSettings.apiKeyConfigured).toBe(true);
    expect(savedSettings.capabilities.text.validated).toBe(false);

    const textValidation = await fetch(`${baseUrl}/api/voice/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "text" }),
    });
    expect(textValidation.status).toBe(200);
    const validated = await textValidation.json();
    expect(validated.settings.capabilities.text).toMatchObject({
      configured: true,
      validated: true,
      state: "valid",
    });

  });

  test("derives all Azure deployment endpoints from one resource URL", () => {
    const baseUrl = "https://clanky-azure.openai.azure.com";
    expect(buildVoiceProviderUrl(baseUrl, "/audio/transcriptions", "gpt-transcribe"))
      .toBe(
        `https://clanky-azure.openai.azure.com/openai/deployments/gpt-transcribe/audio/transcriptions?api-version=${VOICE_AZURE_API_VERSION}`,
      );
    expect(buildVoiceProviderUrl(baseUrl, "/audio/speech", "tts"))
      .toBe(
        `https://clanky-azure.openai.azure.com/openai/deployments/tts/audio/speech?api-version=${VOICE_AZURE_API_VERSION}`,
      );
    expect(buildVoiceProviderUrl(
      `${baseUrl}/openai/deployments/gpt-transcribe/audio/transcriptions?api-version=2025-03-01-preview`,
      "/chat/completions",
      "gpt-5.6-luna",
    )).toBe(
      `https://clanky-azure.openai.azure.com/openai/deployments/gpt-5.6-luna/chat/completions?api-version=${VOICE_AZURE_API_VERSION}`,
    );
  });

  test("transcribes audio and returns provider speech", async () => {
    await fetch(`${baseUrl}/api/voice/settings`, {
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

    for (const capability of ["transcription", "speech"] as const) {
      const validation = await fetch(`${baseUrl}/api/voice/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability }),
      });
      expect(validation.status).toBe(200);
    }

    const textValidation = await fetch(`${baseUrl}/api/voice/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "text" }),
    });
    expect(textValidation.status).toBe(200);

    const summarySpeech = await fetch(`${baseUrl}/api/voice/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "The agent completed the change and the remaining action is to review it.",
        mode: "summary",
      }),
    });
    expect(summarySpeech.status).toBe(200);

    const transcription = await fetch(`${baseUrl}/api/voice/transcribe`, {
      method: "POST",
      body: (() => {
        const form = new FormData();
        form.append("file", new File([new Uint8Array([1, 2, 3])], "recording.webm", {
          type: "audio/webm",
        }));
        return form;
      })(),
    });
    expect(transcription.status).toBe(200);
    expect(await transcription.json()).toEqual({ text: "hola from the provider" });

    const speech = await fetch(`${baseUrl}/api/voice/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello", mode: "full" }),
    });
    expect(speech.status).toBe(200);
    expect(speech.headers.get("content-type")).toContain("audio/mpeg");
    expect(new Uint8Array(await speech.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(providerRequestPaths).toContain("/openai/v1/chat/completions");
    expect(providerRequestPaths).toContain("/openai/v1/audio/speech");
  });
});
