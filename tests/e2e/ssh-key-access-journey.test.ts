import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import net from "node:net";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  compiledClankyCommand, enrollMeshWorker, meshJsonRequest, meshNodeDiagnostics,
  startMeshNode, stopMeshNode, type ManagedMeshNode,
} from "./support/mesh-cluster";
import { pollUntil } from "./support/polling";
import { currentEnvironment, requireCommand, runCommand } from "./support/process";
import { MESH_OPERATION_TIMEOUT_MS } from "./support/timeouts";
import { installExternalNativeCopilotProvider } from "./support/provider";
import { getMeshTestTls } from "./support/mesh-tls";

beforeAll(async () => { await getMeshTestTls(); });

interface Host { ref: { kind: "local" | "mesh"; nodeId: string } }
interface Identity { publicKey: string; fingerprint: string; comment: string }

test("workspace grants filter a Mesh custodian agent and revoke new signatures live", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clanky-ssh-"));
  const previousTmpdir = process.env["TMPDIR"];
  process.env["TMPDIR"] = directory;
  for (const name of Object.keys(process.env)) if (name.startsWith("CLANKY_WORKER_")) delete process.env[name];
  const nodes: ManagedMeshNode[] = [];
  let agent: ReturnType<typeof Bun.spawn> | undefined;
  let agentOutput: Promise<string> | undefined;
  let failure: unknown;
  try {
    const home = join(directory, "home");
    const agentPath = join(directory, "agent");
    await mkdir(home, { mode: 0o700 });
    const environment = currentEnvironment({ HOME: home, SSH_AUTH_SOCK: agentPath, BASH_ENV: undefined, ENV: undefined });
    agent = Bun.spawn(["ssh-agent", "-D", "-a", agentPath], {
      cwd: directory, env: environment, stdout: "pipe", stderr: "pipe",
    });
    agentOutput = Promise.all([
      new Response(agent.stdout instanceof ReadableStream ? agent.stdout : undefined).text(),
      new Response(agent.stderr instanceof ReadableStream ? agent.stderr : undefined).text(),
    ]).then((parts) => parts.join("\n"));
    await pollUntil(
      async () => (await runCommand(["ssh-add", "-l"], { cwd: directory, env: environment })).exitCode,
      (code) => code === 1,
      { description: "isolated SSH agent to accept requests", timeoutMs: 5000 },
    );
    const selected = join(directory, "selected");
    const unselected = join(directory, "unselected");
    for (const key of [selected, unselected]) await requireCommand(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", key === selected ? "selected" : "unselected", "-f", key], { cwd: directory, env: environment });
    await requireCommand(["ssh-add", selected, unselected], { cwd: directory, env: environment });
    const command = await compiledClankyCommand();
    const controller = await startMeshNode({
      role: "controller", command,
      environment: { HOME: home, SSH_AUTH_SOCK: undefined, CLANKY_SSH_AGENT_SOURCE_SOCK: "", CLANKY_SSH_AGENT_SOCKET_DIR: join(directory, "c") },
    });
    nodes.push(controller);
    const custodian = await startMeshNode({
      role: "worker", command, instanceName: "Key custodian",
      environment: { HOME: home, SSH_AUTH_SOCK: agentPath, CLANKY_SSH_AGENT_SOURCE_SOCK: agentPath, CLANKY_WORKSPACE_SSH_AGENT: undefined },
    });
    nodes.push(custodian);
    await enrollMeshWorker(controller, custodian);
    const hosts = await meshJsonRequest<Host[]>(controller, "/api/execution-hosts");
    expect(hosts.status).toBe(200);
    const sourceHost = hosts.body.find((host) => host.ref.kind === "mesh")!;
    const source = await meshJsonRequest<{ id: string }>(controller, "/api/ssh-key-access/sources", {
      method: "POST", body: { name: "Disposable custodian agent", host: sourceHost.ref },
    });
    expect(source.status, JSON.stringify(source.body)).toBe(201);
    const discovered = await meshJsonRequest<{ identities: Identity[] }>(controller, `/api/ssh-key-access/sources/${source.body.id}/identities`);
    expect(discovered.status).toBe(200);
    expect(discovered.body.identities).toHaveLength(2);
    const identity = discovered.body.identities.find((key) => key.comment === "selected")!;
    const registered = await meshJsonRequest<{ id: string }>(controller, `/api/ssh-key-access/sources/${source.body.id}/keys`, {
      method: "POST", body: { publicKey: identity.publicKey, alias: "Selected repository key" },
    });
    expect(registered.status).toBe(201);

    const reservation = await meshJsonRequest<{ enrollment: { id: string }; token: string }>(controller, "/api/workspace-worker-enrollments", {
      method: "POST", body: { name: "Disposable dedicated worker", ttlSeconds: 900, route: "direct" },
    });
    expect(reservation.status).toBe(201);
    const controllerStatus = await meshJsonRequest<{ node: { fingerprint: string } }>(controller, "/api/mesh/status");
    const worker = await startMeshNode({
      role: "worker", command, instanceName: "Dedicated SSH workspace",
      environment: { HOME: home, SSH_AUTH_SOCK: undefined, CLANKY_SSH_AGENT_SOURCE_SOCK: "", CLANKY_WORKSPACE_SSH_AGENT: "1", CLANKY_SSH_AGENT_SOCKET_DIR: join(directory, "w") },
    });
    nodes.push(worker);
    await requireCommand([
      ...command, "worker", "join", controller.meshEndpoint!,
      "--token", reservation.body.token, "--fingerprint", controllerStatus.body.node.fingerprint,
    ], { cwd: directory, env: currentEnvironment(worker.environment), timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    const workspace = await meshJsonRequest<{ id: string }>(controller, "/api/workspaces", {
      method: "POST", body: {
        name: "Selected-key workspace", directory: worker.dataDir,
        workspaceWorkerEnrollmentId: reservation.body.enrollment.id, workspaceType: "directory",
        serverSettings: { agent: { adapter: "copilot", provider: "copilot" } },
      },
    });
    expect(workspace.status, JSON.stringify(workspace.body)).toBe(201);
    const socket = await meshJsonRequest<{ socketPath: string }>(controller, `/api/workspaces/${workspace.body.id}/ssh-agent`, { method: "POST" });
    expect(socket.status, JSON.stringify(socket.body)).toBe(200);
    expect((await lstat(socket.body.socketPath)).mode & 0o777).toBe(0o600);
    const scopedEnvironment = currentEnvironment({ HOME: home, SSH_AUTH_SOCK: socket.body.socketPath });
    const agentCommand = (args: string[]) => runCommand(["ssh-add", ...args], { cwd: directory, env: scopedEnvironment });
    expect((await agentCommand(["-L"])).exitCode).toBe(1);
    const grantPath = `/api/workspaces/${workspace.body.id}/ssh-key-access/${registered.body.id}`;
    expect((await meshJsonRequest(controller, grantPath, { method: "PUT", body: { enabled: true } })).status).toBe(200);
    const listing = await agentCommand(["-L"]);
    expect(listing.exitCode, listing.stderr).toBe(0);
    expect(listing.stdout.trim().split("\n")).toHaveLength(1);
    expect(listing.stdout).toContain(identity.publicKey);
    expect((await agentCommand(["-T", `${selected}.pub`])).exitCode).toBe(0);
    expect((await agentCommand(["-T", `${unselected}.pub`])).exitCode).not.toBe(0);
    expect((await agentCommand(["-D"])).exitCode).not.toBe(0);
    expect((await requireCommand(["ssh-add", "-L"], { cwd: directory, env: environment })).stdout.trim().split("\n")).toHaveLength(2);
    await requireCommand(["ssh-add", "-d", `${selected}.pub`], { cwd: directory, env: environment });
    expect((await agentCommand(["-T", `${selected}.pub`])).exitCode).not.toBe(0);
    await requireCommand(["ssh-add", selected], { cwd: directory, env: environment });
    const oversizedResponse = await new Promise<Buffer>((resolveResponse, reject) => {
      const client = net.createConnection(socket.body.socketPath);
      let received: Buffer = Buffer.alloc(0);
      client.setTimeout(5000, () => { client.destroy(); reject(new Error("Oversized SSH-agent frame was not rejected.")); });
      client.once("connect", () => {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(256 * 1024 + 1);
        client.write(header);
      });
      client.on("data", (chunk: Buffer) => { received = Buffer.concat([received, chunk]); });
      client.once("error", reject);
      client.once("close", () => resolveResponse(received));
    });
    expect(oversizedResponse.byteLength).toBe(0);

    const localHost = hosts.body.find((host) => host.ref.kind === "local")!;
    const other = await meshJsonRequest<{ id: string }>(controller, "/api/workspaces", {
      method: "POST", body: {
        name: "No SSH grants", directory, executionHost: localHost.ref, workspaceType: "directory",
        serverSettings: { agent: { adapter: "copilot", provider: "copilot" } },
      },
    });
    expect(other.status).toBe(201);
    const otherSocket = await meshJsonRequest<{ socketPath: string }>(controller, `/api/workspaces/${other.body.id}/ssh-agent`, { method: "POST" });
    expect(otherSocket.status).toBe(200);
    expect((await runCommand(["ssh-add", "-T", `${selected}.pub`], {
      cwd: directory, env: currentEnvironment({ HOME: home, SSH_AUTH_SOCK: otherSocket.body.socketPath }),
    })).exitCode).not.toBe(0);

    expect((await meshJsonRequest(controller, grantPath, { method: "PUT", body: { enabled: false } })).status).toBe(200);
    expect((await agentCommand(["-L"])).exitCode).toBe(1);
    expect((await agentCommand(["-T", `${selected}.pub`])).exitCode).not.toBe(0);
    expect((await meshJsonRequest(controller, grantPath, { method: "PUT", body: { enabled: true } })).status).toBe(200);
    agent.kill();
    await agent.exited;
    expect((await agentCommand(["-T", `${selected}.pub`])).exitCode).not.toBe(0);
    const unavailable = await meshJsonRequest<{ error: string }>(controller, `/api/ssh-key-access/sources/${source.body.id}/identities`);
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error).toBe("ssh_agent_source_unavailable");
    await stopMeshNode(custodian);
    expect((await agentCommand(["-T", `${selected}.pub`])).exitCode).not.toBe(0);

    expect((await meshJsonRequest(controller, grantPath, { method: "PUT", body: { enabled: false } })).status).toBe(200);
    controller.child.kill();
    await controller.child.exited;
    const stdoutPath = join(directory, "controller-restarted.stdout");
    const stderrPath = join(directory, "controller-restarted.stderr");
    controller.child = Bun.spawn([...command, ...controller.serveArguments], {
      cwd: directory, env: currentEnvironment(controller.environment), stdin: "ignore",
      stdout: Bun.file(stdoutPath), stderr: Bun.file(stderrPath),
    });
    controller.output = {
      stdout: controller.child.exited.then(async () => await Bun.file(stdoutPath).text()),
      stderr: controller.child.exited.then(async () => await Bun.file(stderrPath).text()),
      snapshot: () => [stdoutPath, stderrPath].map((path) => {
        try { return readFileSync(path, "utf8"); } catch { return ""; }
      }).join("\n"),
    };
    const persisted = await pollUntil(
      async () => await meshJsonRequest<{ keys: Array<{ id: string }> }>(controller, "/api/ssh-key-access").catch(() => null),
      (response) => response?.status === 200,
      { description: "SSH-key metadata after controller restart", timeoutMs: 10_000 },
    );
    expect(persisted?.body.keys.some((key) => key.id === registered.body.id)).toBe(true);
    const persistedAccess = await meshJsonRequest<{ grants: Array<{ keyId: string; enabled: boolean }> }>(controller, `/api/workspaces/${workspace.body.id}/ssh-key-access`);
    expect(persistedAccess.status).toBe(200);
    expect(persistedAccess.body.grants.find((grant) => grant.keyId === registered.body.id)?.enabled).toBe(false);
    await stopMeshNode(worker);
    expect(await lstat(socket.body.socketPath).catch(() => null)).toBeNull();
  } catch (error) {
    failure = error;
  } finally {
    const diagnostics = nodes.map(meshNodeDiagnostics).join("\n");
    const cleanup = await Promise.allSettled(nodes.reverse().map(stopMeshNode));
    if (agent?.exitCode === null) agent.kill();
    if (agent) await agent.exited;
    const output = await agentOutput;
    if (previousTmpdir === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = previousTmpdir;
    await rm(directory, { recursive: true, force: true });
    if (failure) throw new Error(`Scoped SSH-key workflow failed.\n${diagnostics}\n${output ?? ""}`, { cause: failure });
    const failedCleanup = cleanup.find((result) => result.status === "rejected");
    if (failedCleanup?.status === "rejected") throw failedCleanup.reason;
  }
}, 120_000);

test("ordinary workspaces and server work retain local keys alongside separately granted custodian keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clanky-shared-ssh-"));
  const previousTmpdir = process.env["TMPDIR"];
  process.env["TMPDIR"] = directory;
  const home = join(directory, "home");
  const project = join(directory, "project");
  const nodes: ManagedMeshNode[] = [];
  const agents: Array<{ child: ReturnType<typeof Bun.spawn>; output: Promise<string> }> = [];
  let terminal: WebSocket | undefined;
  let failure: unknown;
  try {
    await mkdir(home, { mode: 0o700 });
    await mkdir(project, { mode: 0o700 });
    const bin = join(directory, "bin");
    await installExternalNativeCopilotProvider(bin);
    const environment = currentEnvironment({ HOME: home, BASH_ENV: undefined, ENV: undefined });
    const remoteKey = join(directory, "remote");
    const localKey = join(directory, "local");
    for (const [key, name] of [[remoteKey, "shared-repository"], [localKey, "local-repository"]] as const) {
      await requireCommand(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", name, "-f", key], { cwd: directory, env: environment });
    }
    const startAgent = async (socket: string, key: string) => {
      const env = currentEnvironment({ HOME: home, SSH_AUTH_SOCK: socket, BASH_ENV: undefined, ENV: undefined });
      const child = Bun.spawn(["ssh-agent", "-D", "-a", socket], { cwd: directory, env, stdout: "pipe", stderr: "pipe" });
      agents.push({ child, output: Promise.all([
        new Response(child.stdout instanceof ReadableStream ? child.stdout : undefined).text(),
        new Response(child.stderr instanceof ReadableStream ? child.stderr : undefined).text(),
      ]).then((parts) => parts.join("\n")) });
      await pollUntil(async () => (await runCommand(["ssh-add", "-l"], { cwd: directory, env })).exitCode, (code) => code === 1,
        { description: "isolated shared-key agent startup", timeoutMs: 5000 });
      await requireCommand(["ssh-add", key], { cwd: directory, env });
      return env;
    };
    const remoteEnvironment = await startAgent(join(directory, "a"), remoteKey);
    const localEnvironment = await startAgent(join(directory, "b"), localKey);
    const command = await compiledClankyCommand();
    const controller = await startMeshNode({ role: "controller", command,
      environment: { HOME: home, SSH_AUTH_SOCK: undefined, CLANKY_SSH_AGENT_SOURCE_SOCK: "", CLANKY_SSH_AGENT_SOCKET_DIR: join(directory, "c") } });
    nodes.push(controller);
    const custodian = await startMeshNode({ role: "worker", command, instanceName: "Shared-key custodian",
      environment: { HOME: home, SSH_AUTH_SOCK: remoteEnvironment["SSH_AUTH_SOCK"], CLANKY_SSH_AGENT_SOURCE_SOCK: remoteEnvironment["SSH_AUTH_SOCK"] } });
    nodes.push(custodian);
    await enrollMeshWorker(controller, custodian);
    const sources = await meshJsonRequest<Host[]>(controller, "/api/execution-hosts");
    const sourceHost = sources.body.find((host) => host.ref.kind === "mesh")!;
    const consumer = await startMeshNode({ role: "worker", command, instanceName: "Ordinary registered server",
      environment: { HOME: home, SSH_AUTH_SOCK: localEnvironment["SSH_AUTH_SOCK"], CLANKY_SSH_AGENT_SOURCE_SOCK: localEnvironment["SSH_AUTH_SOCK"],
        CLANKY_SSH_AGENT_SOCKET_DIR: join(directory, "s"), PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}` } });
    nodes.push(consumer);
    await enrollMeshWorker(controller, consumer);
    const hosts = await meshJsonRequest<Host[]>(controller, "/api/execution-hosts");
    const host = hosts.body.find((candidate) => candidate.ref.kind === "mesh" && candidate.ref.nodeId !== sourceHost.ref.nodeId)!;
    const hostPath = `/api/execution-hosts/mesh/${host.ref.nodeId}`;
    const source = await meshJsonRequest<{ id: string }>(controller, "/api/ssh-key-access/sources", {
      method: "POST", body: { name: "Repository custodian", host: sourceHost.ref },
    });
    expect(source.status, JSON.stringify(source.body)).toBe(201);
    const identities = await meshJsonRequest<{ identities: Identity[] }>(controller, `/api/ssh-key-access/sources/${source.body.id}/identities`);
    const identity = identities.body.identities[0]!;
    const key = await meshJsonRequest<{ id: string }>(controller, `/api/ssh-key-access/sources/${source.body.id}/keys`, {
      method: "POST", body: { publicKey: identity.publicKey, alias: "Shared repository key" },
    });
    expect(key.status).toBe(201);
    const workspace = await meshJsonRequest<{ id: string }>(controller, "/api/workspaces", {
      method: "POST", body: { name: "Ordinary SSH project", directory: project, executionHost: host.ref, workspaceType: "directory",
        allowClankyContext: false, serverSettings: { agent: { adapter: "copilot", provider: "copilot" } } },
    });
    expect(workspace.status, JSON.stringify(workspace.body)).toBe(201);
    const workspacePath = `/api/workspaces/${workspace.body.id}`;
    const socket = await meshJsonRequest<{ socketPath: string }>(controller, `${workspacePath}/ssh-agent`, { method: "POST" });
    expect(socket.status, JSON.stringify(socket.body)).toBe(200);
    const workspaceAgent = (args: string[]) => runCommand(["ssh-add", ...args], {
      cwd: directory, env: currentEnvironment({ HOME: home, SSH_AUTH_SOCK: socket.body.socketPath }),
    });
    const hostGrant = `${hostPath}/ssh-key-access/${key.body.id}`;
    const workspaceGrant = `${workspacePath}/ssh-key-access/${key.body.id}`;
    expect((await meshJsonRequest(controller, hostGrant, { method: "PUT", body: { enabled: true } })).status).toBe(200);
    expect((await workspaceAgent(["-T", `${remoteKey}.pub`])).exitCode).not.toBe(0);
    expect((await workspaceAgent(["-T", `${localKey}.pub`])).exitCode).toBe(0);
    const hostExec = async (args: string[]) => {
      const result = await meshJsonRequest<{ exitCode: number; stdout: string; stderr: string }>(controller, `${hostPath}/exec`, {
        method: "POST", body: { command: "ssh-add", args, cwd: project },
      });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      return result.body;
    };
    expect((await hostExec(["-T", `${remoteKey}.pub`, `${localKey}.pub`])).exitCode).toBe(0);
    const listing = await hostExec(["-L"]);
    expect(listing.stdout.trim().split("\n")).toHaveLength(2);
    expect(listing.stdout).toContain(identity.publicKey);
    expect((await meshJsonRequest(controller, workspaceGrant, { method: "PUT", body: { enabled: true } })).status).toBe(200);

    const session = await meshJsonRequest<{ config: { id: string } }>(controller, "/api/terminal-sessions", {
      method: "POST", body: { name: "Shared-key project terminal", workspaceId: workspace.body.id, connectionMode: "direct", useTmux: false },
    });
    expect(session.status, JSON.stringify(session.body)).toBe(201);
    let output = "";
    let terminalError: string | undefined;
    const TerminalWebSocket = WebSocket as typeof WebSocket & { new (url: string, options: Bun.WebSocketOptions): WebSocket };
    terminal = new TerminalWebSocket(`${controller.baseUrl.replace("http:", "ws:")}/api/terminal?terminalSessionId=${session.body.config.id}`, {
      headers: { Origin: controller.baseUrl, ...(controller.apiKey ? { Authorization: `Bearer ${controller.apiKey}` } : {}) },
    });
    terminal.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; data?: string; message?: string };
      if (message.type === "terminal.connected") terminal!.send(JSON.stringify({ type: "terminal.input",
        data: `ssh-add -T '${remoteKey}.pub' '${localKey}.pub' && printf '%s%s\\n' shared- terminal-verified\n` }));
      if (message.type === "terminal.output") output += message.data ?? "";
      if (message.type === "terminal.error") terminalError = message.message ?? "Terminal failed";
    });
    await pollUntil(async () => { if (terminalError) throw new Error(terminalError); return output; },
      (value) => value.includes("shared-terminal-verified"), { description: "project terminal to sign with local and custodian keys", timeoutMs: 10_000 });
    terminal.close();

    const models = await meshJsonRequest<Array<{ providerID: string; modelID: string }>>(controller, `${hostPath}/chat-models`, {
      method: "POST", body: { directory: project, providerID: "copilot" },
    });
    expect(models.status, JSON.stringify(models.body)).toBe(200);
    const model = models.body[0]!;
    const chat = await meshJsonRequest<{ config: { id: string } }>(controller, `${hostPath}/chats`, {
      method: "POST", body: { name: "Use the shared repository", directory: project, adapter: "copilot",
        model: { providerID: model.providerID, modelID: model.modelID, variant: "" } },
    });
    expect(chat.status, JSON.stringify(chat.body)).toBe(201);
    const chatPath = `/api/chats/${chat.body.config.id}`;
    expect((await meshJsonRequest(controller, `${chatPath}/messages`, {
      method: "POST", body: { message: `[ssh-key-check:${remoteKey}.pub]` },
    })).status).toBe(200);
    const conversation = await pollUntil(async () => await meshJsonRequest<{
      transcript: { messages: Array<{ role: string; content: string }> };
    }>(controller, `${chatPath}/snapshot?full=1`),
    (response) => response.body.transcript?.messages.some((message) => message.role === "assistant") === true,
    { description: "server agent to use the custodian key", timeoutMs: 10_000 });
    const answer = conversation.body.transcript.messages.find((message) => message.role === "assistant")!.content;
    expect(answer).toContain("SSH signature verified");
    expect(answer).toContain(identity.publicKey);
    expect(answer).toContain("local-repository");

    expect((await meshJsonRequest(controller, hostGrant, { method: "PUT", body: { enabled: false } })).status).toBe(200);
    expect((await hostExec(["-T", `${remoteKey}.pub`])).exitCode).not.toBe(0);
    expect((await hostExec(["-T", `${localKey}.pub`])).exitCode).toBe(0);
    expect((await workspaceAgent(["-T", `${remoteKey}.pub`])).exitCode).toBe(0);
    agents[0]!.child.kill();
    await agents[0]!.child.exited;
    expect((await workspaceAgent(["-T", `${remoteKey}.pub`])).exitCode).not.toBe(0);
    expect((await workspaceAgent(["-T", `${localKey}.pub`])).exitCode).toBe(0);
    expect((await requireCommand(["ssh-add", "-L"], { cwd: directory, env: localEnvironment })).stdout.trim().split("\n")).toHaveLength(1);
    expect((await meshJsonRequest(controller, workspacePath, { method: "DELETE" })).status).toBe(200);
    expect(await lstat(socket.body.socketPath).catch(() => null)).toBeNull();
  } catch (error) { failure = error; }
  finally {
    terminal?.close();
    const diagnostics = nodes.map(meshNodeDiagnostics).join("\n");
    const errors: unknown[] = [];
    for (const node of nodes) {
      try { await stopMeshNode(node); } catch (error) { errors.push(error); }
    }
    for (const agent of agents) {
      if (agent.child.exitCode === null) agent.child.kill();
      await agent.child.exited;
      await agent.output;
    }
    if (previousTmpdir === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = previousTmpdir;
    await rm(directory, { recursive: true, force: true });
    if (failure) throw new Error(`General SSH-key workflow failed.\n${diagnostics}`, { cause: failure });
    if (errors.length) throw new AggregateError(errors, "General SSH-key workflow cleanup failed.");
  }
}, 120_000);
