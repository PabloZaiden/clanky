import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import { bootstrapOwner, CookieJar, requestWithCookies } from "./support/passkey";
import { findFreeLoopbackPort } from "./support/process";
import { OPERATION_TIMEOUT_MS, operationSignal } from "./support/timeouts";

test("an unknown OAuth MCP client obtains project consent and reconnects after restart", async () => {
  const application = await E2EApplication.create();
  const client = new Client({ name: "OAuth integration", version: "1.0.0" });
  try {
    const port = await findFreeLoopbackPort();
    const env = { CLANKY_PUBLIC_BASE_URL: `http://localhost:${port}` };
    await application.start({ disablePasskey: false, requestHostname: "localhost", port, env });
    const cookies = new CookieJar();
    await bootstrapOwner(application, cookies);
    async function human<T>(path: string, method = "GET", body?: unknown, expected = 200): Promise<T> {
      const response = await requestWithCookies(application, cookies, path, {
        method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status !== expected) throw new Error(`${method} ${path.split("?", 1)[0]}: HTTP ${response.status}`);
      return await response.json() as T;
    }
    const git = await createGitFixture(application.runDirectory);
    const host = (await human<Array<{ ref: Record<string, string> }>>("/api/execution-hosts"))
      .find(entry => entry.ref["kind"] === "local");
    if (!host) throw new Error("Local execution host unavailable");
    const workspace = await human<{ id: string }>("/api/workspaces", "POST", {
      name: "OAuth project", directory: git.repositoryDirectory, executionHost: host.ref,
      serverSettings: { agent: { adapter: "copilot", provider: "copilot" } },
    }, 201);
    let information: OAuthClientInformationMixed | undefined;
    let tokens: OAuthTokens | undefined;
    let verifier: string | undefined;
    let authorizationUrl: URL | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: "http://127.0.0.1/callback",
      clientMetadata: {
        client_name: "Unconfigured MCP client", redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      clientInformation: () => information,
      saveClientInformation: value => { information = value; },
      tokens: () => tokens,
      saveTokens: value => { tokens = value; },
      saveCodeVerifier: value => { verifier = value; },
      codeVerifier: () => {
        if (!verifier) throw new Error("PKCE verifier unavailable");
        return verifier;
      },
      redirectToAuthorization: url => { authorizationUrl = url; },
    };
    const serverUrl = new URL("/mcp", application.baseUrl);
    const boundedFetch: FetchLike = (input, options) => fetch(input, {
      ...options, signal: operationSignal(options?.signal),
    });
    expect(await auth(provider, { serverUrl, fetchFn: boundedFetch })).toBe("REDIRECT");
    if (!authorizationUrl) throw new Error("OAuth authorization URL unavailable");
    const begin = await application.request(`${authorizationUrl.pathname}${authorizationUrl.search}`, { redirect: "manual" });
    expect(begin.status).toBe(303);
    const location = begin.headers.get("location");
    if (!location) throw new Error("Consent redirect unavailable");
    const handle = new URL(location).searchParams.get("request");
    if (!handle) throw new Error("Consent request unavailable");
    await human(`/api/oauth/consent?${new URLSearchParams({ request: handle })}`);
    const decision = await human<{ redirectUri: string }>("/api/oauth/consent", "POST", {
      request: handle, decision: "approve", approval: { level: "workspace", workspaceId: workspace.id },
    });
    const callback = new URL(decision.redirectUri);
    expect(callback.searchParams.get("iss")).toBe(application.baseUrl);
    const code = callback.searchParams.get("code");
    if (!code) throw new Error("Authorization code unavailable");
    expect(await auth(provider, { serverUrl, authorizationCode: code, fetchFn: boundedFetch })).toBe("AUTHORIZED");

    async function readProject(): Promise<void> {
      await client.connect(new StreamableHTTPClientTransport(serverUrl, {
        authProvider: provider, fetch: boundedFetch,
      }), { timeout: OPERATION_TIMEOUT_MS });
      const result = await client.callTool({ name: "clanky_list_workspaces", arguments: {} }, undefined, {
        timeout: OPERATION_TIMEOUT_MS,
      });
      const text = (result.content as Array<{ type: string; text?: string }>).find(entry => entry.type === "text")?.text;
      if (result.isError || !text) throw new Error("OAuth project read failed");
      expect((JSON.parse(text) as { items: Array<{ id: string }> }).items.map(entry => entry.id)).toEqual([workspace.id]);
      await client.close();
    }
    await readProject();
    if (!tokens) throw new Error("OAuth tokens unavailable");
    expect((await application.request("/api/workspaces", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })).status).toBe(401);
    await application.restart({ port, env });
    expect(await auth(provider, { serverUrl, fetchFn: boundedFetch })).toBe("AUTHORIZED");
    await readProject();
  } catch (error) {
    console.error(await application.diagnostics());
    throw error;
  } finally {
    try { await client.close(); }
    finally { await application.cleanup(); }
  }
});
