import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import net from "node:net";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  compiledClankyCommand, enrollMeshWorker, meshJsonRequest, meshNodeDiagnostics,
  startMeshNode, stopMeshNode, type ManagedMeshNode,
} from "./support/mesh-cluster";
import { pollUntil } from "./support/polling";
import { currentEnvironment, requireCommand, runCommand } from "./support/process";
import { MESH_OPERATION_TIMEOUT_MS } from "./support/timeouts";

interface Host { ref: { kind: "local" | "mesh"; nodeId: string } }
interface Identity { publicKey: string; fingerprint: string; comment: string }

test("workspace grants filter a Mesh custodian agent and revoke new signatures live", async () => {
  const directory = resolve(`.ssh-${crypto.randomUUID().slice(0, 4)}`);
  await mkdir(directory, { mode: 0o700 });
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
    const command = process.env["CLANKY_CREDENTIAL_TEST_BINARY"]
      ? [resolve(process.env["CLANKY_CREDENTIAL_TEST_BINARY"]!)] : await compiledClankyCommand();
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
