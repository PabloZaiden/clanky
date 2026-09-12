/**
 * Authenticated API routes for the optional per-user voice features.
 */

import { defineRoutes, type RouteContext } from "@pablozaiden/webapp/server";
import type { VoiceCapability } from "@/shared";
import {
  VoiceSettingsUpdateSchema,
  VoiceSpeechRequestSchema,
  VoiceValidationRequestSchema,
} from "@/contracts/schemas";
import { voiceManager } from "../core/voice-manager";
import { isDomainError } from "../core/domain-error";
import { DomainError } from "../domain/domain-error";
import { domainErrorResponse, errorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";

const VOICE_MAX_UPLOAD_BYTES = 21 * 1024 * 1024;

function voiceErrorResponse(error: unknown): Response {
  const response = domainErrorResponse(error, {
    fallback: {
      error: "voice_request_failed",
      message: "The voice request could not be completed.",
      status: 500,
    },
    mappings: {
      voice_invalid_base_url: { status: 400 },
      voice_unsafe_provider_url: { status: 400 },
      voice_provider_invalid_request: { status: 400 },
      voice_not_configured: { status: 409 },
      voice_capability_not_configured: { status: 409 },
      voice_capability_unavailable: { status: 409 },
      voice_validation_stale: { status: 409 },
      voice_audio_too_large: { status: 413 },
      voice_text_too_large: { status: 413 },
      voice_provider_rate_limited: { status: 429 },
      voice_provider_unreachable: { status: 502 },
      voice_provider_timeout: { status: 504 },
      voice_provider_redirect: { status: 502 },
      voice_provider_request_failed: { status: 502 },
      voice_provider_invalid_response: { status: 502 },
      voice_provider_response_too_large: { status: 502 },
    },
  });
  if (isDomainError(error) && error.code === "voice_provider_rate_limited") {
    const retryAfter = error.details["retryAfter"];
    if (typeof retryAfter === "string") {
      response.headers.set("Retry-After", retryAfter);
    }
  }
  return response;
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

export const voiceRoutes = defineRoutes({
  "/api/voice/settings": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read or update the current user's voice provider settings.",
    requestSchema: VoiceSettingsUpdateSchema,
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
    description: "Validate one configured voice capability against its provider.",
    requestSchema: VoiceValidationRequestSchema,
    async POST(req: Request, _ctx: RouteContext): Promise<Response> {
      const result = await parseAndValidate(VoiceValidationRequestSchema, req);
      if (!result.success) {
        return result.response;
      }
      try {
        const settings = await voiceManager.validateCapability(
          result.data.capability as VoiceCapability,
          req.signal,
        );
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

  "/api/voice/speech": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Generate speech for a full response or a generated summary.",
    requestSchema: VoiceSpeechRequestSchema,
    async POST(req: Request, _ctx: RouteContext): Promise<Response> {
      const result = await parseAndValidate(VoiceSpeechRequestSchema, req);
      if (!result.success) {
        return result.response;
      }
      try {
        const audio = await voiceManager.synthesizeSpeech(
          result.data.text,
          result.data.mode,
          result.data.voice,
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
        return voiceErrorResponse(error);
      }
    },
  },
});
