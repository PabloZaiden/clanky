import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import { bootstrapOwner, completeUserSetup, CookieJar, requestWithCookies } from "./support/passkey";
import { pollUntil } from "./support/polling";
import { findFreeLoopbackPort } from "./support/process";
import { OPERATION_TIMEOUT_MS, operationSignal } from "./support/timeouts";

type Grant = { level: "workspace"; workspaceId: string } | { level: "general" };
interface CredentialSummary {
  id: string;
  name: string;
  grant: Grant;
  createdAt: string;
  expiresAt: string;
}
interface Credential { credential: CredentialSummary; token: string }
interface Workspace { id: string; name: string }
interface Chat {
  config: { id: string; name: string };
  state: { status: string };
}
interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
interface PendingInteraction {
  ok: true;
  completion: "not_executed";
  code: "confirmation_required";
  requestId: string;
  approvalUrl: string;
  expiresAt: number;
}
interface RequestSnapshot {
  id: string;
  kind: string;
  status: string;
  description: string;
  expiresAt: number;
  operation?: {
    operationId: string;
    parameters: Array<{ name: string; value: string }>;
    query: Array<{ name: string; value: string }>;
    bodyJson: string | null;
  };
  result?: Record<string, unknown>;
}
interface OAuthGrant { id: string; clientId: string; resource: string; scopes: string[] }
interface OperationIndex {
  columns: ["operationId", "policy", "description"];
  operations: Array<[string, string, string]>;
  total: number;
}

const COMMON_TOOLS = [
  "clanky_recent_work", "clanky_waiting_work", "clanky_list_chats", "clanky_read_chat",
  "clanky_send_chat_message", "clanky_steer_queued_chat_message", "clanky_create_chat",
  "clanky_interrupt_chat", "clanky_update_chat_lifecycle", "clanky_respond_chat_interaction",
  "clanky_list_tasks", "clanky_read_task", "clanky_create_task", "clanky_instruct_task",
  "clanky_control_task", "clanky_review_task_plan", "clanky_finish_task", "clanky_list_workspaces",
  "clanky_list_servers", "clanky_create_workspace", "clanky_list_operations", "clanky_find_operations",
  "clanky_describe_operation", "clanky_execute_operation",
  "clanky_send_notification",
].sort();
const WORKSPACE_TOOLS = COMMON_TOOLS.filter((name) =>
  name !== "clanky_list_servers" && name !== "clanky_create_workspace");
const MCP_REQUEST = { timeout: OPERATION_TIMEOUT_MS };

const protocolFetch: FetchLike = (input, options) => fetch(input, {
  ...options, signal: operationSignal(options?.signal),
});

class RegisteredOAuthClient implements OAuthClientProvider {
  readonly expectedState = crypto.randomUUID();
  authorizationUrl?: URL;
  private savedTokens?: OAuthTokens;
  private verifier?: string;

  constructor(readonly issuer: string, readonly clientId: string, readonly redirectUrl: string) {}

  get clientMetadata() {
    return {
      client_name: "Clanky external-control E2E",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none" as const,
      scope: "clanky:control",
    };
  }
  clientInformation() {
    return { client_id: this.clientId, token_endpoint_auth_method: "none", issuer: this.issuer };
  }
  state() { return this.expectedState; }
  tokens() { return this.savedTokens; }
  saveTokens(tokens: OAuthTokens) { this.savedTokens = tokens; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() {
    if (!this.verifier) throw new Error("The MCP OAuth client has no S256 verifier");
    return this.verifier;
  }
}

function definitions(tools: ToolDefinition[]) {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function call<T>(client: Client, name: string, input: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: input }, undefined, MCP_REQUEST);
  expect(Array.isArray(result.content)).toBe(true);
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]!.type).toBe("text");
  expect(typeof content[0]!.text).toBe("string");
  const value = JSON.parse(content[0]!.text!) as Record<string, unknown>;
  expect(result.isError).toBe(value["ok"] === false);
  return value as T;
}

test("external MCP integrations receive explicit human grants, isolated control and revocable approvals", async () => {
  const application = await E2EApplication.create();
  const clients: Client[] = [];
  const human = new CookieJar();
  const previousDiagnostics: string[] = [];
  try {
    const port = await findFreeLoopbackPort();
    const baseUrl = `http://localhost:${String(port)}`;
    const clientId = "clanky-control-e2e";
    const redirectUri = `${baseUrl}/external-client-callback`;
    const environment = {
      CLANKY_PUBLIC_BASE_URL: baseUrl,
      CLANKY_MCP_OAUTH_CLIENTS: JSON.stringify([{
        clientId, clientName: "Clanky external-control E2E", redirectUris: [redirectUri],
        grantTypes: ["authorization_code", "refresh_token"],
      }]),
    };
    const startOptions = { disablePasskey: false, requestHostname: "localhost", port, env: environment };
    await application.start(startOptions);
    expect(application.baseUrl).toBe(baseUrl);
    await bootstrapOwner(application, human);

    async function restart(disablePasskey = false): Promise<void> {
      previousDiagnostics.push(await application.diagnostics());
      await application.restart({ ...startOptions, disablePasskey });
    }
    async function humanJson<T>(path: string, options: RequestInit = {}, status = 200): Promise<T> {
      const response = await requestWithCookies(application, human, path, {
        ...options,
        headers: { origin: application.baseUrl, ...Object.fromEntries(new Headers(options.headers)) },
      });
      expect(response.status, `${options.method ?? "GET"} ${new URL(path, baseUrl).pathname}`).toBe(status);
      return await response.json() as T;
    }
    async function denied(path: string, options: Parameters<E2EApplication["request"]>[1] = {}) {
      const response = await application.request(path, options);
      expect([401, 403], `${options.method ?? "GET"} ${new URL(path, baseUrl).pathname}`)
        .toContain(response.status);
      expect(response.headers.getSetCookie().some((cookie) =>
        cookie.startsWith("webapp_passkey_session="))).toBe(false);
      await response.body?.cancel();
    }
    async function connect(token: string): Promise<Client> {
      const client = new Client({ name: "Clanky control E2E", version: "1.0.0" });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: protocolFetch,
        reconnectionOptions: {
          maxRetries: 0, initialReconnectionDelay: 1_000,
          maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1,
        },
      }), MCP_REQUEST);
      return client;
    }
    async function credential(name: string, grant: Grant): Promise<Credential> {
      const created = await humanJson<Credential>("/api/control/credentials", {
        method: "POST", body: JSON.stringify({ name, grant, expiresInDays: 1 }),
      }, 201);
      expect(created.credential).toMatchObject({ name, grant });
      expect(typeof created.token === "string" && created.token.length > 0).toBe(true);
      expect(Date.parse(created.credential.expiresAt)).toBeGreaterThan(Date.parse(created.credential.createdAt));
      return created;
    }
    async function snapshot(id: string): Promise<RequestSnapshot> {
      return await humanJson<RequestSnapshot>(`/api/control/requests/${id}`);
    }
    async function inbox() {
      return await humanJson<Array<Pick<RequestSnapshot, "id" | "kind" | "status" | "description" | "expiresAt">>>(
        "/api/control/requests",
      );
    }
    async function decision(id: string, approved: boolean, status = 200) {
      return await humanJson<Record<string, unknown>>(`/api/control/requests/${id}/decision`, {
        method: "POST", body: JSON.stringify({ approved }),
      }, status);
    }
    async function prepareTrash(client: Client, chatId: string, name: string): Promise<PendingInteraction> {
      const requestedAt = Date.now();
      const pending = await call<PendingInteraction>(client, "clanky_update_chat_lifecycle", {
        target: chatId, action: "move_to_trash",
        confirmationDescription: `Move ${name} to Trash, stopping active work. It remains recoverable for 30 days.`,
      });
      expect(pending).toMatchObject({
        ok: true, completion: "not_executed", code: "confirmation_required",
      });
      expect(typeof pending.requestId).toBe("string");
      expect(new URL(pending.approvalUrl).origin).toBe(baseUrl);
      expect(pending.approvalUrl).toContain(pending.requestId);
      expect(pending.expiresAt).toBeGreaterThanOrEqual(requestedAt + 60 * 60_000);
      expect(pending.expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
      const frozen = await snapshot(pending.requestId);
      expect(frozen).toMatchObject({
        id: pending.requestId, kind: "confirmation", status: "pending", expiresAt: pending.expiresAt,
        operation: {
          operationId: "DELETE /api/chats/:id",
          parameters: [{ name: "id", value: chatId }], query: [], bodyJson: null,
        },
      });
      expect((await humanJson<Chat>(`/api/chats/${chatId}`)).config.id).toBe(chatId);
      return pending;
    }
    async function execute(client: Client, operationId: string, id?: string) {
      return await call<Record<string, unknown>>(client, "clanky_execute_operation", {
        operationId, parameters: id ? [{ name: "id", value: id }] : [],
        query: [], bodyJson: null, confirmationDescription: null,
      });
    }
    async function listChats(client: Client, workspace?: string) {
      const page = await call<{ items: Array<{ id: string }>; nextCursor: string | null }>(
        client, "clanky_list_chats", workspace ? { workspace } : {},
      );
      expect(Array.isArray(page.items)).toBe(true);
      expect(page).not.toHaveProperty("result");
      expect(page).not.toHaveProperty("ok");
      return page.items.map(({ id }) => id);
    }
    async function reviewOAuth(provider: RegisteredOAuthClient, grant: Grant): Promise<void> {
      expect(await auth(provider, {
        serverUrl: `${baseUrl}/mcp`, scope: "clanky:control", fetchFn: protocolFetch,
      })).toBe("REDIRECT");
      const authorizationUrl = provider.authorizationUrl!;
      expect(authorizationUrl.origin).toBe(baseUrl);
      expect(authorizationUrl.pathname).toBe("/api/oauth/authorize");
      expect(authorizationUrl.searchParams.get("scope")).toBe("clanky:control");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizationUrl.searchParams.get("resource")).toBe(`${baseUrl}/mcp`);
      const authorization = await requestWithCookies(application, human,
        `${authorizationUrl.pathname}${authorizationUrl.search}`, { redirect: "manual" });
      expect(authorization.status).toBe(303);
      const consentLocation = new URL(authorization.headers.get("location")!, baseUrl);
      expect(consentLocation.origin).toBe(baseUrl);
      expect(consentLocation.pathname).toBe("/");
      expect(consentLocation.hash).toBe("#/control-consent");
      const request = consentLocation.searchParams.get("request");
      expect(typeof request === "string" && request.length > 0).toBe(true);
      const review = await humanJson<{
        client: { clientId: string };
        scopes: Array<{ scope: string }>;
        consentContext: { workspaces: Workspace[]; generalAllowed: boolean };
      }>(`/api/oauth/consent?request=${encodeURIComponent(request!)}`);
      expect(review.scopes.map(({ scope }) => scope)).toEqual(["clanky:control"]);
      if (grant.level === "workspace") {
        expect(review.consentContext.workspaces.map(({ id }) => id)).toContain(grant.workspaceId);
      }
      const consent = await humanJson<{ redirectUri: string }>("/api/oauth/consent", {
        method: "POST", body: JSON.stringify({ request, decision: "approve", approval: grant }),
      });
      const callback = new URL(consent.redirectUri);
      expect(`${callback.origin}${callback.pathname}`).toBe(provider.redirectUrl);
      expect(callback.searchParams.get("state")).toBe(provider.expectedState);
      expect(callback.searchParams.get("iss")).toBe(baseUrl);
      const code = callback.searchParams.get("code");
      expect(typeof code === "string" && code.length > 0).toBe(true);
      expect(await auth(provider, {
        serverUrl: `${baseUrl}/mcp`, authorizationCode: code!, fetchFn: protocolFetch,
      })).toBe("AUTHORIZED");
      expect(provider.tokens()?.scope).toBe("clanky:control");
      expect(typeof provider.tokens()?.refresh_token).toBe("string");
    }

    expect(await humanJson("/api/auth/status")).toMatchObject({ authenticated: true, authKind: "passkey" });
    expect(await humanJson("/api/control/approval-policy")).toEqual({ requireApproval: true });
    const local = (await humanJson<Array<{ ref: Record<string, string> }>>("/api/execution-hosts"))
      .find((host) => host.ref["kind"] === "local")!;
    expect(local).toBeDefined();
    const firstGit = await createGitFixture(`${application.runDirectory}/first`);
    const secondGit = await createGitFixture(`${application.runDirectory}/second`);
    async function workspace(name: string, directory: string) {
      return await humanJson<Workspace>("/api/workspaces", {
        method: "POST", body: JSON.stringify({
          name, directory, executionHost: local.ref, allowClankyContext: false,
          serverSettings: { agent: { adapter: "acp", provider: "copilot" } },
        }),
      }, 201);
    }
    const first = await workspace("External collaboration", firstGit.repositoryDirectory);
    const second = await workspace("Separate project", secondGit.repositoryDirectory);
    async function chat(workspaceId: string, name: string, baseBranch: string) {
      const model = (await humanJson<Array<{ connected: boolean; providerID: string; modelID: string }>>(
        `/api/models?workspaceId=${workspaceId}`,
      )).find((candidate) => candidate.connected && candidate.providerID === "copilot")!;
      expect(model).toBeDefined();
      return (await humanJson<Chat>("/api/chats", {
        method: "POST", body: JSON.stringify({
          workspaceId, name, model: { providerID: model.providerID, modelID: model.modelID, variant: "" },
          useWorktree: false, baseBranch,
        }),
      }, 201)).config.id;
    }
    const shared = await chat(first.id, "Project discussion", firstGit.branch);
    const archived = await chat(first.id, "Finished discussion", firstGit.branch);
    const additionalArchive = await chat(first.id, "Another finished discussion", firstGit.branch);
    const foreign = await chat(second.id, "Other project discussion", secondGit.branch);
    const scoped = await credential("Workspace MCP integration", { level: "workspace", workspaceId: first.id });
    const general = await credential("General MCP integration", { level: "general" });
    const summaries = await humanJson<CredentialSummary[]>("/api/control/credentials");
    expect(summaries).toEqual(expect.arrayContaining([scoped.credential, general.credential]));
    expect(summaries.every((summary) => !("token" in summary))).toBe(true);
    const projectClient = await connect(scoped.token);
    const generalClient = await connect(general.token);
    const projectTools = (await projectClient.listTools(undefined, MCP_REQUEST)).tools;
    const generalTools = (await generalClient.listTools(undefined, MCP_REQUEST)).tools;
    expect(projectTools.map(({ name }) => name).sort()).toEqual(WORKSPACE_TOOLS);
    expect(generalTools.map(({ name }) => name).sort()).toEqual(COMMON_TOOLS);
    const index = await call<OperationIndex>(generalClient, "clanky_list_operations", {});
    expect(index.columns).toEqual(["operationId", "policy", "description"]);
    expect(index.total).toBe(index.operations.length);
    const operationIds = index.operations.map(([id]) => id);
    const discovered: string[] = [];
    let cursor: number | null = null;
    do {
      const page: { operations: Array<{ operationId: string }>; nextCursor: number | null } = await call(
        generalClient, "clanky_find_operations", { text: "", domain: null, method: null, cursor },
      );
      discovered.push(...page.operations.map(({ operationId }) => operationId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(operationIds).toEqual(discovered);
    expect(operationIds).toEqual(expect.arrayContaining([
      "GET /api/health", "GET /api/config", "GET /api/git/branches",
      "GET /api/agents", "GET /api/terminal-sessions", "GET /api/previews",
      "GET /api/mesh/status", "GET /api/voice/settings", "GET /api/mesh/relay",
      "POST /api/settings/purge-terminal-tasks",
    ]));
    for (const excluded of [
      "POST /api/control/credentials", "POST /api/control/requests/:id/decision",
      "POST /api/collaboration/invitations", "POST /api/collaboration/connections",
      "POST /api/mesh/enrollment-tokens", "PUT /api/voice/settings",
    ]) expect(operationIds).not.toContain(excluded);
    const projectIndex = await call<OperationIndex>(projectClient, "clanky_list_operations", {});
    expect(projectIndex.operations.map(([id]) => id)).not.toContain("GET /api/health");
    const diagnostic = await call<{ policy: string }>(generalClient, "clanky_describe_operation", {
      operationId: "GET /api/health",
    });
    expect(diagnostic.policy).toBe("read");
    expect(await execute(generalClient, "GET /api/health")).toMatchObject({
      ok: true, completion: "completed", data: await humanJson("/api/health"),
    });
    const branches = await call<{ ok: boolean; data: unknown }>(generalClient, "clanky_execute_operation", {
      operationId: "GET /api/git/branches", parameters: [],
      query: [{ name: "workspaceId", value: first.id }], bodyJson: null, confirmationDescription: null,
    });
    expect(branches.ok).toBe(true);
    expect(JSON.stringify(branches.data)).toContain(firstGit.branch);
    const nativeTools = (await application.json<{ tools: ToolDefinition[] }>("/api/control/tools", {
      apiKey: scoped.token,
    })).data.tools;
    expect(definitions(projectTools)).toEqual(definitions(nativeTools));
    const projectChatIds = await listChats(projectClient);
    expect(projectChatIds).toEqual(expect.arrayContaining([shared, archived]));
    expect(projectChatIds).not.toContain(foreign);
    expect(await listChats(generalClient, second.id)).toContain(foreign);
    expect(await call(generalClient, "clanky_read_chat", { target: foreign }))
      .toMatchObject({ target: { id: foreign }, section: "conversation" });

    const reviewLater = await prepareTrash(projectClient, additionalArchive, "Another finished discussion");
    expect(await inbox()).toEqual([expect.objectContaining({
      id: reviewLater.requestId, kind: "confirmation", status: "pending",
    })]);
    await denied("/api/control/requests", { apiKey: scoped.token });
    await denied("/api/control/requests", { apiKey: general.token });
    expect(await execute(generalClient, "GET /api/control/requests"))
      .toMatchObject({ ok: false, completion: "not_executed" });
    const member = await humanJson<{ setupLink: { url: string } }>("/api/users", {
      method: "POST", body: JSON.stringify({ username: "approval-reviewer", role: "user" }),
    }, 201);
    const memberCookies = new CookieJar();
    const setupToken = new URL(member.setupLink.url).searchParams.get("token");
    if (!setupToken) throw new Error("Missing member setup token.");
    await completeUserSetup(application, memberCookies, setupToken);
    const memberInbox = await requestWithCookies(application, memberCookies, "/api/control/requests", {
      headers: { origin: baseUrl },
    });
    expect(memberInbox.status).toBe(200);
    expect(await memberInbox.json()).toEqual([]);
    await denied("/api/control/approval-policy", {
      apiKey: general.token, method: "PUT", body: JSON.stringify({ requireApproval: false }),
    });
    expect(await call(generalClient, "clanky_execute_operation", {
      operationId: "PUT /api/control/approval-policy", parameters: [], query: [],
      bodyJson: JSON.stringify({ requireApproval: false }), confirmationDescription: null,
    })).toMatchObject({ ok: false, completion: "not_executed" });
    await humanJson("/api/control/approval-policy", {
      method: "PUT", body: JSON.stringify({ requireApproval: false }),
    });
    const memberPolicy = await requestWithCookies(application, memberCookies, "/api/control/approval-policy", {
      headers: { origin: baseUrl },
    });
    expect(memberPolicy.status).toBe(200);
    expect(await memberPolicy.json()).toEqual({ requireApproval: true });
    expect(await snapshot(reviewLater.requestId)).toMatchObject({ status: "pending" });
    expect((await humanJson<Chat>(`/api/chats/${additionalArchive}`)).config.id).toBe(additionalArchive);
    const automatic = await call<{
      ok: boolean;
      data: { creation: { id: string }; message: { ok: boolean } };
    }>(projectClient, "clanky_create_chat", {
      name: "Automatically admitted discussion", workspace: first.id, useWorktree: false,
      initialMessage: "Summarize this project.", open: false,
      afterCreationDescription: "Send the initial project-summary instruction.",
    });
    expect(automatic).toMatchObject({ ok: true, data: { message: { ok: true } } });
    const automaticId = automatic.data.creation.id;
    await pollUntil(async () => await humanJson<{ transcript: { messages: Array<{ role: string; content: string }> } }>(
      `/api/chats/${automaticId}/snapshot?full=1`,
    ), (snapshot) => snapshot.transcript.messages.filter(({ role, content }) =>
      role === "user" && content === "Summarize this project.").length === 1,
    { description: "automatically created chat to receive its initial instruction", timeoutMs: 10_000 });
    expect(await call(projectClient, "clanky_update_chat_lifecycle", {
      target: automaticId, action: "move_to_trash",
    })).toMatchObject({ ok: true, completion: "completed" });
    expect((await humanJson<{ items: Array<{ id: string }> }>("/api/trash")).items.map(({ id }) => id))
      .toContain(automaticId);
    expect((await inbox()).map(({ id }) => id)).toEqual([reviewLater.requestId]);
    await humanJson("/api/control/approval-policy", {
      method: "PUT", body: JSON.stringify({ requireApproval: true }),
    });
    const hostNote = "The external integration reads the selected execution host.";
    const hostFile = "external-handoff.txt";
    await Bun.write(`${firstGit.repositoryDirectory}/${hostFile}`, hostNote);
    const handoff = await call<{
      ok: boolean; data: { content: string };
    }>(generalClient, "clanky_execute_operation", {
      operationId: "GET /api/execution-hosts/:kind/:id/files/content",
      parameters: [{ name: "kind", value: local.ref["kind"] }, { name: "id", value: local.ref["nodeId"] }],
      query: [{ name: "path", value: hostFile }, { name: "startDirectory", value: firstGit.repositoryDirectory }],
      bodyJson: null, confirmationDescription: null,
    });
    expect(handoff.ok).toBe(true);
    expect(handoff.data.content).toBe(hostNote);
    expect((await inbox()).map(({ id }) => id)).toEqual([reviewLater.requestId]);

    const message = "External integration: preserve this literal project handoff.";
    expect(await call(projectClient, "clanky_send_chat_message", { target: shared, message }))
      .toMatchObject({ ok: true });
    const read = await pollUntil(
      async () => await call<Record<string, unknown>>(projectClient, "clanky_read_chat", { target: shared }),
      (value) => JSON.stringify(value["content"]).includes(message),
      { description: "literal external-control handoff in project history" },
    );
    expect(read).toHaveProperty("content");
    await pollUntil(async () => await humanJson<Chat>(`/api/chats/${shared}`),
      (value) => value.state.status === "idle" || value.state.status === "failed",
      { description: "external-control message turn to finish", timeoutMs: 10_000 });
    expect((await humanJson<Chat>(`/api/chats/${shared}`)).state.status).toBe("idle");
    expect(await call(projectClient, "clanky_read_chat", { target: foreign }))
      .toMatchObject({ ok: false, completion: "not_executed" });
    expect(await call(projectClient, "clanky_list_chats", { workspace: second.id }))
      .toMatchObject({ ok: false, completion: "not_executed" });
    expect(await execute(projectClient, "GET /api/execution-hosts"))
      .toMatchObject({ ok: false, completion: "not_executed" });
    expect(await execute(projectClient, "GET /api/chats/:id", foreign))
      .toMatchObject({ ok: false, completion: "not_executed" });
    for (const path of ["/api/workspaces", `/api/chats/${foreign}`, "/api/users", "/api/api-keys"]) {
      await denied(path, { apiKey: scoped.token });
    }
    await denied(`/api/chats/${shared}`, { apiKey: scoped.token, method: "DELETE" });
    await denied("/api/api-keys", {
      apiKey: scoped.token, method: "POST", body: JSON.stringify({ name: "Escalation", scopes: ["*"] }),
    });
    await denied("/api/passkey-auth/api-key", {
      method: "POST", body: JSON.stringify({ apiKey: scoped.token }),
    });
    await denied("/api/control/credentials", {
      apiKey: scoped.token, method: "POST",
      body: JSON.stringify({ name: "Self-granted general access", grant: { level: "general" }, expiresInDays: 1 }),
    });
    const apiKey = await humanJson<{ token: string }>("/api/api-keys", {
      method: "POST", body: JSON.stringify({ name: "Ordinary API client", scopes: ["*"] }),
    });
    await denied("/api/control/requests", { apiKey: apiKey.token });
    await denied("/api/control/credentials", {
      apiKey: apiKey.token, method: "POST",
      body: JSON.stringify({ name: "API self-grant", grant: { level: "general" }, expiresInDays: 1 }),
    });

    const rejected = await prepareTrash(projectClient, shared, "Project discussion");
    await denied(`/api/control/requests/${rejected.requestId}/decision`, {
      apiKey: scoped.token, method: "POST", body: JSON.stringify({ approved: true }),
    });
    expect((await application.json<RequestSnapshot>(`/api/control/requests/${rejected.requestId}`, {
      apiKey: scoped.token,
    })).data.status).toBe("pending");
    const foreignSnapshot = await application.request(`/api/control/requests/${rejected.requestId}`, {
      apiKey: general.token,
    });
    expect(foreignSnapshot.status).toBe(410);
    await foreignSnapshot.body?.cancel();
    expect(await decision(rejected.requestId, false))
      .toMatchObject({ ok: true, completion: "not_executed", code: "confirmation_rejected" });
    expect(await snapshot(rejected.requestId)).toMatchObject({
      status: "completed", result: { code: "confirmation_rejected" },
    });
    expect((await inbox()).map(({ id }) => id)).not.toContain(rejected.requestId);
    await decision(rejected.requestId, true, 410);
    expect((await humanJson<Chat>(`/api/chats/${shared}`)).config.id).toBe(shared);

    const changed = await prepareTrash(projectClient, shared, "Project discussion");
    await humanJson(`/api/chats/${shared}`, {
      method: "PATCH", body: JSON.stringify({ name: "Updated project discussion" }),
    });
    expect(await decision(changed.requestId, true))
      .toMatchObject({ ok: false, completion: "not_executed", code: "confirmation_target_changed" });
    expect((await humanJson<Chat>(`/api/chats/${shared}`)).config.name).toBe("Updated project discussion");

    const lostGrant = await prepareTrash(generalClient, shared, "Updated project discussion");
    expect(await humanJson(`/api/control/credentials/${general.credential.id}`, { method: "DELETE" }))
      .toEqual({ revoked: true });
    await decision(lostGrant.requestId, true, 401);
    await denied("/api/control/tools", { apiKey: general.token });
    expect((await humanJson<Chat>(`/api/chats/${shared}`)).config.id).toBe(shared);

    const resourceMetadata = await application.json<{
      resource: string; authorization_servers: string[]; scopes_supported: string[];
    }>("/.well-known/oauth-protected-resource/mcp");
    expect(resourceMetadata.data).toMatchObject({
      resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl], scopes_supported: ["clanky:control"],
    });
    const metadata = (await application.json<Record<string, unknown>>(
      "/.well-known/oauth-authorization-server",
    )).data;
    expect(metadata).toMatchObject({
      issuer: baseUrl, authorization_endpoint: `${baseUrl}/api/oauth/authorize`,
      token_endpoint: `${baseUrl}/api/oauth/token`, code_challenge_methods_supported: ["S256"],
    });
    expect(metadata).not.toHaveProperty("registration_endpoint");
    const oauth = new RegisteredOAuthClient(baseUrl, clientId, redirectUri);
    await reviewOAuth(oauth, { level: "workspace", workspaceId: first.id });
    const oauthClient = await connect(oauth.tokens()!.access_token);
    expect((await oauthClient.listTools(undefined, MCP_REQUEST)).tools.map(({ name }) => name).sort())
      .toEqual(WORKSPACE_TOOLS);
    expect(await listChats(oauthClient)).toContain(shared);
    expect(await call(oauthClient, "clanky_read_chat", { target: foreign }))
      .toMatchObject({ ok: false, completion: "not_executed" });
    for (const path of ["/api/control/tools", `/api/chats/${shared}`, "/api/users", "/api/api-keys"]) {
      await denied(path, { apiKey: oauth.tokens()!.access_token });
    }
    await denied("/api/control/credentials", {
      apiKey: oauth.tokens()!.access_token, method: "POST",
      body: JSON.stringify({ name: "OAuth self-grant", grant: { level: "general" }, expiresInDays: 1 }),
    });
    await denied("/api/auth/client-ticket", {
      apiKey: oauth.tokens()!.access_token, method: "POST",
      body: JSON.stringify({ kind: "websocket", url: "/api/ws" }),
    });

    const approved = await prepareTrash(oauthClient, archived, "Finished discussion");
    await denied(`/api/control/requests/${approved.requestId}/decision`, {
      apiKey: oauth.tokens()!.access_token, method: "POST", body: JSON.stringify({ approved: true }),
    });
    const beforeRefresh = await humanJson<{ grants: OAuthGrant[] }>("/api/oauth/grants");
    expect(beforeRefresh.grants).toHaveLength(1);
    const grantId = beforeRefresh.grants[0]!.id;
    expect(beforeRefresh.grants[0]).toMatchObject({
      clientId, resource: `${baseUrl}/mcp`, scopes: ["clanky:control"],
    });
    const oldAccessToken = oauth.tokens()!.access_token;
    expect(await auth(oauth, {
      serverUrl: `${baseUrl}/mcp`, fetchFn: protocolFetch,
    })).toBe("AUTHORIZED");
    expect(oauth.tokens()!.access_token !== oldAccessToken).toBe(true);
    const refreshedClient = await connect(oauth.tokens()!.access_token);
    expect(await listChats(refreshedClient)).toContain(archived);
    expect((await humanJson<{ grants: OAuthGrant[] }>("/api/oauth/grants")).grants.map(({ id }) => id))
      .toEqual([grantId]);
    expect(await decision(approved.requestId, true)).toMatchObject({ ok: true, completion: "completed" });
    expect(await snapshot(approved.requestId)).toMatchObject({
      status: "completed", result: { ok: true, completion: "completed" },
    });
    await decision(approved.requestId, true, 410);
    expect((await humanJson<{ items: Array<{ id: string }> }>("/api/trash")).items
      .filter(({ id }) => id === archived)).toHaveLength(1);
    expect((await inbox()).map(({ id }) => id)).toContain(reviewLater.requestId);
    expect(await decision(reviewLater.requestId, true)).toMatchObject({ ok: true, completion: "completed" });
    expect((await inbox()).map(({ id }) => id)).not.toContain(reviewLater.requestId);
    expect((await humanJson<{ items: Array<{ id: string }> }>("/api/trash")).items.map(({ id }) => id))
      .toEqual(expect.arrayContaining([archived, additionalArchive]));

    const pendingRestart = await prepareTrash(refreshedClient, shared, "Updated project discussion");
    await humanJson("/api/control/approval-policy", {
      method: "PUT", body: JSON.stringify({ requireApproval: false }),
    });
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await restart();
    expect(await humanJson("/api/control/approval-policy")).toEqual({ requireApproval: false });
    expect(await inbox()).toEqual([]);
    await decision(pendingRestart.requestId, true, 410);
    expect((await humanJson<Chat>(`/api/chats/${shared}`)).config.id).toBe(shared);
    const resumed = await connect(oauth.tokens()!.access_token);
    expect(await listChats(resumed)).toContain(shared);
    expect(await call(resumed, "clanky_read_chat", { target: foreign }))
      .toMatchObject({ ok: false, completion: "not_executed" });
    const persistedService = await connect(scoped.token);
    expect((await persistedService.listTools(undefined, MCP_REQUEST)).tools.map(({ name }) => name).sort())
      .toEqual(WORKSPACE_TOOLS);
    await denied("/api/control/tools", { apiKey: general.token });
    await humanJson(`/api/oauth/grants?id=${encodeURIComponent(grantId)}`, { method: "DELETE" });
    await expect(resumed.listTools(undefined, MCP_REQUEST)).rejects.toThrow();
    expect(await humanJson(`/api/control/credentials/${scoped.credential.id}`, { method: "DELETE" }))
      .toEqual({ revoked: true });
    await expect(persistedService.listTools(undefined, MCP_REQUEST)).rejects.toThrow();
    expect(await humanJson<CredentialSummary[]>("/api/control/credentials")).toEqual([]);

    await Promise.all(clients.splice(0).map((client) => client.close()));
    await restart();
    await denied("/api/control/tools", { apiKey: scoped.token });
    await expect(connect(oauth.tokens()!.access_token)).rejects.toThrow();
    await decision(pendingRestart.requestId, true, 410);
    expect((await humanJson<Chat>(`/api/chats/${shared}`)).config.id).toBe(shared);
    expect((await humanJson<{ items: Array<{ id: string }> }>("/api/trash")).items
      .filter(({ id }) => id === archived)).toHaveLength(1);

    await restart(true);
    await denied("/api/control/approval-policy", {
      method: "PUT", body: JSON.stringify({ requireApproval: false }),
    });
    await denied("/api/control/requests");
    await denied("/api/control/credentials", {
      method: "POST",
      body: JSON.stringify({ name: "Emergency bypass is not consent", grant: { level: "general" }, expiresInDays: 1 }),
    });
  } catch (error) {
    console.error([...previousDiagnostics, await application.diagnostics()].join("\n"));
    throw error;
  } finally {
    try {
      await Promise.all(clients.map((client) => client.close()));
    } finally {
      try {
        await application.stop();
      } finally {
        await application.cleanup();
      }
    }
  }
}, 120_000);
