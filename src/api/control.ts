import { createLogger, defineRoutes, type RouteContext } from "@pablozaiden/webapp/server";
import {
  ControlToolInvocationSchema, ControlToolsQuerySchema, ControlToolsResponseSchema,
  ControlRequestSnapshotSchema, ControlDecisionSchema, ControlCredentialHandoffSchema,
  CreateControlCredentialSchema, ControlCredentialSummarySchema,
} from "@/contracts/schemas/control";
import { z } from "zod";
import { CLANKY_CONTROL_SCOPE } from "@/shared/context-api-key";
import { CONTROL_INTERACTION_TAG } from "../core/control-authority";
import type { ControlAccess, ControlSessionService } from "../core/control-session-service";
import type { ControlIntegrationService } from "../core/control-integration-service";
import { DomainError, isDomainError } from "../domain/domain-error";
import { parseAndValidate } from "./validation";
import { errorResponse } from "./helpers";

const log = createLogger("api:control");
const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const ERROR_STATUS: Readonly<Record<string, number>> = {
  control_scope_required: 403, control_scope_invalid: 403, control_actor_mismatch: 403,
  control_origin_invalid: 403, control_workspace_administration_forbidden: 403,
  control_operation_unavailable: 403, control_reference_invalid: 400,
  control_credential_invalid: 401, control_credential_unavailable: 404,
  control_workspace_unavailable: 404, control_context_unavailable: 410,
  control_authority_unavailable: 403, control_context_ended: 410,
  control_request_unavailable: 410, control_tool_unavailable: 404,
  control_client_unavailable: 409, control_human_required: 403,
  control_busy: 429, control_credential_limit: 409, control_cancelled: 499,
  control_unavailable: 503,
};

interface ControlApi {
  sessions: ControlSessionService;
  integrations: ControlIntegrationService;
  access: (request: Request, context: RouteContext) => Promise<ControlAccess>;
  requireHuman: (request: Request, context: RouteContext) => void;
  mcp: (request: Request, context: RouteContext) => Promise<Response>;
}
let configured: ControlApi | undefined;
export function configureControlApi(api: ControlApi): void { configured = api; }
function control(): ControlApi {
  if (!configured) throw new DomainError("control_unavailable", "Application control is unavailable.");
  return configured;
}

export function controlErrorResponse(error: unknown): Response {
  const code = isDomainError(error) ? error.code : error instanceof z.ZodError ? "invalid_arguments" : "control_failed";
  const status = error instanceof z.ZodError ? 400 : ERROR_STATUS[code] ?? 500;
  log[status >= 500 ? "error" : "warn"]("Control request failed", { code, status });
  const response = errorResponse(code,
    isDomainError(error) && status < 500 ? error.message : "The control request could not be completed.",
    status, { ok: false, code, completion: status >= 500 ? "outcome_unknown" : "not_executed" });
  for (const [name, value] of Object.entries(NO_STORE)) response.headers.set(name, value);
  return response;
}

const EXCLUDED = { policy: "excluded", reason: "Private control admission or human-only interaction, never an executable agent operation." } as const;

export const controlRoutes = defineRoutes({
  "/api/control/tools": {
    auth: "user", sameOrigin: "mutations", scopes: [CLANKY_CONTROL_SCOPE], tags: ["control"],
    description: "Discover the scoped control catalog. Real managed-chat provenance may additionally enable optional browser tools.",
    operations: { GET: { querySchema: ControlToolsQuerySchema, responseSchema: ControlToolsResponseSchema, automation: EXCLUDED } },
    async GET(req, ctx) {
      try {
        const api = control();
        const query = ControlToolsQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
        return Response.json({ tools: await api.sessions.tools(await api.access(req, ctx), query.chatId) }, { headers: NO_STORE });
      } catch (error) { return controlErrorResponse(error); }
    },
  },
  "/api/control/tools/:name": {
    auth: "user", sameOrigin: "mutations", scopes: [CLANKY_CONTROL_SCOPE], tags: ["control"],
    description: "Invoke one authorized shared control tool. Browser context is provenance, not authority.",
    operations: { POST: { requestSchema: ControlToolInvocationSchema, automation: EXCLUDED } },
    async POST(req, ctx) {
      const body = await parseAndValidate(ControlToolInvocationSchema, req, { maxBodyBytes: 200_000 });
      if (!body.success) return body.response;
      try {
        const api = control();
        return Response.json(await api.sessions.call(await api.access(req, ctx), {
          name: ctx.params["name"]!, input: body.data.input, browser: body.data.context, signal: req.signal,
        }), { headers: NO_STORE });
      } catch (error) { return controlErrorResponse(error); }
    },
  },
  "/api/control/requests/:id": {
    auth: "user", sameOrigin: "mutations", scopes: [CLANKY_CONTROL_SCOPE],
    tags: ["control", CONTROL_INTERACTION_TAG],
    description: "Read a bounded pending control request or its result. Agents can only inspect requests belonging to their original credential.",
    operations: { GET: { responseSchema: ControlRequestSnapshotSchema, automation: { policy: "read" } } },
    async GET(req, ctx) {
      try {
        const api = control();
        if (ctx.auth.kind === "api-key") {
          const access = await api.access(req, ctx);
          return Response.json(api.sessions.withCredential(access.grant.credentialId,
            () => api.sessions.getRequest(ctx.params["id"]!)), { headers: NO_STORE });
        }
        if (ctx.auth.kind !== "server") api.requireHuman(req, ctx);
        return Response.json(api.sessions.getRequest(ctx.params["id"]!), { headers: NO_STORE });
      } catch (error) { return controlErrorResponse(error); }
    },
  },
  "/api/control/requests/:id/decision": {
    auth: "user", sameOrigin: "always", tags: ["control"],
    description: "Human-only approval or rejection of an exact frozen control operation.",
    operations: { POST: { requestSchema: ControlDecisionSchema, automation: EXCLUDED } },
    async POST(req, ctx) {
      try {
        const api = control();
        api.requireHuman(req, ctx);
        const body = await parseAndValidate(ControlDecisionSchema, req);
        if (!body.success) return body.response;
        return Response.json(await api.sessions.decide(ctx.params["id"]!, body.data.approved, req.signal), { headers: NO_STORE });
      } catch (error) { return controlErrorResponse(error); }
    },
  },
  "/api/control/requests/:id/credential": {
    auth: "user", sameOrigin: "always", tags: ["control"],
    description: "Privately hand off a browser SSH token to its exact pending control operation.",
    operations: { POST: { requestSchema: ControlCredentialHandoffSchema, automation: EXCLUDED } },
    async POST(req, ctx) {
      try {
        const api = control();
        api.requireHuman(req, ctx);
        const body = await parseAndValidate(ControlCredentialHandoffSchema, req, { maxBodyBytes: 8192 });
        if (!body.success) return body.response;
        return Response.json(await api.sessions.supplyCredential(ctx.params["id"]!, body.data.credentialToken), { headers: NO_STORE });
      } catch (error) { return controlErrorResponse(error); }
    },
  },
  "/api/control/consent-options": {
    auth: "user", sameOrigin: "always", tags: ["control"],
    description: "Read human grant choices for named scoped integrations.",
    operations: { GET: { automation: EXCLUDED } },
    async GET(req, ctx) {
      try {
        const api = control();
        api.requireHuman(req, ctx);
        return Response.json(await api.integrations.consentOptions(), { headers: NO_STORE });
      } catch (error) { return controlErrorResponse(error); }
    },
  },
  "/api/control/credentials": {
    auth: "user", sameOrigin: "always", tags: ["control"],
    description: "Human-only named scoped service credentials. Tokens are returned only once, on creation.",
    operations: {
      GET: { responseSchema: z.array(ControlCredentialSummarySchema), automation: EXCLUDED },
      POST: { requestSchema: CreateControlCredentialSchema, automation: EXCLUDED },
    },
    async GET(req, ctx) {
      try {
        const api = control();
        api.requireHuman(req, ctx);
        return Response.json(api.integrations.list(), { headers: NO_STORE });
      } catch (error) { return controlErrorResponse(error); }
    },
    async POST(req, ctx) {
      try {
        const api = control();
        api.requireHuman(req, ctx);
        const body = await parseAndValidate(CreateControlCredentialSchema, req);
        if (!body.success) return body.response;
        const result = await api.integrations.create(body.data);
        ctx.realtime.publishChanged("control-credentials");
        return Response.json(result, { status: 201, headers: NO_STORE });
      } catch (error) { return controlErrorResponse(error); }
    },
  },
  "/api/control/credentials/:id": {
    auth: "user", sameOrigin: "always", tags: ["control"],
    description: "Human-only revocation of an owned named control integration.",
    operations: { DELETE: { automation: EXCLUDED } },
    async DELETE(req, ctx) {
      try {
        const api = control();
        api.requireHuman(req, ctx);
        api.integrations.revoke(ctx.params["id"]!);
        ctx.realtime.publishChanged("control-credentials");
        return Response.json({ revoked: true }, { headers: NO_STORE });
      } catch (error) { return controlErrorResponse(error); }
    },
  },
});

export const mcpRoutes = defineRoutes({
  "/mcp": {
    auth: "user", sameOrigin: "never", scopes: [CLANKY_CONTROL_SCOPE], tags: ["control"],
    description: "Scoped MCP HTTP service admission. Configured OAuth mounts reserve this exact resource before application routing.",
    operations: {
      GET: { automation: EXCLUDED }, POST: { automation: EXCLUDED }, DELETE: { automation: EXCLUDED },
    },
    async GET(req, ctx) { try { return await control().mcp(req, ctx); } catch (error) { return controlErrorResponse(error); } },
    async POST(req, ctx) { try { return await control().mcp(req, ctx); } catch (error) { return controlErrorResponse(error); } },
    async DELETE(req, ctx) { try { return await control().mcp(req, ctx); } catch (error) { return controlErrorResponse(error); } },
  },
});
