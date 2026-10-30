import { expect, test } from "bun:test";
import { lstat, unlink } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { E2EApplication } from "./support/application";
import { bootstrapOwner, CookieJar, requestWithCookies } from "./support/passkey";
import { createGitFixture } from "./support/git";
import { pollUntil } from "./support/polling";
import {
  installExternalCodexProvider, installExternalNativeCopilotProvider, installExternalNativeOpenCodeProvider,
} from "./support/provider";
import {
  availablePort, compiledClankyCommand, enrollMeshWorker, meshJsonRequest, meshNodeDiagnostics,
  restartMeshNode, startMeshNode, stopMeshNode, type ManagedMeshNode,
} from "./support/mesh-cluster";
import { getMeshTestTls } from "./support/mesh-tls";

interface Question { requestId: string; status: string; secretIdentifier?: string; answers?: string[][] }
interface Chat {
  config: { id: string };
  state: { status: string; error?: unknown; harness?: { questions?: Question[] } };
}
interface Snapshot { transcript: { messages: Array<{ role: string; content: string }> } }
interface Receipt { path: string; expiresAt: number; sha256: string; bytes: number }

const request = {
  identifier: "cli-integration-token", label: "CLI integration token",
  reason: "Authenticate the CLI using its standard input, without putting the credential in chat.",
};
const instruction = `Secret request: ${JSON.stringify(request)}`;
const providers = {
  copilot: { install: installExternalNativeCopilotProvider, provider: "copilot" },
  codex: { install: installExternalCodexProvider, provider: "codex" },
  opencode2: { install: installExternalNativeOpenCodeProvider, provider: "opencode" },
};

for (const [adapter, remote] of [
  ["copilot", false], ["codex", false], ["opencode2", false], ["codex", true],
] as const) {
  test.skipIf(process.platform === "win32")(`${adapter} users supply private CLI files on ${remote ? "Mesh" : "local"} hosts`, async () => {
    const app = await E2EApplication.create();
    const cookies = new CookieJar();
    let worker: ManagedMeshNode | undefined;
    let proxy: ReturnType<typeof Bun.spawn> | undefined;
    let proxyOutput: Promise<unknown> | undefined;
    try {
      await providers[adapter].install(app.providerBinDirectory);
      const tls = remote ? await getMeshTestTls() : undefined;
      const environment: Record<string, string> = tls ? {
        NODE_EXTRA_CA_CERTS: tls.certificatePath, CLANKY_TRUST_PROXY: "true", CLANKY_TRUST_PROXY_HEADERS: "proto,host",
      } : {};
      await app.start({ disablePasskey: false, requestHostname: "localhost", env: environment });
      await bootstrapOwner(app, cookies);
      async function json<T>(path: string, method = "GET", body?: unknown, expected = 200): Promise<T> {
        const response = await requestWithCookies(app, cookies, path, {
          method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        if (response.status !== expected) throw new Error(`${method} ${path}: HTTP ${response.status}: ${text}`);
        return JSON.parse(text);
      }
      let hostKind = "local";
      if (remote) {
        const apiKey = (await json<{ token: string }>("/api/api-keys", "POST", { name: "Secret journey controller", scopes: ["*"] })).token;
        const proxyPort = await availablePort();
        const endpoint = `https://127.0.0.1:${proxyPort}`;
        const tlsProxy = Bun.spawn([
          process.execPath, join(import.meta.dir, "support", "mesh-tls-proxy.ts"),
          String(proxyPort), new URL(app.baseUrl).port, tls!.certificatePath, tls!.privateKeyPath,
        ], { stdout: "pipe", stderr: "pipe" });
        proxy = tlsProxy;
        proxyOutput = Promise.all([new Response(tlsProxy.stdout).text(), new Response(tlsProxy.stderr).text()]);
        await pollUntil(async () => {
          try {
            return (await meshJsonRequest({ baseUrl: endpoint, dataDir: app.dataDirectory, tlsCertificate: tls!.certificate }, "/api/health")).status;
          } catch { return 0; }
        }, (status) => status === 200, { description: "private input controller TLS endpoint", timeoutMs: 10_000 });
        await json("/api/mesh/endpoint", "POST", { meshEndpoint: endpoint });
        worker = await startMeshNode({
          role: "worker", command: await compiledClankyCommand(), instanceName: "secret-host",
          environment: { HOME: app.homeDirectory, PATH: `${app.providerBinDirectory}${delimiter}${process.env["PATH"] ?? ""}` },
        });
        await enrollMeshWorker({ baseUrl: app.baseUrl, meshEndpoint: endpoint, dataDir: app.dataDirectory, apiKey }, worker);
        hostKind = "mesh";
      }
      const host = await pollUntil(
        async () => (await json<Array<{ ref: Record<string, unknown> }>>("/api/execution-hosts")).find((entry) => entry.ref["kind"] === hostKind),
        Boolean, { description: "secret execution host registration", timeoutMs: 10_000 },
      );
      const git = await createGitFixture(worker?.dataDir ?? app.runDirectory);
      const workspace = await json<{ id: string }>("/api/workspaces", "POST", {
        name: "Private CLI credentials", directory: git.repositoryDirectory, executionHost: host!.ref,
        allowClankyContext: false, serverSettings: { agent: { adapter, provider: providers[adapter].provider } },
      }, 201);
      const model = (await json<Array<{ connected: boolean; providerID: string; modelID: string }>>(
        `/api/models?workspaceId=${workspace.id}`,
      )).find((entry) => entry.connected)!;
      const modelConfig = { providerID: model.providerID, modelID: model.modelID, variant: "" };
      const createChat = async (name: string) => (await json<Chat>("/api/chats", "POST", {
        name, workspaceId: workspace.id, model: modelConfig, useWorktree: false, baseBranch: git.branch,
      }, 201)).config.id;
      const id = await createChat("CLI credential conversation");
      const other = await createChat("Independent CLI conversation");
      const send = async (chatId = id) => await json(`/api/chats/${chatId}/messages`, "POST", { message: instruction });
      const question = async (chatId = id) => await pollUntil(
        async () => (await json<Chat>(`/api/chats/${chatId}`)).state,
        (state) => state.harness?.questions?.some((entry) => entry.secretIdentifier === request.identifier && entry.status === "pending") === true,
        { description: "native tool to await private human input", timeoutMs: 10_000, formatLastObserved: JSON.stringify },
      ).then((state) => state.harness!.questions!.findLast((entry) => entry.status === "pending")!);
      const idle = async (chatId = id) => {
        const chat = await pollUntil(() => json<Chat>(`/api/chats/${chatId}`),
          (chat) => ["idle", "failed", "stopped"].includes(chat.state.status),
          { description: "native secret callback to finish its turn", timeoutMs: 10_000, formatLastObserved: JSON.stringify });
        expect(chat.state.status).toBe("idle");
        return chat;
      };
      const receipt = async (): Promise<Receipt> => {
        await idle();
        const snapshot = await json<Snapshot>(`/api/chats/${id}/snapshot?full=1`);
        const message = snapshot.transcript.messages.findLast((entry) => entry.role === "assistant" && entry.content.startsWith("Secret file used: "));
        if (!message) throw new Error(`The CLI did not receive a secret reference: ${JSON.stringify(snapshot)}`);
        return JSON.parse(message.content.slice("Secret file used: ".length));
      };
      const supply = async (pending: Question, value: string | null, chatId = id) => {
        const response = await requestWithCookies(app, cookies, `/api/chats/${chatId}/secrets/${pending.requestId}`, {
          method: "POST", body: JSON.stringify({ value }),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
      };
      const secretMarker = `e2e-private-${crypto.randomUUID()}`;
      const secret = `  ${secretMarker}\nsecond line\n `;
      await send();
      const pending = await question();
      await json(`/api/chats/${other}/secrets/${pending.requestId}`, "POST", { value: secret }, 404);
      await json(`/api/chats/${id}/questions/${pending.requestId}`, "POST", { answers: [[secret]] }, 409);
      if (adapter === "opencode2") {
        // Human interaction must outlive the bridge's ordinary 35-second deadline.
        await Bun.sleep(36_000);
        expect((await json<Chat>(`/api/chats/${id}`)).state.status).toBe("waiting");
      }
      const beforeSave = Date.now();
      await supply(pending, secret);
      const first = await receipt();
      expect(first.sha256).toBe(new Bun.CryptoHasher("sha256").update(secret).digest("hex"));
      expect(first.bytes).toBe(Buffer.byteLength(secret));
      expect(first.expiresAt).toBeGreaterThanOrEqual(beforeSave + 86_400_000);
      expect(first.expiresAt).toBeLessThanOrEqual(Date.now() + 86_400_000);
      expect(first.path.startsWith(join(worker?.dataDir ?? app.dataDirectory, "native", "secrets"))).toBe(true);
      expect((await lstat(first.path)).mode & 0o777).toBe(0o600);
      expect((await lstat(dirname(first.path))).mode & 0o777).toBe(0o700);
      const snapshot = await json(`/api/chats/${id}/snapshot?full=1`);
      expect(JSON.stringify(snapshot)).not.toContain(secretMarker);
      expect((await json<Chat>(`/api/chats/${id}`)).state.harness!.questions!.every((entry) => entry.answers === undefined)).toBe(true);
      await send();
      expect(await receipt()).toEqual(first);
      await json(`/api/chats/${id}/reconnect`, "POST", {});
      await send();
      expect(await receipt()).toEqual(first);
      await send(other);
      const isolated = await question(other);
      await supply(isolated, null, other);
      await idle(other);
      expect(await Bun.file(first.path).exists()).toBe(true);
      await send(other);
      const stopped = await question(other);
      await json(`/api/chats/${other}/interrupt`, "POST", {});
      await pollUntil(() => json<Chat>(`/api/chats/${other}`),
        (chat) => chat.state.harness?.questions?.find((entry) => entry.requestId === stopped.requestId)?.status === "cancelled",
        { description: "Stop to cancel the pending native secret callback", timeoutMs: 10_000 });
      await json(`/api/chats/${other}/secrets/${stopped.requestId}`, "POST", { value: secret }, 409);

      if (adapter === "copilot") {
        const task = await json<{ config: { id: string } }>("/api/tasks", "POST", {
          name: "Autonomous CLI credentials are pre-provisioned", workspaceId: workspace.id, prompt: instruction,
          model: modelConfig, baseBranch: git.branch, useWorktree: false, autoAcceptPlan: false, fullyAutonomous: false,
          attachments: [], maxIterations: 2, maxConsecutiveErrors: 2, activityTimeoutSeconds: null,
          stopPattern: "<promise>COMPLETE</promise>", git: { branchPrefix: "e2e/", commitScope: "" },
          clearPlanningFolder: true, draft: false, cheapModel: { mode: "same-as-task" },
        }, 201);
        await pollUntil(() => json<{ state: { planMode?: { isPlanReady: boolean } } }>(`/api/tasks/${task.config.id}`),
          (task) => task.state.planMode?.isPlanReady === true,
          { description: "unattended task to plan without requesting or reusing secrets", timeoutMs: 10_000 });
        const taskSnapshot = await json<Snapshot>(`/api/tasks/${task.config.id}/snapshot?full=1`);
        expect(taskSnapshot.transcript.messages.some((message) => message.content.includes("Secret tool unavailable."))).toBe(true);
        expect(JSON.stringify(taskSnapshot)).not.toContain(first.path);
        await json(`/api/tasks/${task.config.id}/plan/discard`, "POST", {});
      }
      await unlink(first.path);
      await send();
      const missing = await question();
      await supply(missing, secret);
      const replacement = await receipt();
      expect(replacement.path).not.toBe(first.path);
      if (worker) {
        worker.child.kill("SIGKILL");
        await worker.child.exited;
        await restartMeshNode(worker);
      }
      else await app.restart({ force: true, disablePasskey: false, env: environment });
      expect(await Bun.file(replacement.path).exists()).toBe(false);
      await json(`/api/chats/${id}/reconnect`, "POST", {});
      await send();
      const restarted = await question();
      await supply(restarted, null);
      await idle();
      expect((await app.diagnostics()).includes(secretMarker)).toBe(false);
    } catch (error) {
      console.error(await app.diagnostics());
      if (worker) console.error(await meshNodeDiagnostics(worker));
      throw error;
    } finally {
      if (worker) await stopMeshNode(worker);
      if (proxy?.exitCode === null) proxy.kill();
      await proxy?.exited;
      await proxyOutput;
      await app.cleanup();
    }
  });
}
