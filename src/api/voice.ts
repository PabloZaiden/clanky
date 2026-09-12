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
import { domainErrorResponse, errorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";

function voiceErrorResponse(error: unknown): Response {
  const response = domainErrorResponse(error, {
    fallback: {
      error: "voice_request_failed",
      message: "The voice request could not be completed.",
      status: 500,
    },
    mappings: {
      voice_invalid_base_url: { status: 400 },
      voice_provider_invalid_request: { status: 400 },
      voice_not_configured: { status: 409 },
      voice_capability_not_configured: { status: 409 },
      voice_capability_unavailable: { status: 409 },
      voice_audio_too_large: { status: 413 },
      voice_text_too_large: { status: 413 },
      voice_provider_rate_limited: { status: 502 },
      voice_provider_unreachable: { status: 502 },
      voice_provider_request_failed: { status: 502 },
      voice_provider_invalid_response: { status: 502 },
      voice_provider_response_too_large: { status: 502 },
      voice_tts_rate_limited: { status: 429 },
    },
  });
  if (
    isDomainError(error)
    && error.code === "voice_tts_rate_limited"
  ) {
    const retryAfter = error.details["retryAfterSeconds"];
    if (typeof retryAfter === "number") {
      response.headers.set("Retry-After", String(retryAfter));
    }
  }
  return response;
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
      const contentLength = Number(req.headers.get("content-length") ?? "0");
      if (contentLength > 21 * 1024 * 1024) {
        return errorResponse(
          "voice_audio_too_large",
          "The recording exceeds the 20 MB limit.",
          413,
        );
      }

      let form: FormData;
      try {
        form = await req.formData();
      } catch (error) {
        return errorResponse(
          "voice_invalid_audio_request",
          `The audio upload could not be read: ${String(error)}`,
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
