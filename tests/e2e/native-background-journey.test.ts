import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { E2EApplication } from "./support/application";
import {
  compiledClankyCommand, enrollMeshWorker, meshJsonRequest, meshNodeDiagnostics,
  restartMeshNode, startMeshNode, stopMeshNode, type ManagedMeshNode,
} from "./support/mesh-cluster";
import {
  prepareBackgroundChat, useBackgroundConversation, type BackgroundClient,
} from "./support/native-background";
import {
  installExternalCodexProvider, installExternalNativeCopilotProvider, installExternalNativeOpenCodeProvider,
} from "./support/provider";
import { MESH_OPERATION_TIMEOUT_MS } from "./support/timeouts";
import { createGitFixture } from "./support/git";
import { pollUntil } from "./support/polling";
import { subscribeRealtime } from "./support/realtime";

const providers = [
  { adapter: "copilot", provider: "copilot", install: installExternalNativeCopilotProvider },
  { adapter: "codex", provider: "codex", install: installExternalCodexProvider },
  { adapter: "opencode2", provider: "opencode", install: installExternalNativeOpenCodeProvider },
] as const;

for (const provider of providers) {
  test(`${provider.adapter} users receive background work, queue a request and resume its conversation`, async () => {
    const application = await E2EApplication.create();
    let socket: WebSocket | undefined;
    const childEvents: Array<{ subagentId: string; event: { type: string; message?: { content: string } } }> = [];
    let selectedChildId: string | undefined;
    try {
      const directory = join(application.runDirectory, "workspace");
      await mkdir(directory);
      await provider.install(application.providerBinDirectory);
      await application.start();
      const host = (await application.json<Array<{ ref: Record<string, unknown> }>>("/api/execution-hosts"))
        .data.find((entry) => entry.ref["kind"] === "local");
      if (!host) throw new Error("Local execution host unavailable.");
      const chatId = await prepareBackgroundChat({
        client: application, directory, executionHost: host.ref, adapter: provider.adapter, provider: provider.provider,
      });
      await useBackgroundConversation({
        client: application, chatId, directory,
        async writeFile(path: string, content: string) { await Bun.write(path, content); },
        async reconnect() { await application.restart({ force: provider.adapter === "codex" }); },
        verifyIsolation: provider.adapter === "copilot",
        onChildObserved: provider.adapter === "copilot" ? async (subagentId) => {
          selectedChildId = subagentId;
          const key = (await application.json<{ token: string }>("/api/api-keys", {
            method: "POST", body: JSON.stringify({ name: "subagent-reader", scopes: ["*"] }),
          })).data.token;
          const url = new URL("/api/ws", application.baseUrl);
          url.protocol = "ws:";
          const AuthenticatedWebSocket = WebSocket as typeof WebSocket & {
            new(url: URL, options: Bun.WebSocketOptions): WebSocket;
          };
          socket = new AuthenticatedWebSocket(url, { headers: { authorization: `Bearer ${key}`, origin: application.baseUrl } });
          socket.addEventListener("message", (frame) => {
            const value = JSON.parse(String(frame.data));
            if (value.event?.type === "subagent.transcript") childEvents.push(value.event);
          });
          await pollUntil(() => socket!.readyState, (state) => state === WebSocket.OPEN,
            { description: "child reader realtime to open", timeoutMs: 5000 });
          await subscribeRealtime(socket, { kinds: ["content"], types: ["subagent.transcript"], targets: { subagentId } });
        } : undefined,
      });
      if (selectedChildId) {
        expect(childEvents.length).toBeGreaterThan(0);
        expect(childEvents.every((event) => event.subagentId === selectedChildId)).toBe(true);
        expect(childEvents.some((event) => event.event.message?.content.startsWith("Subagent findings:"))).toBe(true);
      }
      if (provider.adapter === "copilot") await useUnattendedControlRoots(application, host.ref);
    } catch (error) {
      console.error(await application.diagnostics());
      throw error;
    } finally {
      socket?.close();
      await application.cleanup();
    }
  });
}

async function useUnattendedControlRoots(application: E2EApplication, executionHost: Record<string, unknown>): Promise<void> {
  const git = await createGitFixture(application.runDirectory);
  const workspace = (await application.json<{ id: string }>("/api/workspaces", {
    method: "POST", body: JSON.stringify({
      name: "Unattended native project", directory: git.repositoryDirectory, executionHost,
      allowClankyContext: false, serverSettings: { agent: { adapter: "copilot", provider: "copilot" } },
    }),
  }, 201)).data;
  const model = { providerID: "copilot", modelID: "e2e-copilot-model", variant: "" };
  const target = (await application.json<{ config: { id: string } }>("/api/chats", {
    method: "POST", body: JSON.stringify({
      name: "Unattended project reference", workspaceId: workspace.id, model, useWorktree: false,
    }),
  }, 201)).data;
  const literal = "Project reference: preserve the published integration contract.";
  await application.json(`/api/chats/${target.config.id}/messages`, {
    method: "POST", body: JSON.stringify({ message: literal }),
  });
  const reference = await pollUntil(
    async () => (await application.json<{ state: { status: string } }>(`/api/chats/${target.config.id}`)).data,
    (chat) => ["idle", "failed"].includes(chat.state.status),
    { description: "native project reference to settle", timeoutMs: 10000, formatLastObserved: JSON.stringify },
  );
  expect(reference.state.status).toBe("idle");
  const prompt = "Inspect this project's work and literal reference before continuing.\nControl request: " + JSON.stringify([
    { name: "clanky_list_chats", input: {} },
    { name: "clanky_read_chat", input: { target: target.config.id } },
  ]);
  interface Transcript { messages: Array<{ role: string; content: string }> }
  const verify = (transcript: Transcript) => {
    const message = transcript.messages.find((entry) => entry.role === "assistant" && entry.content.startsWith("Control results: "));
    expect(message).toBeDefined();
    const output = JSON.parse(message!.content.slice("Control results: ".length).split("\n")[0]!) as Array<{
      items?: Array<{ id: string }>; content?: unknown; ok?: boolean;
    }>;
    expect(output[0]?.items?.some((item) => item.id === target.config.id)).toBe(true);
    expect(output[1]).toHaveProperty("content");
    expect(JSON.stringify(output[1]?.content)).toContain(literal);
  };
  const task = (await application.json<{ config: { id: string } }>("/api/tasks", {
    method: "POST", body: JSON.stringify({
      name: "Inspect native project before planning", workspaceId: workspace.id, prompt, model,
      baseBranch: git.branch, useWorktree: false, autoAcceptPlan: false, fullyAutonomous: false,
      attachments: [], maxIterations: 2, maxConsecutiveErrors: 2, activityTimeoutSeconds: null,
      stopPattern: "<promise>COMPLETE</promise>", git: { branchPrefix: "e2e/", commitScope: "" },
      clearPlanningFolder: true, draft: false, cheapModel: { mode: "same-as-task" },
    }),
  }, 201)).data;
  const planned = await pollUntil(
    async () => (await application.json<{
      state: { status: string; error?: unknown; planMode?: { isPlanReady: boolean } };
    }>(`/api/tasks/${task.config.id}`)).data,
    (value) => value.state.planMode?.isPlanReady === true || value.state.status === "failed",
    { description: "native task to inspect its project and prepare a plan", timeoutMs: 10000, formatLastObserved: JSON.stringify },
  );
  expect(planned.state.status).toBe("planning");
  verify((await application.json<{ transcript: Transcript }>(`/api/tasks/${task.config.id}/snapshot?full=1`)).data.transcript);
  await application.json(`/api/tasks/${task.config.id}/plan/discard`, { method: "POST", body: "{}" });
  const agent = (await application.json<{ config: { id: string; code?: string | null } }>("/api/agents", {
    method: "POST", body: JSON.stringify({
      name: "Native project inspection agent", workspaceId: workspace.id, prompt, code: null, model,
      baseBranch: git.branch, useWorktree: false, enabled: false,
      schedule: { startAtLocal: "2099-01-01T00:00:00", timezone: "UTC", interval: { value: 1, unit: "days" } },
    }),
  }, 201)).data;
  expect(agent.config.code).toBeUndefined();
  const run = (await application.json<{ id: string }>(`/api/agents/${agent.config.id}/run`, {
    method: "POST", body: "{}",
  }, 202)).data;
  const completed = await pollUntil(
    async () => (await application.json<{
      run: { status: string; error?: unknown }; transcript: Transcript;
    }>(`/api/agent-runs/${run.id}/snapshot?full=1`)).data,
    (snapshot) => ["completed", "failed"].includes(snapshot.run.status),
    { description: "managed native AI agent to inspect its project", timeoutMs: 10000, formatLastObserved: JSON.stringify },
  );
  expect(completed.run.status).toBe("completed");
  verify(completed.transcript);
}

async function useMeshBackgroundConversation(restartTarget: "controller" | "worker"): Promise<void> {
  const root = resolve(".cache", "e2e-native-background");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "mesh-"));
  const nodes: ManagedMeshNode[] = [];
  try {
    const bin = join(directory, "bin");
    const home = join(directory, "home");
    await mkdir(home);
    await installExternalNativeCopilotProvider(bin);
    const command = await compiledClankyCommand();
    const controller = await startMeshNode({ role: "controller", command, instanceName: "Background controller" });
    nodes.push(controller);
    const worker = await startMeshNode({
      role: "worker", command, instanceName: "Background worker",
      environment: { HOME: home, PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}` },
    });
    nodes.push(worker);
    await enrollMeshWorker(controller, worker);
    const client: BackgroundClient = {
      async json<T>(path: string, options?: { method?: string; body?: string }, expectedStatus = 200) {
        const response = await meshJsonRequest<T>(controller, path, {
          method: options?.method, body: options?.body ? JSON.parse(options.body) : undefined,
        });
        if (response.status !== expectedStatus) {
          throw new Error(`Mesh ${path}: HTTP ${response.status} ${JSON.stringify(response.body)}`);
        }
        return { data: response.body };
      },
    };
    const host = (await client.json<Array<{ ref: Record<string, unknown> }>>("/api/execution-hosts"))
      .data.find((entry) => entry.ref["kind"] === "mesh");
    if (!host) throw new Error("Mesh execution host unavailable.");
    const exec = async (script: string) => {
      const result = (await client.json<{ success: boolean; stderr: string }>(
        `/api/execution-hosts/mesh/${host.ref["nodeId"]}/exec`,
        {
          method: "POST", body: JSON.stringify({
            command: process.execPath, args: ["-e", script], cwd: worker.dataDir,
            timeoutMs: MESH_OPERATION_TIMEOUT_MS,
          }),
        },
      )).data;
      if (!result.success) throw new Error(`Background workspace command failed: ${result.stderr}`);
    };
    const workspaceDirectory = join(worker.dataDir, "background-workspace");
    await exec(`await import("node:fs/promises").then(fs => fs.mkdir(${JSON.stringify(workspaceDirectory)}, {recursive:true}));`);
    const chatId = await prepareBackgroundChat({
      client, directory: workspaceDirectory, executionHost: host.ref, adapter: "copilot", provider: "copilot",
    });
    await useBackgroundConversation({
      client, chatId, directory: workspaceDirectory,
      async writeFile(path: string, content: string) { await exec(`await Bun.write(${JSON.stringify(path)}, ${JSON.stringify(content)});`); },
      async reconnect() { await restartMeshNode(restartTarget === "worker" ? worker : controller); },
    });
  } catch (error) {
    for (const node of nodes) console.error(await meshNodeDiagnostics(node));
    throw error;
  } finally {
    try {
      for (const node of [...nodes].reverse()) await stopMeshNode(node);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

for (const restartTarget of ["controller", "worker"] as const) {
  test(`Mesh users retain their background report and continue after restarting the ${restartTarget}`, async () => {
    await useMeshBackgroundConversation(restartTarget);
  });
}
