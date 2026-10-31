import { expect, test } from "bun:test";
import { join } from "node:path";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import { bootstrapOwner, completeUserSetup, CookieJar, requestWithCookies } from "./support/passkey";
import { pollUntil } from "./support/polling";
import { installExternalAcpProvider, installExternalNativeCopilotProvider } from "./support/provider";

interface Chat {
  config: { id: string };
  state: {
    status: string;
    harness?: { questions?: Array<{ requestId: string; status: string; secretIdentifier?: string }> };
  };
}
interface Snapshot {
  transcript: { messages: Array<{ role: string; content: string }> };
}
interface NotificationPayload {
  title: string;
  shortDescription: string;
  markdownContent: string;
}

const defaults = {
  configured: false,
  enabled: false,
  events: {
    error: false, blocked: false, question: false, secret: false,
    approval: false, planReady: false, completed: false,
  },
  lastDeliveryError: null,
};
type Settings = Omit<typeof defaults, "lastDeliveryError"> & {
  lastDeliveryError: { message: string; timestamp: string } | null;
};
interface Task {
  config: { id: string };
  state: { status: string; planMode?: { isPlanReady: boolean } };
}

test("users configure private event notifications, pause them without losing selections and explicitly notify", async () => {
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
    expect((await application.json(settingsPath, { apiKey: ownerKey })).data).toEqual(defaults);
    await application.json(settingsPath, {
      apiKey: ownerKey, method: "PUT", body: JSON.stringify({ webhookUrl: "file:///not-a-webhook" }),
    }, 400);
    const webhookUrl = `http://127.0.0.1:${webhook.port}/api/webhooks/clanky/${webhookToken}`;
    expect((await application.json(settingsPath, {
      apiKey: ownerKey, method: "PUT", body: JSON.stringify({ webhookUrl }),
    })).data).toEqual({ ...defaults, configured: true });
    expect((await application.json(settingsPath, { apiKey: memberKey })).data).toEqual(defaults);
    await application.restart({ disablePasskey: false, requestHostname: "localhost" });
    expect((await application.json(settingsPath, { apiKey: ownerKey })).data).toEqual({ ...defaults, configured: true });
    expect((await application.json(settingsPath, { apiKey: memberKey })).data).toEqual(defaults);

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
    })).data).toEqual(defaults);
    expect(await notify(payload)).toMatchObject({
      ok: false, code: "notification_not_configured", completion: "not_executed",
    });
    expect(received).toHaveLength(4);

    async function configure(input: unknown, apiKey = ownerKey): Promise<Settings> {
      return (await application.json<Settings>(settingsPath, {
        apiKey, method: "PUT", body: JSON.stringify(input),
      })).data;
    }
    async function notificationCount(count: number) {
      await pollUntil(() => received.length, (value) => value >= count,
        { description: "selected event notification to reach Listen", timeoutMs: 5_000 });
      expect(received).toHaveLength(count);
    }
    const events = {
      error: true, blocked: true, question: true, secret: true,
      approval: true, planReady: true, completed: true,
    };
    webhookStatus = 201;
    await configure({ events });
    await send("No webhook is configured, even though completion is selected.");
    expect(received).toHaveLength(4);
    await configure({ webhookUrl });
    await send("The master is still off, even though completion is selected.");
    expect(received).toHaveLength(4);
    await configure({ enabled: true });
    await send("Finish this chat response.");
    await notificationCount(5);
    expect(received[4]!.payload).toEqual({
      title: "Chat: Work has finished.", shortDescription: "Work has finished.",
      markdownContent: "Chat: Work has finished.\n\nOpen Clanky to view the details.",
    });
    const selected = await configure({ events: { completed: false } });
    expect(selected.events).toEqual({ ...events, completed: false });
    await send("Completion is individually disabled.");
    expect(received).toHaveLength(5);
    await configure({ events: { completed: true } });
    const paused = await configure({ enabled: false });
    expect(paused.events).toEqual(events);
    await send("All automatic events are paused.");
    expect(received).toHaveLength(5);
    expect(await notify(payload)).toMatchObject({ ok: true, status: "accepted" });
    await notificationCount(6);
    await configure({ enabled: true });

    const secretIdentifier = `private-label-${crypto.randomUUID()}`;
    await application.json(`/api/chats/${chat.config.id}/messages`, {
      apiKey: ownerKey, method: "POST", body: JSON.stringify({
        message: `Secret request: ${JSON.stringify({
          identifier: secretIdentifier, label: secretIdentifier, reason: secretIdentifier,
        })}`,
      }),
    });
    const secretChat = await pollUntil(
      async () => (await application.json<Chat>(`/api/chats/${chat.config.id}`, { apiKey: ownerKey })).data,
      (current) => current.state.harness?.questions?.some((request) => request.status === "pending") === true,
      { description: "private secret form to need human input", timeoutMs: 10_000 },
    );
    await notificationCount(7);
    expect((received[6]!.payload as NotificationPayload).shortDescription).toBe("A private secret request needs your attention.");
    expect(JSON.stringify(received)).not.toContain(secretIdentifier);
    expect(secretChat.state.status).toBe("waiting");
    await application.json(`/api/chats/${chat.config.id}/interrupt`, {
      apiKey: ownerKey, method: "POST", body: "{}",
    });
    await pollUntil(
      async () => (await application.json<Chat>(`/api/chats/${chat.config.id}`, { apiKey: ownerKey })).data,
      (current) => current.state.status === "idle",
      { description: "interrupted private request to end the chat turn", timeoutMs: 10_000 },
    );
    expect(received).toHaveLength(7);

    await configure({ events: { completed: false } });
    const approvalSnapshot = await send("Request approval before moving this chat to Trash.\nControl request: " + JSON.stringify([{
      name: "clanky_update_chat_lifecycle", input: {
        target: chat.config.id, workspace: workspace.id, action: "move_to_trash",
        confirmationDescription: "Move Explicit notifications to Trash, stopping active work and keeping it recoverable for 30 days.",
      },
    }]));
    const approvalMessage = approvalSnapshot.transcript.messages.findLast((message) =>
      message.role === "assistant" && message.content.startsWith("Control results: "));
    const [approval] = JSON.parse(approvalMessage!.content.slice("Control results: ".length)) as Array<{ requestId: string }>;
    await notificationCount(8);
    expect((received[7]!.payload as NotificationPayload).shortDescription).toBe("A permission or approval request needs your decision.");
    const rejected = await requestWithCookies(application, human, `/api/control/requests/${approval!.requestId}/decision`, {
      method: "POST", body: JSON.stringify({ approved: false }),
    });
    expect(rejected.status).toBe(200);
    await configure({ events: { completed: true } });

    const savedSettings = (await application.json<Settings>(settingsPath, { apiKey: ownerKey })).data;
    await application.restart({ disablePasskey: false, requestHostname: "localhost" });
    expect((await application.json(settingsPath, { apiKey: ownerKey })).data).toEqual(savedSettings);
    expect((await application.json(settingsPath, { apiKey: memberKey })).data).toEqual(defaults);
    expect(received).toHaveLength(8);

    await installExternalAcpProvider(application.providerBinDirectory);
    const acpGit = await createGitFixture(join(application.runDirectory, "automatic"));
    const acpWorkspace = (await application.json<{ id: string }>("/api/workspaces", {
      apiKey: ownerKey, method: "POST", body: JSON.stringify({
        name: "Automatic notifications", directory: acpGit.repositoryDirectory,
        executionHost: hosts.find((host) => host.ref["kind"] === "local")!.ref,
        allowClankyContext: false, serverSettings: { agent: { adapter: "acp", provider: "copilot" } },
      }),
    }, 201)).data;
    const acpModel = (await application.json<Array<{ providerID: string; modelID: string; connected: boolean }>>(
      `/api/models?workspaceId=${acpWorkspace.id}`, { apiKey: ownerKey },
    )).data.find((model) => model.connected)!;
    const modelConfig = { providerID: acpModel.providerID, modelID: acpModel.modelID, variant: "" };
    const interactive = (await application.json<Chat>("/api/chats", {
      apiKey: ownerKey, method: "POST", body: JSON.stringify({
        name: "Interactive notices", workspaceId: acpWorkspace.id, model: modelConfig,
        useWorktree: false, baseBranch: acpGit.branch,
      }),
    }, 201)).data;
    const interactivePath = `/api/chats/${interactive.config.id}`;
    const readInteractive = async () => (await application.json<Chat>(interactivePath, { apiKey: ownerKey })).data;
    await application.json(`${interactivePath}/messages`, {
      apiKey: ownerKey, method: "POST", body: JSON.stringify({ message: "[permission] [question]" }),
    });
    const questioned = await pollUntil(readInteractive,
      (current) => current.state.harness?.questions?.some((request) => request.status === "pending") === true,
      { description: "ordinary question to await a human answer", timeoutMs: 10_000 });
    await notificationCount(9);
    expect((received[8]!.payload as NotificationPayload).shortDescription).toBe("A question needs your answer.");
    await application.json(`${interactivePath}/questions/${questioned.state.harness!.questions![0]!.requestId}`, {
      apiKey: ownerKey, method: "POST", body: JSON.stringify({ answers: [["Concise"]] }),
    });
    await pollUntil(readInteractive, (current) => current.state.status === "idle",
      { description: "answered chat response to finish", timeoutMs: 10_000 });
    await notificationCount(10);

    async function createTask(name: string, prompt: string): Promise<Task> {
      return (await application.json<Task>("/api/tasks", {
        apiKey: ownerKey, method: "POST", body: JSON.stringify({
          name, prompt, workspaceId: acpWorkspace.id, baseBranch: acpGit.branch,
          attachments: [], git: { branchPrefix: "e2e/", commitScope: "" },
          fullyAutonomous: false, draft: false,
          useWorktree: true, maxIterations: 2, maxConsecutiveErrors: 1,
          stopPattern: "<promise>COMPLETE</promise>", clearPlanningFolder: true,
          autoAcceptPlan: false, model: modelConfig, cheapModel: { mode: "same-as-task" },
        }),
      }, 201)).data;
    }
    async function plan(task: Task, count: number) {
      await pollUntil(
        async () => (await application.json<Task>(`/api/tasks/${task.config.id}`, { apiKey: ownerKey })).data,
        (current) => current.state.planMode?.isPlanReady === true,
        { description: "task plan to await manual approval", timeoutMs: 10_000 },
      );
      await notificationCount(count);
      expect((received[count - 1]!.payload as NotificationPayload).shortDescription).toBe("A plan is ready for your approval.");
      await application.json(`/api/tasks/${task.config.id}/plan/accept`, {
        apiKey: ownerKey, method: "POST", body: JSON.stringify({ mode: "start_task" }),
      });
    }
    async function taskStatus(task: Task, status: string) {
      await pollUntil(
        async () => (await application.json<Task>(`/api/tasks/${task.config.id}`, { apiKey: ownerKey })).data,
        (current) => current.state.status === status,
        { description: `notification task to become ${status}`, timeoutMs: 10_000 },
      );
    }
    const completedTask = await createTask("Completion notification", "Complete the requested work.");
    await plan(completedTask, 11);
    await taskStatus(completedTask, "completed");
    await notificationCount(12);
    expect((received[11]!.payload as NotificationPayload).title).toBe("Task: Work has finished.");
    const blockedTask = await createTask("Blocker notification", "Resolve an unavailable prerequisite [blocked].");
    await plan(blockedTask, 13);
    await taskStatus(blockedTask, "stopped");
    await notificationCount(14);
    expect((received[13]!.payload as NotificationPayload).shortDescription).toBe("Work is blocked and needs your attention.");

    await application.json(`${interactivePath}/messages`, {
      apiKey: ownerKey, method: "POST", body: JSON.stringify({ message: "[chat-provider-error]" }),
    });
    await pollUntil(readInteractive, (current) => current.state.status === "failed",
      { description: "chat provider error to be reported", timeoutMs: 10_000 });
    await notificationCount(15);
    expect((received[14]!.payload as NotificationPayload).shortDescription).toBe("An error occurred.");
    expect(JSON.stringify(received)).not.toContain("Deterministic external provider failure");

    webhookStatus = 500;
    await application.json(`${interactivePath}/messages`, {
      apiKey: ownerKey, method: "POST", body: JSON.stringify({ message: "Finish the next response." }),
    });
    await pollUntil(readInteractive, (current) => current.state.status === "idle",
      { description: "chat whose completion notification fails to finish", timeoutMs: 10_000 });
    await notificationCount(16);
    const failedDelivery = await pollUntil(
      async () => (await application.json<Settings>(settingsPath, { apiKey: ownerKey })).data,
      (settings) => settings.lastDeliveryError !== null,
      { description: "automatic delivery failure to be visible to its user", timeoutMs: 5_000 },
    );
    expect(failedDelivery.lastDeliveryError!.message).toContain("did not accept");
    await application.restart({ disablePasskey: false, requestHostname: "localhost" });
    expect((await application.json(settingsPath, { apiKey: ownerKey })).data).toEqual(failedDelivery);
    expect((await application.json(settingsPath, { apiKey: memberKey })).data).toEqual(defaults);
    expect(received).toHaveLength(16);
    expect((await configure({ webhookUrl: null })).lastDeliveryError).toBeNull();
    expect(await application.diagnostics()).not.toContain(webhookToken);
  } catch (error) {
    console.error(await application.diagnostics());
    throw error;
  } finally {
    try { await application.cleanup(); } finally { await webhook.stop(true); }
  }
});
