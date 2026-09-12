/**
 * API integration coverage for per-user voice configuration and provider use.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  buildVoiceProviderUrl,
  normalizeVoiceBaseUrl,
  VOICE_AZURE_API_VERSION,
} from "../../src/core/voice-provider";
import { serveNativeApiRoutes } from "../native-api-server";
import {
  setupTestContext,
  teardownTestContext,
  type TestContext,
} from "../setup";

describe("Voice API", () => {
  let context: TestContext;
  let server: Server<unknown>;
  let provider: Server<unknown>;
  let baseUrl: string;
  let providerBaseUrl: string;
  let providerRequestPaths: string[];
  let providerApiKeys: string[];
  let providerSpeechContentType: string;
  let providerSpeechOversized: boolean;
  let holdTextValidation: boolean;
  let textValidationStarted: Promise<void>;
  let resolveTextValidationStarted: () => void;
  let releaseTextValidation: () => void;

  beforeEach(async () => {
    context = await setupTestContext();
    providerRequestPaths = [];
    providerApiKeys = [];
    providerSpeechContentType = "audio/mpeg";
    providerSpeechOversized = false;
    holdTextValidation = false;
    resolveTextValidationStarted = () => {};
    releaseTextValidation = () => {};
    textValidationStarted = new Promise<void>((resolve) => {
      resolveTextValidationStarted = resolve;
    });
    provider = Bun.serve({
      port: 0,
      fetch: async (_request) => {
        const path = new URL(_request.url).pathname;
        providerRequestPaths.push(path);
        providerApiKeys.push(_request.headers.get("api-key") ?? "");
        if (path.endsWith("/chat/completions")) {
          if (holdTextValidation) {
            resolveTextValidationStarted();
            await new Promise<void>((resolve) => {
              releaseTextValidation = resolve;
            });
          }
          return Response.json({
            choices: [{ message: { content: "A concise spoken summary." } }],
          });
        }
        if (path.endsWith("/audio/transcriptions")) {
          return Response.json({ text: "hola from the provider" });
        }
        if (path.endsWith("/audio/speech")) {
          if (providerSpeechOversized) {
            const oversizedAudio = new Uint8Array(20 * 1024 * 1024 + 1);
            return new Response(new ReadableStream({
              start(controller) {
                controller.enqueue(oversizedAudio);
                controller.close();
              },
            }), {
              headers: { "Content-Type": "audio/mpeg" },
            });
          }
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "Content-Type": providerSpeechContentType },
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
    expect(savedSettings.capabilities.text.state).toBe("unvalidated");

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

  test("rejects private, insecure, and credential-bearing provider URLs", () => {
    expect(() => normalizeVoiceBaseUrl("http://example.com/openai/v1")).toThrow();
    expect(() => normalizeVoiceBaseUrl("https://192.168.1.10/openai/v1")).toThrow();
    expect(() => normalizeVoiceBaseUrl("https://169.254.169.254/openai/v1")).toThrow();
    expect(() => normalizeVoiceBaseUrl("https://[::ffff:192.168.1.10]/openai/v1")).toThrow();
    expect(() => normalizeVoiceBaseUrl("https://provider.example/openai/v1?api-key=secret")).toThrow();
    expect(normalizeVoiceBaseUrl("https://provider.example/openai/v1?api-version=2025-03-01-preview"))
      .toBe("https://provider.example/openai/v1?api-version=2025-03-01-preview");
  });

  test("enforces the upload limit before multipart parsing", async () => {
    const oversized = new Uint8Array(21 * 1024 * 1024 + 1);
    const response = await fetch(`${baseUrl}/api/voice/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=voice-test" },
      body: new Blob([oversized]),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: "voice_audio_too_large",
    });
  });

  test("rejects non-audio speech responses", async () => {
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
    const validation = await fetch(`${baseUrl}/api/voice/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "speech" }),
    });
    expect(validation.status).toBe(200);

    providerSpeechContentType = "application/json";
    const response = await fetch(`${baseUrl}/api/voice/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello", mode: "full" }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "voice_provider_invalid_response",
    });
  });

  test("bounds streamed speech responses without a content length", async () => {
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
    const validation = await fetch(`${baseUrl}/api/voice/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "speech" }),
    });
    expect(validation.status).toBe(200);

    providerSpeechOversized = true;
    const response = await fetch(`${baseUrl}/api/voice/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello", mode: "full" }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "voice_provider_response_too_large",
    });
  });

  test("does not apply a stale validation result after settings change", async () => {
    await fetch(`${baseUrl}/api/voice/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: providerBaseUrl,
        apiKey: "provider-secret",
        models: {
          transcription: "gpt-transcribe",
          speech: "tts",
          text: "old-text-model",
        },
        languageHints: [],
      }),
    });

    holdTextValidation = true;
    const validationPromise = fetch(`${baseUrl}/api/voice/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "text" }),
    });
    await textValidationStarted;

    const save = await fetch(`${baseUrl}/api/voice/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: providerBaseUrl,
        models: {
          transcription: "gpt-transcribe",
          speech: "tts",
          text: "new-text-model",
        },
        languageHints: [],
      }),
    });
    expect(save.status).toBe(200);
    releaseTextValidation();
    const validation = await validationPromise;
    expect(validation.status).toBe(409);
    expect(await validation.json()).toMatchObject({
      error: "voice_validation_stale",
    });
    const settings = await fetch(`${baseUrl}/api/voice/settings`);
    expect((await settings.json()).capabilities.text.state).toBe("unvalidated");
  });

  test("isolates settings and provider credentials between users", async () => {
    const secondUserServer = serveNativeApiRoutes({
      user: {
        id: "voice-user-2",
        username: "voice-user-2",
        role: "user",
        isOwner: false,
        isAdmin: false,
      },
    });
    const secondBaseUrl = secondUserServer.url.toString().replace(/\/$/, "");
    const saveSettings = async (url: string, apiKey: string): Promise<Response> => (
      await fetch(`${url}/api/voice/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: providerBaseUrl,
          apiKey,
          models: {
            transcription: "gpt-transcribe",
            speech: "tts",
            text: "gpt-5.6-luna",
          },
          languageHints: [],
        }),
      })
    );

    try {
      expect((await saveSettings(baseUrl, "owner-key")).status).toBe(200);
      expect((await saveSettings(secondBaseUrl, "second-key")).status).toBe(200);

      const ownerSettings = await fetch(`${baseUrl}/api/voice/settings`);
      const secondSettings = await fetch(`${secondBaseUrl}/api/voice/settings`);
      const ownerBody = await ownerSettings.text();
      const secondBody = await secondSettings.text();
      expect(ownerBody).not.toContain("owner-key");
      expect(ownerBody).not.toContain("second-key");
      expect(secondBody).not.toContain("owner-key");
      expect(secondBody).not.toContain("second-key");

      expect((await fetch(`${baseUrl}/api/voice/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "text" }),
      })).status).toBe(200);
      expect((await fetch(`${secondBaseUrl}/api/voice/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "text" }),
      })).status).toBe(200);
      expect(providerApiKeys).toContain("owner-key");
      expect(providerApiKeys).toContain("second-key");
    } finally {
      secondUserServer.stop();
    }
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
