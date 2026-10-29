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
    } catch (error) {
      console.error(await application.diagnostics());
      throw error;
    } finally {
      socket?.close();
      await application.cleanup();
    }
  });
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
