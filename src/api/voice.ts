/**
 * Authenticated API routes for the optional per-user voice features.
 */

import { defineRoutes, type RouteContext } from "@pablozaiden/webapp/server";
import {
  VoiceSettingsUpdateSchema,
  VoiceTranslationRequestSchema,
  VoiceTranslationResponseSchema,
  VoiceValidationRequestSchema,
} from "@/contracts/schemas";
import { chatManager } from "../core/chat-manager";
import { voiceManager } from "../core/voice-manager";
import { isDomainError } from "../domain/domain-error";
import { DomainError } from "../domain/domain-error";
import { detectTrailingPromiseMarker } from "../utils/promise-markers";
import { domainErrorResponse, errorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import type { PersistedMessage } from "@/shared";

const VOICE_MAX_UPLOAD_BYTES = 21 * 1024 * 1024;

function voiceErrorResponse(error: unknown): Response {
  return domainErrorResponse(error, {
    policy: "voice",
    fallback: {
      error: "voice_request_failed",
      message: "The voice request could not be completed.",
      status: 500,
    },
  });
}

async function readRequestBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!request.body) {
    throw new Error("The request body is missing.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let aborted = request.signal.aborted;
  const abort = (): void => {
    aborted = true;
    void reader.cancel().catch(() => {
      // The request is already being aborted, so there is no response to recover.
    });
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (aborted) {
        throw new DOMException("The upload was aborted.", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {
          // The size violation remains the authoritative upload error.
        });
        throw new DomainError(
          "voice_audio_too_large",
          "The recording exceeds the 20 MB limit.",
        );
      }
      chunks.push(value);
    }
  } finally {
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const voiceBaseRoutes = defineRoutes({
  "/api/voice/settings": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read or update the transcription, shared text-generation, and Live Voice models and personal speaking instructions, plus local Piper support status.",
    requestSchema: VoiceSettingsUpdateSchema,
    operations: {
      GET: {
        requestSchema: undefined,
        querySchema: undefined,
        automation: { policy: "read" },
      },
      PUT: {
        requestSchema: VoiceSettingsUpdateSchema,
        querySchema: undefined,
        automation: { policy: "excluded", reason: "Updates voice provider credentials and private configuration." },
      },
    },
    async GET(_req: Request, _ctx: RouteContext): Promise<Response> {
      try {
        return Response.json(await voiceManager.getSettings());
      } catch (error) {
        return voiceErrorResponse(error);
      }
    },
    async PUT(req: Request, _ctx: RouteContext): Promise<Response> {
      const result = await parseAndValidate(VoiceSettingsUpdateSchema, req);
      if (!result.success) {
        return result.response;
      }
      try {
        return Response.json(await voiceManager.updateSettings(result.data));
      } catch (error) {
        return voiceErrorResponse(error);
      }
    },
  },

  "/api/voice/validate": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Validate transcription, text-generation, or Live Voice; Live validation requires a browser-generated WebRTC offer.",
    requestSchema: VoiceValidationRequestSchema,
    operations: {
      POST: {
        requestSchema: VoiceValidationRequestSchema,
        querySchema: undefined,
        automation: { policy: "excluded", reason: "Private provider credential validation and browser WebRTC negotiation." },
      },
    },
    async POST(req: Request, _ctx: RouteContext): Promise<Response> {
      const result = await parseAndValidate(VoiceValidationRequestSchema, req);
      if (!result.success) {
        return result.response;
      }
      try {
        const options: { signal: AbortSignal; sdp?: string } = { signal: req.signal };
        if (result.data.capability === "live") options.sdp = result.data.sdp;
        const settings = await voiceManager.validateCapability(result.data.capability, options);
        return successResponse({ settings });
      } catch (error) {
        return voiceErrorResponse(error);
      }
    },
  },

  "/api/voice/transcribe": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Transcribe an audio recording with the user's configured provider.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "excluded", reason: "Multipart/raw audio transcription is not a JSON operation." } },
    },
    async POST(req: Request, _ctx: RouteContext): Promise<Response> {
      let form: FormData;
      try {
        const body = await readRequestBodyWithLimit(req, VOICE_MAX_UPLOAD_BYTES);
        form = await new Response(body.buffer as ArrayBuffer, {
          headers: {
            "Content-Type": req.headers.get("content-type") ?? "",
          },
        }).formData();
      } catch (error) {
        if (
          req.signal.aborted
          || error instanceof DOMException && error.name === "AbortError"
        ) {
          throw error;
        }
        if (isDomainError(error) && error.code === "voice_audio_too_large") {
          return voiceErrorResponse(error);
        }
        return errorResponse(
          "voice_invalid_audio_request",
          "The audio upload could not be read.",
          400,
        );
      }
      const file = form.get("file");
      if (!(file instanceof File)) {
        return errorResponse(
          "voice_invalid_audio_request",
          "An audio file is required.",
          400,
        );
      }

      try {
        const text = await voiceManager.transcribe(
          file,
          file.name || "recording",
          file.type || "application/octet-stream",
          req.signal,
        );
        return Response.json({ text });
      } catch (error) {
        return voiceErrorResponse(error);
      }
    },
  },

  "/api/voice/translate": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Translate selected transcript text with the user's validated shared text-generation model.",
    requestSchema: VoiceTranslationRequestSchema,
    responseSchema: VoiceTranslationResponseSchema,
    operations: {
      POST: {
        requestSchema: VoiceTranslationRequestSchema,
        querySchema: undefined,
        responseSchema: VoiceTranslationResponseSchema,
        automation: {
          policy: "excluded",
          reason: "Interactive transcript translation sends selected text to the user's configured provider.",
        },
      },
    },
    async POST(req: Request, _ctx: RouteContext): Promise<Response> {
      const result = await parseAndValidate(VoiceTranslationRequestSchema, req);
      if (!result.success) {
        return result.response;
      }
      try {
        const translatedText = await voiceManager.translateText(
          result.data.text,
          result.data.targetLanguage,
          req.signal,
        );
        return Response.json({ translatedText });
      } catch (error) {
        if (
          req.signal.aborted
          || error instanceof DOMException && error.name === "AbortError"
        ) {
          throw error;
        }
        return voiceErrorResponse(error);
      }
    },
  },
});

export function createVoiceSpeechRoutes(manager: typeof voiceManager) {
  return defineRoutes({
    "/api/chats/:id/messages/:messageId/speech": {
      auth: "user",
      sameOrigin: "mutations",
      description: "Generate a spoken summary for an existing assistant message in an owned chat.",
      operations: {
        POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "excluded", reason: "Raw synthesized audio is coordinated by the browser audio owner." } },
      },
      async POST(req: Request, ctx: RouteContext): Promise<Response> {
        return assistantMessageSpeechResponse(req, () => chatManager.getAssistantMessage(
          ctx.params["id"]!, ctx.params["messageId"]!,
        ), manager);
      },
    },
  });
}

export async function assistantMessageSpeechResponse(
  req: Request,
  getMessage: () => Promise<PersistedMessage | null>,
  manager = voiceManager,
): Promise<Response> {
  if (req.body !== null) {
    return errorResponse(
      "voice_invalid_speech_request",
      "Speech can only be generated from an existing assistant message.",
      400,
    );
  }
  try {
    const message = await getMessage();
    if (!message) {
      return errorResponse("not_found", "Assistant message not found", 404);
    }
    const speechContent = detectTrailingPromiseMarker(message.content)?.content
      ?? message.content;
    const audio = await manager.synthesizeSummarySpeech(
      speechContent,
      req.signal,
    );
    return new Response(audio.audio, {
      headers: {
        "Content-Type": audio.contentType,
        "Cache-Control": "no-store",
        "Content-Length": String(audio.audio.byteLength),
      },
    });
  } catch (error) {
    if (
      req.signal.aborted
      || error instanceof DOMException && error.name === "AbortError"
    ) {
      throw error;
    }
    return voiceErrorResponse(error);
  }
}

export const voiceRoutes = defineRoutes({
  ...voiceBaseRoutes,
  ...createVoiceSpeechRoutes(voiceManager),
});
