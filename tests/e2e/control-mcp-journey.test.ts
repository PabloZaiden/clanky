import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import { bootstrapOwner, CookieJar, requestWithCookies } from "./support/passkey";
import { OPERATION_TIMEOUT_MS, operationSignal } from "./support/timeouts";

test("an MCP client reads its project and a user approves a requested change", async () => {
  const application = await E2EApplication.create();
  const client = new Client({ name: "Sanity integration", version: "1.0.0" });
  try {
    await application.start({ disablePasskey: false, requestHostname: "localhost" });
    const cookies = new CookieJar();
    await bootstrapOwner(application, cookies);
    async function human<T>(path: string, method = "GET", body?: unknown, expected = 200): Promise<T> {
      const response = await requestWithCookies(application, cookies, path, {
        method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (response.status !== expected) throw new Error(`${method} ${path}: HTTP ${response.status}: ${text}`);
      return JSON.parse(text) as T;
    }
    const git = await createGitFixture(application.runDirectory);
    const host = (await human<Array<{ ref: Record<string, string> }>>("/api/execution-hosts"))
      .find((entry) => entry.ref["kind"] === "local");
    if (!host) throw new Error("Local execution host unavailable");
    const workspace = await human<{ id: string }>("/api/workspaces", "POST", {
      name: "MCP project", directory: git.repositoryDirectory, executionHost: host.ref,
      allowClankyContext: false,
      serverSettings: { agent: { adapter: "acp", provider: "copilot" } },
    }, 201);
    const model = (await human<Array<{ connected: boolean; providerID: string; modelID: string }>>(
      `/api/models?workspaceId=${workspace.id}`,
    )).find((entry) => entry.connected && entry.providerID === "copilot");
    if (!model) throw new Error("Deterministic ACP model unavailable");
    const chat = await human<{ config: { id: string } }>("/api/chats", "POST", {
      name: "Project discussion", workspaceId: workspace.id, useWorktree: false,
      baseBranch: git.branch, model: { providerID: model.providerID, modelID: model.modelID, variant: "" },
    }, 201);
    const credential = await human<{ token: string }>("/api/control/credentials", "POST", {
      name: "Project integration", grant: { level: "workspace", workspaceId: workspace.id }, expiresInDays: 1,
    }, 201);
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", application.baseUrl), {
      requestInit: { headers: { authorization: `Bearer ${credential.token}` } },
      fetch: (input, options) => fetch(input, { ...options, signal: operationSignal(options?.signal) }),
    }), { timeout: OPERATION_TIMEOUT_MS });
    async function call<T>(name: string, input: Record<string, unknown>): Promise<T> {
      const result = await client.callTool({ name, arguments: input }, undefined, { timeout: OPERATION_TIMEOUT_MS });
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content.find((entry) => entry.type === "text")?.text;
      if (!text || result.isError) throw new Error(`MCP ${name} failed: ${JSON.stringify(result)}`);
      return JSON.parse(text) as T;
    }
    const page = await call<{ items: Array<{ id: string }> }>("clanky_list_chats", {});
    expect(page.items.map((entry) => entry.id)).toContain(chat.config.id);
    const pending = await call<{ code: string; requestId: string }>("clanky_update_chat_lifecycle", {
      target: chat.config.id, action: "move_to_trash",
      confirmationDescription: "Move the finished project discussion to Trash.",
    });
    expect(pending.code).toBe("confirmation_required");
    expect((await human<{ config: { id: string } }>(`/api/chats/${chat.config.id}`)).config.id).toBe(chat.config.id);
    expect(await human(`/api/control/requests/${pending.requestId}/decision`, "POST", { approved: true }))
      .toMatchObject({ ok: true, completion: "completed" });
    expect((await human<{ items: Array<{ id: string }> }>("/api/trash")).items.map((entry) => entry.id))
      .toContain(chat.config.id);
  } catch (error) {
    console.error(await application.diagnostics());
    throw error;
  } finally {
    try {
      await client.close();
    } finally {
      await application.cleanup();
    }
  }
});
