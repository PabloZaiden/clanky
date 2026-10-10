/**
 * Authenticated, chat-scoped WebRTC session initialization and call lifecycle.
 */

import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import { LiveVoiceSessionRequestSchema } from "@/contracts/schemas";
import { liveVoiceManager } from "../core/live-voice-manager";
import { isDomainError } from "../domain/domain-error";
import { domainErrorResponse } from "./helpers";
import { parseAndValidate } from "./validation";

const log = createLogger("api:live-voice");
function liveErrorResponse(error: unknown): Response {
  const response = domainErrorResponse(error, {
    policy: "voice",
    fallback: { error: "voice_live_failed", message: "The Live call could not be completed.", status: 500 },
  });
  log[response.status >= 500 ? "error" : "warn"]("Live call request failed", {
    code: isDomainError(error) ? error.code : "unexpected_error", status: response.status,
  });
  return response;
}

export const liveVoiceRoutes = defineRoutes({
  "/api/chats/:id/live-voice": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Create a WebRTC voice session for the linked Quick Chat without exposing provider credentials.",
    requestSchema: LiveVoiceSessionRequestSchema,
    async POST(req, ctx) {
      const validation = await parseAndValidate(LiveVoiceSessionRequestSchema, req);
      if (!validation.success) return validation.response;
      try {
        return Response.json(await liveVoiceManager.create(
          ctx.params["id"]!, validation.data.sdp, validation.data.clientId, req.signal,
        ), { status: 201, headers: { "Cache-Control": "no-store" } });
      } catch (error) { return liveErrorResponse(error); }
    },
  },
  "/api/chats/:id/live-voice/:callId/heartbeat": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Keep an owned Live call alive and read its current lifecycle state.",
    async POST(_req, ctx) {
      try {
        return Response.json(liveVoiceManager.heartbeat(ctx.params["id"]!, ctx.params["callId"]!), {
          headers: { "Cache-Control": "no-store" },
        });
      } catch (error) { return liveErrorResponse(error); }
    },
  },
  "/api/chats/:id/live-voice/:callId/close": {
    auth: "user",
    sameOrigin: "mutations",
    description: "End an owned Live call and save its conversation summary without stopping the agent.",
    async POST(_req, ctx) {
      try {
        return Response.json(await liveVoiceManager.close(ctx.params["id"]!, ctx.params["callId"]!), {
          headers: { "Cache-Control": "no-store" },
        });
      } catch (error) { return liveErrorResponse(error); }
    },
  },
});
