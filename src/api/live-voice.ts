/**
 * Global user/tab-owned WebRTC voice lifecycle and private client responses.
 */

import { createLogger, defineRoutes, type RouteContext } from "@pablozaiden/webapp/server";
import {
  LiveVoiceSessionRequestSchema, LiveVoiceHeartbeatSchema, LiveVoiceCloseSchema,
  LiveVoiceConfirmationResponseSchema, LiveVoiceCredentialResponseSchema,
} from "@/contracts/schemas/voice";
import { liveVoiceManager } from "../core/live-voice-manager";
import type { OperationAuthority } from "../core/clanky-operation-service";
import { DomainError, isDomainError } from "../domain/domain-error";
import { domainErrorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import { LIVE_AUDIO_DIAGNOSTICS_MAX_BYTES, LiveAudioDiagnosticsRequestSchema } from "@/contracts/schemas/live-voice-audio";

const log = createLogger("api:live-voice");
let authorityFactory: ((req: Request, ctx: RouteContext) => OperationAuthority) | undefined;
export function configureLiveVoiceApi(factory: NonNullable<typeof authorityFactory>): void { authorityFactory = factory; }
function authority(req: Request, ctx: RouteContext): OperationAuthority {
  if (!authorityFactory) throw new DomainError("voice_live_unavailable", "The voice operation adapter is unavailable.");
  return authorityFactory(req, ctx);
}
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
const NO_STORE = { "Cache-Control": "no-store" };

export const liveVoiceRoutes = defineRoutes({
  "/api/voice/live/audio-diagnostics": {
    auth: "user", sameOrigin: "mutations",
    description: "Publish bounded, private originating-browser media diagnostics to server logs without audio or transport addresses.",
    requestSchema: LiveAudioDiagnosticsRequestSchema,
    operations: { POST: { automation: { policy: "excluded", reason: "Browser media diagnostics are not model tools." } } },
    async POST(req) {
      const validation = await parseAndValidate(LiveAudioDiagnosticsRequestSchema, req, {
        maxBodyBytes: LIVE_AUDIO_DIAGNOSTICS_MAX_BYTES,
      });
      if (!validation.success) {
        log.warn("Live audio diagnostics request rejected", { status: validation.response.status });
        return validation.response;
      }
      try {
        const response = successResponse(liveVoiceManager.recordAudioDiagnostics(validation.data));
        response.headers.set("Cache-Control", "no-store");
        return response;
      } catch (error) { return liveErrorResponse(error); }
    },
  },
  "/api/voice/live": {
    auth: "user", sameOrigin: "mutations",
    description: "Read global Live availability or create an originating-tab-owned voice session.",
    operations: {
      GET: { automation: { policy: "excluded", reason: "Voice lifecycle is not a model tool." } },
      POST: { requestSchema: LiveVoiceSessionRequestSchema, automation: { policy: "excluded", reason: "Private SDP and call admission." } },
    },
    async GET() {
      return Response.json(liveVoiceManager.getAvailability(), { headers: NO_STORE });
    },
    async POST(req, ctx) {
      const validation = await parseAndValidate(LiveVoiceSessionRequestSchema, req);
      if (!validation.success) return validation.response;
      let auth: OperationAuthority | undefined;
      try {
        auth = authority(req, ctx);
        return Response.json(await liveVoiceManager.create({ ...validation.data, authority: auth, signal: req.signal }), {
          status: 201, headers: NO_STORE,
        });
      } catch (error) { auth?.release(); return liveErrorResponse(error); }
    },
  },
  "/api/voice/live/:callId": {
    auth: "user", sameOrigin: "mutations",
    description: "Read an owned global Live call lifecycle without transcript or provider identifiers.",
    operations: { GET: { automation: { policy: "excluded", reason: "Voice lifecycle is not a model tool." } } },
    async GET(_req, ctx) {
      try { return Response.json(liveVoiceManager.getState(ctx.params["callId"]!), { headers: NO_STORE }); }
      catch (error) { return liveErrorResponse(error); }
    },
  },
  "/api/voice/live/:callId/heartbeat": {
    auth: "user", sameOrigin: "mutations",
    description: "Renew the originating client's Live lease, authorization and revisioned UI context.",
    requestSchema: LiveVoiceHeartbeatSchema,
    operations: { POST: { automation: { policy: "excluded", reason: "Private originating-client lease." } } },
    async POST(req, ctx) {
      const validation = await parseAndValidate(LiveVoiceHeartbeatSchema, req);
      if (!validation.success) return validation.response;
      try {
        return Response.json(liveVoiceManager.heartbeat(
          ctx.params["callId"]!, validation.data.clientId, validation.data.context, authority(req, ctx),
        ), { headers: NO_STORE });
      } catch (error) { return liveErrorResponse(error); }
    },
  },
  "/api/voice/live/:callId/close": {
    auth: "user", sameOrigin: "mutations",
    description: "End the originating client's global Live call without stopping delegated work.",
    requestSchema: LiveVoiceCloseSchema,
    operations: { POST: { automation: { policy: "excluded", reason: "Voice lifecycle is not a model tool." } } },
    async POST(req, ctx) {
      const validation = await parseAndValidate(LiveVoiceCloseSchema, req);
      if (!validation.success) return validation.response;
      try {
        return Response.json(await liveVoiceManager.close(ctx.params["callId"]!, validation.data.clientId), { headers: NO_STORE });
      } catch (error) { return liveErrorResponse(error); }
    },
  },
  "/api/voice/live/:callId/confirmations/:requestId": {
    auth: "user", sameOrigin: "mutations",
    description: "Approve or reject a frozen high-risk operation from the real originating client's dialog.",
    requestSchema: LiveVoiceConfirmationResponseSchema,
    operations: { POST: { automation: { policy: "excluded", reason: "Models cannot approve operations." } } },
    async POST(req, ctx) {
      const validation = await parseAndValidate(LiveVoiceConfirmationResponseSchema, req);
      if (!validation.success) return validation.response;
      try {
        liveVoiceManager.refreshAuthority(ctx.params["callId"]!, validation.data.clientId, authority(req, ctx));
        const response = successResponse({ ...await liveVoiceManager.confirm(
          ctx.params["callId"]!, validation.data.clientId, ctx.params["requestId"]!, validation.data.approved,
        ) });
        response.headers.set("Cache-Control", "no-store");
        return response;
      } catch (error) { return liveErrorResponse(error); }
    },
  },
  "/api/voice/live/:callId/credentials/:requestId": {
    auth: "user", sameOrigin: "mutations",
    description: "Privately supply the requested SSH token to the originating call and exact pending operation.",
    requestSchema: LiveVoiceCredentialResponseSchema,
    operations: { POST: { automation: { policy: "excluded", reason: "Credential tokens never enter model tools." } } },
    async POST(req, ctx) {
      const validation = await parseAndValidate(LiveVoiceCredentialResponseSchema, req);
      if (!validation.success) return validation.response;
      try {
        liveVoiceManager.refreshAuthority(ctx.params["callId"]!, validation.data.clientId, authority(req, ctx));
        liveVoiceManager.supplyCredential(
          ctx.params["callId"]!, validation.data.clientId, ctx.params["requestId"]!, validation.data.credentialToken,
        );
        const response = successResponse({ accepted: true });
        response.headers.set("Cache-Control", "no-store");
        return response;
      } catch (error) { return liveErrorResponse(error); }
    },
  },
});
