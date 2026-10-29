import { AsyncLocalStorage } from "node:async_hooks";
import {
  authenticateApiKey, createLogger, getRequestOriginInfo, parseOAuthClients,
  type OAuthConfig, type OAuthPrincipal, type RouteCatalogEntry, type RouteContext,
  type WebAppServer, type WebAppStore,
} from "@pablozaiden/webapp/server";
import { routeToHash } from "@pablozaiden/webapp/web";
import {
  createMcpHandler, McpServer, ProtocolError, originValidationResponse,
  hostHeaderValidationResponse, localhostAllowedHostnames, fromJsonSchema,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ClankyRealtimeEvent } from "@/shared/realtime";
import { CLANKY_REALTIME_RESOURCES } from "@/shared/realtime";
import { CLANKY_CONTROL_SCOPE } from "@/shared/context-api-key";
import { ControlGrantSelectionSchema } from "@/contracts/schemas/control";
import { ControlSessionService, type ControlAccess } from "../core/control-session-service";
import { ControlIntegrationService } from "../core/control-integration-service";
import { ClankyOperationService } from "../core/clanky-operation-service";
import { isControlToolName } from "../core/control-tool-contracts";
import { controlGrantScopes, resolveControlGrant, resolveExecutionControlGrant, requireControlWorker, type ControlGrant } from "../core/control-authority";
import { configureExecutionControl } from "../core/control-tool-transport";
import { requireExecutionOwnerUserId, runWithAuthenticatedUser, runWithCurrentUser } from "../context/user-context";
import { toCurrentUser } from "../persistence/users";
import { DomainError, isDomainError } from "../domain/domain-error";
import { isReadRecord } from "@/shared/record";
import { configureControlApi, controlErrorResponse } from "../api/control";
import { createControlOperationAuthority } from "./control-operation-adapter";
import { CLANKY_VERSION } from "../version";

const log = createLogger("server:control");

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  return header && header.length <= 4096 ? /^Bearer[ \t]+([^\s,]+)$/i.exec(header)?.[1] : undefined;
}

function oauthClients() {
  const raw = process.env["CLANKY_MCP_OAUTH_CLIENTS"];
  try { return parseOAuthClients(raw === undefined ? [] : JSON.parse(raw)); }
  catch (error) {
    if (!(error instanceof z.ZodError) && !(error instanceof SyntaxError)) throw error;
    throw new Error("CLANKY_MCP_OAUTH_CLIENTS must be a valid registered OAuth client array.", { cause: error });
  }
}

export class ControlServer {
  readonly oauth?: OAuthConfig;
  private app?: WebAppServer<ClankyRealtimeEvent>;
  private readonly access = new AsyncLocalStorage<ControlAccess>();
  private readonly integrations: ControlIntegrationService;
  private readonly sessions: ControlSessionService;
  private readonly mcp;

  constructor(private readonly options: {
    store: WebAppStore; catalog: readonly RouteCatalogEntry[]; getBaseUrl: () => string | undefined;
  }) {
    this.integrations = new ControlIntegrationService(options.store);
    this.sessions = new ControlSessionService({
      service: new ClankyOperationService(options.catalog),
      createAuthority: (access) => createControlOperationAuthority(this.requireApp(), options.catalog, access),
      approvalUrl: (requestId) => {
        const url = new URL(this.baseUrl());
        url.hash = routeToHash({ view: "control-request", requestId });
        return url.href;
      },
      changed: (userId, id, pendingChanged) => this.requireApp().realtime.publishChanged(
        CLANKY_REALTIME_RESOURCES.controlRequests, { id, scope: pendingChanged ? "pending" : "request", target: { userId } },
      ),
    });
    this.mcp = createMcpHandler(async () => {
      const access = this.access.getStore();
      if (!access) throw new DomainError("control_scope_required", "MCP requires authenticated control admission.");
      const server = new McpServer({ name: "Clanky", version: CLANKY_VERSION });
      for (const definition of await this.sessions.tools(access)) {
        if (!isControlToolName(definition.name)) throw new Error("The MCP catalog contains a nonapplication tool.");
        const name = definition.name;
        server.registerTool(name, {
          description: definition.description, inputSchema: fromJsonSchema(definition.inputSchema),
        }, async (input, context) => {
          const result = await this.sessions.call(access, { name, input, signal: context.mcpReq.signal });
          const text = JSON.stringify(result);
          if (typeof text !== "string") throw new DomainError("control_result_invalid", "The operation returned no JSON result.");
          return { content: [{ type: "text", text }], isError: isReadRecord(result) && result["ok"] === false };
        });
      }
      return server;
    }, {
      maxRequestBodySize: 200_000,
      onerror: (error) => log[error instanceof ProtocolError ? "warn" : "error"]("MCP protocol request failed", { type: error.name }),
    });
    const base = options.getBaseUrl();
    const clients = oauthClients();
    if (base) {
      const resource = new URL("mcp", `${base.replace(/\/+$/u, "")}/`).href;
      this.oauth = {
        issuer: base.replace(/\/+$/u, ""), resource, clients,
        scopes: { [CLANKY_CONTROL_SCOPE]: "Control chats, tasks and explicitly selected Clanky resources." },
        resourceScopes: [CLANKY_CONTROL_SCOPE],
        consentPath: `/${routeToHash({ view: "control-consent" })}`,
        getConsentContext: async ({ user }) => await runWithCurrentUser(user,
          async () => await this.integrations.consentOptions()),
        authorizeConsent: async ({ user, approval }) => await runWithCurrentUser(user, async () => {
          try { return { authorizationContext: await this.integrations.selection(approval) }; }
          catch (error) {
            if (!(error instanceof z.ZodError) && (!isDomainError(error) || error.code !== "control_workspace_unavailable")) throw error;
            log.warn("OAuth control consent selection rejected");
            return false;
          }
        }),
        validateAuthorization: async (principal) => {
          try { await this.oauthGrant(principal); return true; }
          catch (error) {
            if (!(error instanceof z.ZodError) && (!isDomainError(error)
              || !["control_scope_invalid", "control_workspace_unavailable"].includes(error.code))) throw error;
            log.warn("OAuth control grant is no longer applicable");
            return false;
          }
        },
        admitResource: async (request) => {
          const token = bearer(request);
          if (!token || !authenticateApiKey(options.store, token)) return undefined;
          try { return await this.handleMcp(request, await this.keyAccess(token)); }
          catch (error) { return controlErrorResponse(error); }
        },
        handleResource: async (request, principal) => {
          try {
            const grant = await this.oauthGrant(principal);
            const authorization = request.headers.get("authorization");
            if (!authorization) throw new DomainError("control_credential_invalid", "The OAuth request has no bearer credential.");
            return await this.handleMcp(request, {
              grant, revalidate: async () => {
                const oauth = this.requireApp().oauth;
                if (!oauth) throw new DomainError("control_unavailable", "OAuth control is not configured.");
                const verified = await oauth.authenticate(new Request(resource, {
                  headers: { authorization },
                }), [CLANKY_CONTROL_SCOPE]);
                if (verified instanceof Response) {
                  await verified.body?.cancel();
                  throw new DomainError(verified.status >= 500 ? "control_unavailable" : "control_credential_invalid",
                    "The original OAuth authorization is unavailable, expired or revoked.");
                }
                return await this.oauthGrant(verified);
              },
            });
          } catch (error) { return controlErrorResponse(error); }
        },
      };
    } else if (clients.length) {
      throw new Error("Configured MCP OAuth clients require CLANKY_PUBLIC_BASE_URL or a fixed loopback listening port.");
    }
  }

  configure(app: WebAppServer<ClankyRealtimeEvent>): void {
    this.app = app;
    configureExecutionControl(async (identity) => {
      if (identity.userId !== requireExecutionOwnerUserId()) {
        throw new DomainError("control_actor_mismatch", "The control source belongs to another execution owner.");
      }
      let admittedId: string | undefined;
      const resolve = async (): Promise<ControlGrant> => {
        const account = this.options.store.getUserById(identity.userId);
        if (!account || account.disabledAt) {
          throw new DomainError("control_context_unavailable", "The execution owner is unavailable.");
        }
        return await runWithAuthenticatedUser(toCurrentUser(account),
          async () => await resolveExecutionControlGrant(identity, admittedId));
      };
      const grant = await resolve();
      admittedId = grant.id;
      const access = { grant, revalidate: resolve };
      return {
        access,
        request: async (request, signal, workerNodeId) => {
          const revalidate = async (): Promise<ControlGrant> => {
            const grant = await resolve();
            if (workerNodeId) await runWithAuthenticatedUser(grant.user,
              async () => await requireControlWorker(grant, workerNodeId));
            return grant;
          };
          const current = await revalidate();
          const bound = { grant: access.grant, revalidate };
          return await runWithAuthenticatedUser(current.user, async () => request.operation === "list"
            ? { tools: await this.sessions.tools(bound, request.chatId) }
            : await this.sessions.call(bound, {
              name: request.name, input: request.input, browser: request.context, signal,
            }));
        },
      };
    });
    configureControlApi({
      sessions: this.sessions, integrations: this.integrations,
      access: async (request, context) => await this.apiAccess(request, context),
      requireHuman: (request, context) => {
        const origin = request.headers.get("origin");
        if (context.auth.kind !== "passkey" || app.config.passkeyDisabled
          || origin !== null && origin !== getRequestOriginInfo(request, app.config).origin
          || request.method !== "GET" && origin === null) {
          throw new DomainError("control_human_required", "Sign in with a real browser passkey session to review control requests or manage integrations.");
        }
      },
      mcp: async (request, context) => await this.handleMcp(request, await this.apiAccess(request, context)),
    });
  }

  private async apiAccess(request: Request, context: RouteContext): Promise<ControlAccess> {
    const token = bearer(request);
    if (context.auth.kind !== "api-key" || !token) {
      throw new DomainError("control_scope_required", "Use an explicitly scoped Clanky control credential.");
    }
    const access = await this.keyAccess(token);
    if (access.grant.id !== `api-key:${context.auth.apiKeyId}`) {
      throw new DomainError("control_credential_invalid", "The authenticated control credential does not match.");
    }
    return access;
  }

  private async keyAccess(token: string): Promise<ControlAccess> {
    return { grant: await this.keyGrant(token), revalidate: async () => await this.keyGrant(token) };
  }

  private async keyGrant(token: string): Promise<ControlGrant> {
    const authenticated = authenticateApiKey(this.options.store, token);
    if (!authenticated) throw new DomainError("control_credential_invalid", "The control credential expired or was revoked.");
    return await runWithAuthenticatedUser(authenticated.user, async () => await resolveControlGrant({
      id: `api-key:${authenticated.apiKeyId}`, scopes: authenticated.scopes,
    }));
  }

  private async oauthGrant(principal: Readonly<OAuthPrincipal>): Promise<ControlGrant> {
    if (principal.scopes.length !== 1 || principal.scopes[0] !== CLANKY_CONTROL_SCOPE) {
      throw new DomainError("control_scope_invalid", "OAuth control requires its explicit limited resource scope.");
    }
    const selection = ControlGrantSelectionSchema.parse(principal.authorizationContext);
    return await runWithCurrentUser(principal.user, async () => await resolveControlGrant({
      id: `oauth:${principal.grantId}`, scopes: controlGrantScopes(selection),
    }));
  }

  private async handleMcp(request: Request, access: ControlAccess): Promise<Response> {
    if (new URL(request.url).searchParams.has("access_token")) {
      throw new DomainError("control_credential_invalid", "Credentials must not be sent in URL query parameters.");
    }
    const hostname = new URL(this.baseUrl()).hostname;
    const hostError = hostHeaderValidationResponse(request, [hostname, ...localhostAllowedHostnames()]);
    const originError = originValidationResponse(request, [hostname]);
    const denial = hostError ?? originError;
    if (denial) {
      log.warn("MCP request host or origin rejected");
      return denial;
    }
    return await runWithCurrentUser(access.grant.user,
      async () => await this.access.run(access, async () => await this.mcp.fetch(request)));
  }

  private baseUrl(): string {
    const base = this.options.getBaseUrl();
    if (!base) throw new DomainError("control_unavailable", "Configure a reachable Clanky base URL before using control.");
    return base;
  }

  private requireApp(): WebAppServer<ClankyRealtimeEvent> {
    if (!this.app) throw new DomainError("control_unavailable", "The control server is not initialized.");
    return this.app;
  }

  async close(): Promise<void> {
    await this.sessions.close();
    await this.mcp.close();
  }
}
