import type { ClankyAccountStore } from "./auth/store";
import type { RuntimeConfig } from "./runtime-config";
import { createApiKey, deleteApiKey, listApiKeys } from "./auth/api-keys";
import { listAuthSessions, revokeAuthSession } from "./auth/device-auth";
import { audit, assertValidUsername, createSetupLinkRecord, createUserRecord, summarizeUser } from "./auth/users";
import { nowIso, randomToken } from "./auth/crypto";
import { getRequestBaseUrl } from "@pablozaiden/webapp/server";
import { createApiKeyRequestSchema, createUserRequestSchema, userRoleRequestSchema } from "./request-schemas";
import { defineRoutes, type RouteAutomationMetadata } from "./routes";
import { errorResponse, jsonResponse, notFound, parseJson, successResponse } from "@pablozaiden/webapp/server";

const REASON = "Account administration requires explicit application execution admission.";
const READ: RouteAutomationMetadata = { policy: "excluded", reason: REASON, execution: { policy: "read" } };
const CONFIRM: RouteAutomationMetadata = { policy: "excluded", reason: REASON, execution: { policy: "confirm" } };
const PRIVATE_CONFIRM: RouteAutomationMetadata = {
  policy: "excluded", reason: REASON, execution: { policy: "confirm", privateResponse: true, responseFormat: "file" },
};

export function createAccountRoutes(options: {
  store: ClankyAccountStore;
  config: RuntimeConfig;
  apiKeysEnabled: boolean;
  deviceAuthEnabled: boolean;
  passkeysEnabled: boolean;
}) {
  const { store, config } = options;
  function createSetupLink(req: Request, userId: string, kind: "invite" | "reset", actorUserId: string) {
    const token = randomToken(32);
    const record = createSetupLinkRecord({ userId, token, kind, createdByUserId: actorUserId });
    store.createSetupLink(record);
    const url = new URL(`${getRequestBaseUrl(req, config)}/setup`);
    url.search = `?token=${encodeURIComponent(token)}`;
    url.hash = "";
    return { url: url.toString(), expiresAt: record.expiresAt };
  }
  const keys = options.apiKeysEnabled ? defineRoutes({
    "/api/api-keys": {
      auth: "user", sameOrigin: "mutations", tags: ["account", "api-keys"],
      description: "List or create the current user's API keys. New tokens are disclosed only once.",
      operations: {
        GET: { automation: READ },
        POST: { requestSchema: createApiKeyRequestSchema, automation: PRIVATE_CONFIRM },
      },
      GET: (_req, ctx) => jsonResponse(listApiKeys(store, ctx.requireUser().id)),
      async POST(req, ctx) {
        return jsonResponse(createApiKey(store, ctx.requireUser(), await parseJson(req, createApiKeyRequestSchema)));
      },
    },
    "/api/api-keys/:id": {
      auth: "user", sameOrigin: "mutations", tags: ["account", "api-keys"],
      description: "Revoke one API key owned by the current user.",
      operations: { DELETE: { automation: CONFIRM } },
      DELETE(_req, ctx) {
        deleteApiKey(store, ctx.requireUser().id, ctx.params["id"]!);
        return successResponse();
      },
    },
  }) : {};
  const sessions = options.deviceAuthEnabled ? defineRoutes({
    "/api/auth/sessions": {
      auth: "user", sameOrigin: "mutations", tags: ["account", "sessions"],
      description: "List the current user's device sessions without their credentials.",
      operations: { GET: { automation: READ } },
      GET: (_req, ctx) => jsonResponse(listAuthSessions(store, ctx.requireUser().id)),
    },
    "/api/auth/sessions/:id": {
      auth: "user", sameOrigin: "mutations", tags: ["account", "sessions"],
      description: "Revoke one device session owned by the current user.",
      operations: { DELETE: { automation: CONFIRM } },
      DELETE: (_req, ctx) => revokeAuthSession(store, ctx.requireUser().id, ctx.params["id"]!)
        ? successResponse() : notFound(),
    },
  }) : {};
  const users = options.passkeysEnabled ? defineRoutes({
    "/api/users": {
      auth: "admin", sameOrigin: "mutations", tags: ["account", "users"],
      description: "List accounts or create a user with a private setup invitation.",
      operations: {
        GET: { automation: READ },
        POST: { requestSchema: createUserRequestSchema, automation: PRIVATE_CONFIRM },
      },
      GET: () => jsonResponse(store.listUsers().map(summarizeUser)),
      async POST(req, ctx) {
        const actor = ctx.requireAdmin();
        const body = await parseJson(req, createUserRequestSchema);
        const username = assertValidUsername(body.username ?? "");
        if (store.getUserByUsername(username)) return errorResponse(409, "username_exists", "Username already exists");
        const user = createUserRecord({ username, role: body.role ?? "user" });
        store.createUser(user);
        const setupLink = createSetupLink(req, user.id, "invite", actor.id);
        audit(store, { eventType: "user_created", actorUserId: actor.id, targetUserId: user.id, metadata: { role: user.role } });
        return jsonResponse({ user: summarizeUser(store.getUserById(user.id) ?? user), setupLink }, { status: 201 });
      },
    },
    "/api/users/:id/role": {
      auth: "admin", sameOrigin: "mutations", tags: ["account", "users"],
      description: "Change a non-owner account's role.",
      operations: { PATCH: { requestSchema: userRoleRequestSchema, automation: CONFIRM, actorInvalidation: { userParameter: "id" } } },
      async PATCH(req, ctx) {
        const actor = ctx.requireAdmin();
        const userId = ctx.params["id"]!;
        const target = store.getUserById(userId);
        if (!target) return notFound();
        if (target.role === "owner") return errorResponse(409, "owner_immutable", "Owner role cannot be changed");
        const { role } = await parseJson(req, userRoleRequestSchema);
        store.setUserRole(userId, role, nowIso());
        audit(store, { eventType: "user_role_changed", actorUserId: actor.id, targetUserId: userId, metadata: { role } });
        return jsonResponse(summarizeUser(store.getUserById(userId) ?? target));
      },
    },
    "/api/users/:id/reset": {
      auth: "admin", sameOrigin: "mutations", tags: ["account", "users"],
      description: "Reset a non-owner account's credentials and issue a private setup link.",
      operations: { POST: { automation: PRIVATE_CONFIRM, actorInvalidation: { userParameter: "id" } } },
      POST(req, ctx) {
        const actor = ctx.requireAdmin();
        const userId = ctx.params["id"]!;
        const target = store.getUserById(userId);
        if (!target) return notFound();
        if (target.role === "owner") return errorResponse(409, "owner_immutable", "Owner cannot be reset");
        const timestamp = nowIso();
        store.resetUserCredentials(userId, timestamp);
        const setupLink = createSetupLink(req, userId, "reset", actor.id);
        audit(store, { eventType: "user_reset", actorUserId: actor.id, targetUserId: userId });
        return jsonResponse({ user: summarizeUser(store.getUserById(userId) ?? target), setupLink });
      },
    },
    "/api/users/:id": {
      auth: "admin", sameOrigin: "mutations", tags: ["account", "users"],
      description: "Delete a non-owner account and its API keys.",
      operations: { DELETE: { automation: CONFIRM, actorInvalidation: { userParameter: "id" } } },
      DELETE(_req, ctx) {
        const actor = ctx.requireAdmin();
        const userId = ctx.params["id"]!;
        const target = store.getUserById(userId);
        if (!target) return notFound();
        if (target.role === "owner") return errorResponse(409, "owner_immutable", "Owner cannot be deleted");
        store.deleteApiKeysForUser(userId);
        if (!store.deleteUser(userId)) return notFound();
        audit(store, { eventType: "user_deleted", actorUserId: userId === actor.id ? undefined : actor.id,
          metadata: { deletedUserId: userId, username: target.username } });
        return successResponse();
      },
    },
    "/api/audit-events": {
      auth: "admin", sameOrigin: "mutations", tags: ["account", "diagnostics"],
      description: "Read the latest account audit events.",
      operations: { GET: { automation: READ } },
      GET: () => jsonResponse(store.listAuditEvents(100)),
    },
  }) : {};
  return { ...keys, ...sessions, ...users };
}
