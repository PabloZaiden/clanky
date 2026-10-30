import { expect, test } from "bun:test";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import { bootstrapOwner, completeUserSetup, CookieJar, requestWithCookies } from "./support/passkey";
import { pollUntil } from "./support/polling";
import { installExternalNativeCopilotProvider } from "./support/provider";

interface Chat {
  config: { id: string };
  state: { status: string };
}
interface Snapshot {
  transcript: { messages: Array<{ role: string; content: string }> };
}
interface NotificationPayload {
  title: string;
  shortDescription: string;
  markdownContent: string;
}

test("users configure private Listen webhooks and explicitly notify from native and deterministic executions", async () => {
  const application = await E2EApplication.create();
  const received: Array<{ method: string; path: string; contentType: string | null; payload: unknown }> = [];
  const webhookToken = `private-webhook-${crypto.randomUUID()}`;
  let webhookStatus = 201;
  const webhook = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push({
        method: request.method,
        path: new URL(request.url).pathname,
        contentType: request.headers.get("content-type"),
        payload: await request.json(),
      });
      return Response.json({ id: "notification", privateDiagnostic: webhookToken }, { status: webhookStatus });
    },
  });
  try {
    await installExternalNativeCopilotProvider(application.providerBinDirectory);
    await application.start({ disablePasskey: false, requestHostname: "localhost" });
    const human = new CookieJar();
    await bootstrapOwner(application, human);
    const createdUser = await requestWithCookies(application, human, "/api/users", {
      method: "POST", body: JSON.stringify({ username: "notification-member", role: "user" }),
    });
    expect(createdUser.status).toBe(201);
    const { setupLink } = await createdUser.json() as { setupLink: { url: string } };
    const member = new CookieJar();
    await completeUserSetup(application, member, new URL(setupLink.url).searchParams.get("token")!);
    async function key(jar: CookieJar) {
      const response = await requestWithCookies(application, jar, "/api/api-keys", {
        method: "POST", body: JSON.stringify({ name: "Notification journey", scopes: ["*"] }),
      });
      expect(response.status).toBe(200);
      return (await response.json() as { token: string }).token;
    }
    const ownerKey = await key(human);
    const memberKey = await key(member);
    const settingsPath = "/api/preferences/notifications";
    expect((await application.request(settingsPath)).status).toBe(401);
    expect((await application.json(settingsPath, { apiKey: ownerKey })).data).toEqual({ configured: false });
    await application.json(settingsPath, {
      apiKey: ownerKey, method: "PUT", body: JSON.stringify({ webhookUrl: "file:///not-a-webhook" }),
    }, 400);
    const webhookUrl = `http://127.0.0.1:${webhook.port}/api/webhooks/clanky/${webhookToken}`;
    expect((await application.json(settingsPath, {
      apiKey: ownerKey, method: "PUT", body: JSON.stringify({ webhookUrl }),
    })).data).toEqual({ configured: true });
    expect((await application.json(settingsPath, { apiKey: memberKey })).data).toEqual({ configured: false });
    await application.restart({ disablePasskey: false, requestHostname: "localhost" });
    expect((await application.json(settingsPath, { apiKey: ownerKey })).data).toEqual({ configured: true });
    expect((await application.json(settingsPath, { apiKey: memberKey })).data).toEqual({ configured: false });

    const git = await createGitFixture(application.runDirectory);
    const hosts = (await application.json<Array<{ ref: Record<string, string> }>>(
      "/api/execution-hosts", { apiKey: ownerKey },
    )).data;
    const workspace = (await application.json<{ id: string }>("/api/workspaces", {
      apiKey: ownerKey, method: "POST", body: JSON.stringify({
        name: "Notification workspace", directory: git.repositoryDirectory,
        executionHost: hosts.find((host) => host.ref["kind"] === "local")!.ref,
        allowClankyContext: false,
        serverSettings: { agent: { adapter: "copilot", provider: "copilot" } },
      }),
    }, 201)).data;
    const models = (await application.json<Array<{ providerID: string; modelID: string; connected: boolean }>>(
      `/api/models?workspaceId=${workspace.id}`, { apiKey: ownerKey },
    )).data;
    const selectedModel = models.find((model) => model.providerID === "copilot" && model.connected)!;
    const model = { providerID: selectedModel.providerID, modelID: selectedModel.modelID, variant: "" };
    const chat = (await application.json<Chat>("/api/chats", {
      apiKey: ownerKey, method: "POST", body: JSON.stringify({
        name: "Explicit notifications", workspaceId: workspace.id, model,
        useWorktree: false, baseBranch: git.branch,
      }),
    }, 201)).data;
    async function send(message: string): Promise<Snapshot> {
      await application.json(`/api/chats/${chat.config.id}/messages`, {
        apiKey: ownerKey, method: "POST", body: JSON.stringify({ message, attachments: [] }),
      });
      const finished = await pollUntil(
        async () => (await application.json<Chat>(`/api/chats/${chat.config.id}`, { apiKey: ownerKey })).data,
        (value) => value.state.status === "idle" || value.state.status === "failed",
        { description: "native notification turn to finish", timeoutMs: 10_000 },
      );
      expect(finished.state.status).toBe("idle");
      return (await application.json<Snapshot>(`/api/chats/${chat.config.id}/snapshot?full=1`, { apiKey: ownerKey })).data;
    }
    async function notify(payload: NotificationPayload): Promise<Record<string, unknown>> {
      const snapshot = await send("Send the notification I explicitly requested.\nControl request: " + JSON.stringify([
        { name: "clanky_send_notification", input: payload },
      ]));
      const response = snapshot.transcript.messages.findLast((message) =>
        message.role === "assistant" && message.content.startsWith("Control results: "),
      );
      expect(response).toBeDefined();
      expect(JSON.stringify(snapshot)).not.toContain(webhookToken);
      const results = JSON.parse(response!.content.slice("Control results: ".length)) as Array<Record<string, unknown>>;
      return results[0]!;
    }
    await send("Inspect the workspace without sending a notification.");
    expect(received).toHaveLength(0);
    const payload = {
      title: "Changes ready", shortDescription: "The requested work is complete.",
      markdownContent: "## Ready\n\nThe changes are ready for review.",
    };
    expect(await notify(payload)).toMatchObject({ ok: true, completion: "completed", status: "accepted" });
    expect(received).toEqual([{
      method: "POST", path: `/api/webhooks/clanky/${webhookToken}`,
      contentType: "application/json", payload,
    }]);

    const deterministicPayload = { ...payload, title: "Scheduled report ready" };
    const agent = (await application.json<{ config: { id: string } }>("/api/agents", {
      apiKey: ownerKey, method: "POST", body: JSON.stringify({
        name: "Requested notification", workspaceId: workspace.id, model,
        prompt: "Send me a notification with the scheduled report.",
        code: [
          "export default async function run(ctx) {",
          `  const result = await ctx.clanky.call("clanky_send_notification", ${JSON.stringify(deterministicPayload)});`,
          "  ctx.stdout.write(JSON.stringify(result));",
          "}",
        ].join("\n"),
        baseBranch: git.branch, useWorktree: false, enabled: false,
        schedule: { startAtLocal: "2099-01-01T00:00:00", timezone: "UTC", interval: { value: 1, unit: "days" } },
      }),
    }, 201)).data;
    const run = (await application.json<{ id: string }>(`/api/agents/${agent.config.id}/run`, {
      apiKey: ownerKey, method: "POST", body: "{}",
    }, 202)).data;
    const completed = await pollUntil(
      async () => (await application.json<{
        run: { status: string }; transcript: { logs: Array<{ message: string }> };
      }>(`/api/agent-runs/${run.id}/snapshot?full=1`, { apiKey: ownerKey })).data,
      (snapshot) => ["completed", "failed"].includes(snapshot.run.status),
      { description: "deterministic notification run to finish", timeoutMs: 10_000 },
    );
    expect(completed.run.status).toBe("completed");
    const receipt = completed.transcript.logs.find((entry) => entry.message.includes('"status":"accepted"'));
    expect(receipt).toBeDefined();
    expect(JSON.parse(receipt!.message)).toMatchObject({ ok: true, completion: "completed", status: "accepted" });
    expect(JSON.stringify(completed)).not.toContain(webhookToken);
    expect(received).toHaveLength(2);
    expect(received[1]!.payload).toEqual(deterministicPayload);

    webhookStatus = 400;
    expect(await notify(payload)).toMatchObject({
      ok: false, code: "notification_webhook_rejected", completion: "not_executed", status: 400,
    });
    expect(received).toHaveLength(3);
    webhookStatus = 500;
    expect(await notify(payload)).toMatchObject({
      ok: false, code: "notification_webhook_rejected", completion: "outcome_unknown", status: 500,
    });
    expect(received).toHaveLength(4);
    expect((await application.json(settingsPath, {
      apiKey: ownerKey, method: "PUT", body: JSON.stringify({ webhookUrl: null }),
    })).data).toEqual({ configured: false });
    expect(await notify(payload)).toMatchObject({
      ok: false, code: "notification_not_configured", completion: "not_executed",
    });
    expect(received).toHaveLength(4);
    expect(await application.diagnostics()).not.toContain(webhookToken);
  } catch (error) {
    console.error(await application.diagnostics());
    throw error;
  } finally {
    try { await application.cleanup(); } finally { await webhook.stop(true); }
  }
});
