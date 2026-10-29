import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import { bootstrapOwner, CookieJar, requestWithCookies } from "./support/passkey";
import { pollUntil } from "./support/polling";
import { findFreeLoopbackPort, readProcessDiagnostics } from "./support/process";
import {
  startEphemeralSshServer, stopEphemeralSshServer, type ManagedSshServer,
} from "./support/ssh-server";
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
  code: "confirmation_required" | "credential_required";
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

const COMMON_TOOLS = [
  "clanky_recent_work", "clanky_waiting_work", "clanky_list_chats", "clanky_read_chat",
  "clanky_send_chat_message", "clanky_steer_queued_chat_message", "clanky_create_chat",
  "clanky_interrupt_chat", "clanky_update_chat_lifecycle", "clanky_respond_chat_interaction",
  "clanky_list_tasks", "clanky_read_task", "clanky_create_task", "clanky_instruct_task",
  "clanky_control_task", "clanky_review_task_plan", "clanky_finish_task", "clanky_list_workspaces",
  "clanky_list_servers", "clanky_create_workspace", "clanky_find_operations",
  "clanky_describe_operation", "clanky_execute_operation",
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
  let ssh: ManagedSshServer | undefined;
  try {
    const port = await findFreeLoopbackPort();
    const baseUrl = `http://localhost:${String(port)}`;
    const clientId = "clanky-control-e2e";
    const redirectUri = `${baseUrl}/external-client-callback`;
    ssh = await startEphemeralSshServer({
      runDirectory: application.runDirectory, clientHomeDirectory: application.homeDirectory,
      providerBinDirectory: application.providerBinDirectory,
    });
    const environment = {
      SSH_AUTH_SOCK: ssh.agentSocket,
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
    async function decision(id: string, approved: boolean, status = 200) {
      return await humanJson<Record<string, unknown>>(`/api/control/requests/${id}/decision`, {
        method: "POST", body: JSON.stringify({ approved }),
      }, status);
    }
    async function prepareTrash(client: Client, chatId: string, name: string): Promise<PendingInteraction> {
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
      expect(pending.expiresAt).toBeGreaterThan(Date.now());
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

    const expiring = await prepareTrash(projectClient, archived, "Finished discussion");
    const hostNote = "The external integration reads this private SSH handoff only after human credential entry.";
    const hostFile = "external-handoff.txt";
    await Bun.write(`${firstGit.repositoryDirectory}/${hostFile}`, hostNote);
    const server = await humanJson<{ config: { id: string } }>("/api/ssh-servers", {
      method: "POST", body: JSON.stringify({
        name: "External SSH host", address: "127.0.0.1", port: ssh.port, username: ssh.username,
        repositoriesBasePath: firstGit.repositoryDirectory,
      }),
    }, 201);
    const publicKey = await humanJson<{
      publicKey: string; algorithm: string; fingerprint: string; version: number;
    }>(`/api/ssh-servers/${server.config.id}/public-key`);
    const encryptionKey = await crypto.subtle.importKey("spki", Uint8Array.from(Buffer.from(
      publicKey.publicKey.replace(/-----[^-]+-----|\s/g, ""), "base64",
    )).buffer, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    // The existing SSH fixture uses an empty password to select its real key/agent.
    const ciphertext = Buffer.from(await crypto.subtle.encrypt(
      { name: "RSA-OAEP" }, encryptionKey, new Uint8Array(),
    )).toString("base64");
    const privateCredential = await humanJson<{ credentialToken: string }>(
      `/api/ssh-servers/${server.config.id}/credentials`, {
        method: "POST", body: JSON.stringify({
          encryptedCredential: {
            algorithm: publicKey.algorithm, fingerprint: publicKey.fingerprint,
            version: publicKey.version, ciphertext,
          },
        }),
      }, 201,
    );
    const handoff = await call<PendingInteraction>(generalClient, "clanky_execute_operation", {
      operationId: "GET /api/execution-hosts/:kind/:id/files/content",
      parameters: [{ name: "kind", value: "ssh" }, { name: "id", value: server.config.id }],
      query: [{ name: "path", value: hostFile }, { name: "startDirectory", value: firstGit.repositoryDirectory }],
      bodyJson: null, confirmationDescription: null,
    });
    expect(handoff).toMatchObject({ ok: true, completion: "not_executed", code: "credential_required" });
    expect(new URL(handoff.approvalUrl).origin).toBe(baseUrl);
    expect(handoff.expiresAt).toBeGreaterThan(Date.now());
    await denied(`/api/control/requests/${handoff.requestId}/credential`, {
      apiKey: general.token, method: "POST",
      body: JSON.stringify({ credentialToken: privateCredential.credentialToken }),
    });
    const pendingHandoff = await snapshot(handoff.requestId);
    expect(pendingHandoff).toMatchObject({
      kind: "ssh_credential", status: "pending", serverId: server.config.id,
    });
    const humanHandoffResult = await humanJson(`/api/control/requests/${handoff.requestId}/credential`, {
      method: "POST", body: JSON.stringify({ credentialToken: privateCredential.credentialToken }),
    });
    expect(humanHandoffResult).toMatchObject({ ok: true, completion: "completed", data: { content: hostNote } });
    const handoffStatus = await execute(generalClient, "GET /api/control/requests/:id", handoff.requestId);
    expect(handoffStatus).toMatchObject({
      ok: true, completion: "completed",
      data: { id: handoff.requestId, kind: "ssh_credential", status: "completed" },
    });
    const handoffDetails = (handoffStatus["data"] as { details: { section: string; item: string } }).details;
    expect(handoffDetails.section).toBe("details");
    const handoffResult = await call<{
      ok: boolean; completion: string;
      data: { items: Array<{ path: string[]; value: unknown; complete: boolean }>; nextCursor: string | null };
    }>(generalClient, "clanky_execute_operation", {
      operationId: "GET /api/control/requests/:id", parameters: [{ name: "id", value: handoff.requestId }],
      query: Object.entries(handoffDetails).map(([name, value]) => ({ name, value })),
      bodyJson: null, confirmationDescription: null,
    });
    expect(handoffResult).toMatchObject({ ok: true, completion: "completed", data: { nextCursor: null } });
    expect(handoffResult.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["result", "ok"], value: true, complete: true }),
      expect.objectContaining({ path: ["result", "completion"], value: "completed", complete: true }),
      expect.objectContaining({ path: ["result", "data", "content"], value: hostNote, complete: true }),
    ]));
    const handoffOutput = JSON.stringify([handoff, pendingHandoff, humanHandoffResult, handoffStatus, handoffResult]);
    expect([privateCredential.credentialToken, ciphertext].some((secret) => handoffOutput.includes(secret))).toBe(false);
    expect(handoffOutput.includes("credentialToken")).toBe(false);
    expect(handoffOutput.includes("PRIVATE KEY")).toBe(false);

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
    expect(await execute(projectClient, "GET /api/ssh-servers"))
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

    // This timer is the public approval lifetime, not a synchronization delay.
    await Bun.sleep(Math.max(0, expiring.expiresAt - Date.now()) + 1);
    expect(await snapshot(expiring.requestId)).toMatchObject({ status: "expired" });
    await decision(expiring.requestId, true, 410);
    expect((await humanJson<Chat>(`/api/chats/${archived}`)).config.id).toBe(archived);

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

    const pendingRestart = await prepareTrash(refreshedClient, shared, "Updated project discussion");
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await restart();
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
    await denied("/api/control/credentials", {
      method: "POST",
      body: JSON.stringify({ name: "Emergency bypass is not consent", grant: { level: "general" }, expiresInDays: 1 }),
    });
  } catch (error) {
    console.error([...previousDiagnostics, await application.diagnostics()].join("\n"));
    if (ssh) console.error(await readProcessDiagnostics(ssh.process));
    throw error;
  } finally {
    try {
      await Promise.all(clients.map((client) => client.close()));
    } finally {
      try {
        await application.stop();
      } finally {
        try {
          if (ssh) await stopEphemeralSshServer(ssh);
        } finally {
          await application.cleanup();
        }
      }
    }
  }
}, 120_000);
