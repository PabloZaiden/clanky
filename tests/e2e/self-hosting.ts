import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, posix, resolve } from "node:path";
import { parseArgs } from "node:util";
import { E2EApplication } from "./support/application";
import {
  currentEnvironment,
  findFreeLoopbackPort,
  startManagedProcess,
  stopManagedProcess,
  type CommandResult,
  type ManagedProcess,
} from "./support/process";

const root = resolve(import.meta.dir, "../..");
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: "boolean" },
    source: { type: "string" },
    "worker-binary": { type: "string" },
    "controller-host": { type: "string" },
  },
});
if (values.help) {
  console.log(`Usage: bun run test:self-hosting [options]

Run manually as a non-root user with Docker and the Dev Containers CLI.
Requires freshly built dist/clanky, Internet access and a clean source checkout.
Creates an isolated controller, SSH repository and actual Clanky devcontainer.

  --source PATH             Clean Clanky source (default: repository root)
  --worker-binary PATH      Same-revision Linux worker (default: dist/clanky on Linux)
  --controller-host IPV4    This host's container-reachable address
                           (default: Docker bridge gateway on Linux; required on macOS)

This expensive acceptance is never part of ordinary tests or PR discovery.
AI/auth traffic uses the existing external provider; no personal credentials.`);
  process.exit(0);
}
if (process.getuid?.() === 0) throw new Error("Run self-hosting acceptance as a non-root user with Docker access.");
if (process.platform !== "linux" && (!values["worker-binary"] || !values["controller-host"])) {
  throw new Error("Provide --worker-binary for Linux and --controller-host reachable from containers.");
}
process.umask(0o077);
const source = resolve(values.source ?? root);
const binary = join(root, "dist/clanky");
const workerBinary = resolve(values["worker-binary"] ?? binary);
const workerBytes = await readFile(workerBinary);
if (workerBytes.subarray(0, 4).toString("hex") !== "7f454c46") throw new Error("The worker binary must be built for Linux.");
const expectedDigest = createHash("sha256").update(workerBytes).digest("hex");
const reportDirectory = await mkdtemp(join(tmpdir(), "clanky-self-hosting-report-"));
const app = await E2EApplication.create();
const projectBase = join(app.runDirectory, "projects");
const checkout = join(projectBase, "repo");
const fixtures = join(app.runDirectory, "fixtures");
const certificate = join(fixtures, "controller.pem");
const sourceKey = join(fixtures, "workspace-key");
const hostKey = join(fixtures, "host-key");
const agentSocket = join(fixtures, "agent.s");
const sshImage = `clanky-self-hosting-sshd:${basename(app.runDirectory)}`;
const sshName = `clanky-self-hosting-repository-${basename(app.runDirectory)}`;
const environment = currentEnvironment({
  ...Object.fromEntries(Object.keys(process.env).filter((name) => name.startsWith("CLANKY_WORKER_")).map((name) => [name, undefined])),
  HOME: app.homeDirectory,
  CLANKY_DATA_DIR: app.dataDirectory,
  CLANKY_DISABLE_PASSKEY: undefined,
  GH_TOKEN: undefined,
  GITHUB_TOKEN: undefined,
  COPILOT_GITHUB_TOKEN: undefined,
  XDG_CONFIG_HOME: join(app.homeDirectory, ".config"),
  DOCKER_CONFIG: join(app.homeDirectory, ".docker"),
});
type Inspection = {
  Id: string;
  State: { Running: boolean };
  Mounts: Array<{ Type: string; Name?: string; Source: string; Destination: string }>;
};
type Snapshot = {
  job: { config: { id: string }; state: { status: string; error?: { message: string } } };
};
type Workspace = { id: string; name: string; executionHostBinding: unknown };
const preexistingVolumes = new Set<string>();
const ownedVolumes = new Set<string>();
const ownedContainers = new Set<string>();
const results: Array<{ name: string; seconds: number }> = [];
let controller: ManagedProcess | undefined;
let agent: ManagedProcess | undefined;
let observer: Promise<void> | undefined;
let stopObserver = false;
let seedingError: unknown;
let seeded = false;
let containerId: string | undefined;
let workspaceId: string | undefined;
let baseUrl = "";
let trustedCertificate = "";
let cookie = "";
let lastSnapshot: Snapshot | undefined;
let complete = false;
let previousStep = performance.now();

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
async function command(args: string[], options: { stdin?: string | Uint8Array; allowFailure?: boolean; env?: Record<string, string> } = {}): Promise<CommandResult> {
  const child = Bun.spawn(args, {
    cwd: root, env: { ...environment, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe",
  });
  if (options.stdin !== undefined) {
    child.stdin!.write(options.stdin);
    child.stdin!.end();
  }
  const timeout = setTimeout(() => child.kill(), 300_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    assert(exitCode === 0 || options.allowFailure, `${args[0]} ${args[1] ?? ""} failed: ${stderr || stdout}`);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
  }
}
async function until<T>(label: string, action: () => Promise<T | undefined>, budget = 30_000): Promise<T> {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const value = await action();
    if (value !== undefined) return value;
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function request(path: string, method = "GET", body?: unknown, timeout = 20_000): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, {
    method, signal: AbortSignal.timeout(timeout), tls: { ca: trustedCertificate, rejectUnauthorized: true },
    headers: { origin: baseUrl, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function api<T = Record<string, unknown>>(path: string, method = "GET", body?: unknown, expected = 200, timeout = 20_000): Promise<T> {
  const response = await request(path, method, body, timeout);
  if (response.status !== expected) {
    await response.body?.cancel();
    throw new Error(`${method} ${path.split("?")[0]} returned HTTP ${response.status}`);
  }
  return await response.json() as T;
}
async function pass(name: string) {
  const now = performance.now();
  results.push({ name, seconds: Math.round((now - previousStep) / 100) / 10 });
  previousStep = now;
  console.log(`PASS ${name}`);
}
async function containers(): Promise<Inspection[]> {
  const ids = (await command(["docker", "ps", "-aq", "--filter", "label=clanky.environment"])).stdout.trim().split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  const inspected = await command(["docker", "inspect", ...ids], { allowFailure: true });
  const rows = JSON.parse(inspected.stdout) as Inspection[];
  const owned = rows.filter((row) => row.Mounts.some((mount) => mount.Type === "bind" && mount.Source === checkout));
  for (const row of owned) {
    ownedContainers.add(row.Id);
    for (const mount of row.Mounts) {
      if (mount.Type === "volume" && mount.Name && !preexistingVolumes.has(mount.Name)) ownedVolumes.add(mount.Name);
    }
  }
  return owned;
}
async function dockerExec(script: string, stdin?: string | Uint8Array) {
  assert(containerId, "The owned container has not been discovered");
  return await command(["docker", "exec", ...(stdin === undefined ? [] : ["-i"]), "--user", "vscode", containerId, "sh", "-ec", script], { stdin });
}
async function seedRelease(container: Inspection) {
  const sourceMount = container.Mounts.find((mount) => mount.Type === "bind" && mount.Source === checkout);
  assert(sourceMount, "The owned source mount is unavailable");
  await dockerExec("umask 077; mkdir -p /var/lib/clanky/acceptance-release /var/lib/clanky/runtime/bin");
  await dockerExec("cat > /var/lib/clanky/acceptance-release/clanky", workerBytes);
  await dockerExec("cat > /var/lib/clanky/acceptance-release/checksum", `${expectedDigest}  clanky\n`);
  await dockerExec("cat > /var/lib/clanky/acceptance-release/installer.json", await readFile(join(source, ".github/installer.json")));
  await dockerExec("cat > /var/lib/clanky/acceptance-release/provider-cli; chmod 700 /var/lib/clanky/acceptance-release/provider-cli", `#!/bin/sh
set -eu
if [ "$#" -eq 1 ] && [ "$1" = --version ]; then
  original=$(cat /var/lib/clanky/acceptance-release/vendor-copilot)
  exec "$original" "$@"
fi
exec bun ${quote(posix.join(sourceMount.Destination, "tests/e2e/providers/copilot-native.ts"))} "$@"
`);
  // Only release bytes and external AI/auth traffic are deterministic. The real
  // pinned installer, its checksum, worker enrollment, TLS and Mesh stay intact.
  await dockerExec("cat > /var/lib/clanky/runtime/bin/curl; chmod 700 /var/lib/clanky/runtime/bin/curl", `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const path = require("node:path");
const args = process.argv.slice(2);
const url = args.find(arg => arg.startsWith("https://"));
const base = "/var/lib/clanky/acceptance-release/";
const vendor = fs.realpathSync("/var/lib/clanky/runtime/bin/copilot");
const original = path.join(path.dirname(vendor), "acceptance-original-" + path.basename(vendor));
if (!fs.existsSync(original)) {
  fs.copyFileSync(vendor, original);
  fs.chmodSync(original, 0o700);
}
fs.writeFileSync(base + "vendor-copilot", original, {mode:0o600});
fs.writeFileSync(vendor, fs.readFileSync(base + "provider-cli"));
fs.chmodSync(vendor, 0o700);
let file;
let text;
if (url === "https://api.github.com/repos/pablozaiden/clanky/releases/latest") text = '{"tag_name":"v0.0.0-acceptance"}';
else if (/^https:\\/\\/github.com\\/pablozaiden\\/clanky\\/releases\\/download\\/v0.0.0-acceptance\\/clanky-v0.0.0-acceptance-linux-(x64|arm64)\\.sha256$/.test(url || "")) file = "checksum";
else if (/^https:\\/\\/github.com\\/pablozaiden\\/clanky\\/releases\\/download\\/v0.0.0-acceptance\\/clanky-v0.0.0-acceptance-linux-(x64|arm64)$/.test(url || "")) file = "clanky";
else if (url === "https://raw.githubusercontent.com/pablozaiden/clanky/main/.github/installer.json") file = "installer.json";
else {
  const result = cp.spawnSync("/usr/bin/curl", args, { stdio: "inherit" });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  process.exit(result.status ?? 1);
}
if (fs.existsSync(base + "offline") && file !== "installer.json") {
  console.error("Acceptance release service is unavailable.");
  process.exit(22);
}
const outputFlag = args.indexOf("-o");
const bytes = file ? fs.readFileSync(base + file) : Buffer.from(text);
if (outputFlag >= 0) fs.writeFileSync(args[outputFlag + 1], bytes, { mode: 0o600 });
else process.stdout.write(bytes);
`);
  seeded = true;
}
async function workspaceExec(script: string, allowFailure = false, timeoutMs = 20_000) {
  assert(workspaceId, "A completed public workspace is required");
  const result = await api<CommandResult & { success: boolean }>(
    `/api/workspaces/${workspaceId}/exec`, "POST",
    { command: "sh", args: ["-lc", `set -eu\n${script}`], timeoutMs }, 200, timeoutMs + 5000,
  );
  assert(allowFailure || result.success, `Workspace command failed: ${result.stderr || result.stdout}`);
  return result;
}
async function finishJob(id: string) {
  return await until("public environment provisioning", async () => {
    if (seedingError) throw seedingError;
    lastSnapshot = await api<Snapshot>(`/api/provisioning-jobs/${id}`);
    const state = lastSnapshot.job.state;
    assert(!["failed", "cancelled"].includes(state.status), `Provisioning ${state.status}: ${state.error?.message ?? "No error message"}`);
    return state.status === "completed" ? lastSnapshot : undefined;
  }, 720_000);
}
async function verifyWorkspace() {
  const result = await workspaceExec(`test "$(id -u)" != 0
test -w .
test "$(stat -c '%a' /var/lib/clanky/data)" = 700
test "$(cat "$COPILOT_HOME/acceptance-profile")" = preserved
test "$(cat .acceptance-source)" = preserved
git ls-remote origin HEAD
sha256sum /var/lib/clanky/bin/clanky`);
  assert(result.stdout.includes(expectedDigest), "The worker no longer runs the selected implementation artifact");
}
async function waitForWorkspace() {
  await until("signed workspace execution after recovery", async () => {
    const response = await request(`/api/workspaces/${workspaceId}/exec`, "POST", { command: "pwd", args: [], timeoutMs: 5000 }, 10_000);
    if ([502, 503, 504].includes(response.status)) {
      await response.body?.cancel();
      return undefined;
    }
    assert(response.ok, `Workspace recovery returned HTTP ${response.status}`);
    const result = await response.json() as { success: boolean; stderr: string };
    assert(result.success, `Recovered workspace execution failed: ${result.stderr}`);
    return true;
  });
}

try {
  await Promise.all([mkdir(projectBase), mkdir(fixtures)]);
  assert(!(await command(["git", "-C", source, "status", "--porcelain"])).stdout.trim(), "Use a clean committed source checkout; Git clone would omit local changes.");
  assert(await Bun.file(join(source, ".devcontainer/devcontainer.json")).exists(), "The source must include Clanky's real devcontainer.");
  for (const name of (await command(["docker", "volume", "ls", "-q"])).stdout.trim().split(/\s+/).filter(Boolean)) preexistingVolumes.add(name);
  const hostAddress = values["controller-host"] ?? (await command(["docker", "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"])).stdout.trim();
  assert(isIPv4(hostAddress), "Provide --controller-host with a container-reachable IPv4 address on this host.");
  await command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "Acceptance workspace key", "-f", sourceKey]);
  await command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "Acceptance repository host", "-f", hostKey]);
  agent = startManagedProcess(["ssh-agent", "-D", "-a", agentSocket], {
    env: environment, cwd: fixtures,
    stdoutPath: join(app.logsDirectory, "agent.stdout.log"), stderrPath: join(app.logsDirectory, "agent.stderr.log"),
  });
  await until("owned SSH agent socket", async () => {
    try { return (await stat(agentSocket)).isSocket() ? true : undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  });
  await command(["ssh-add", sourceKey], { env: { SSH_AUTH_SOCK: agentSocket } });
  // The read-only SSH server has a different UID on macOS. Create a readable
  // bare remote inside the private fixture directory, never repair source modes.
  const oldUmask = process.umask(0o022);
  const clone = command(["git", "clone", "--bare", "--no-local", source, join(fixtures, "repo.git")]);
  process.umask(oldUmask);
  await clone;
  const sshContext = join(fixtures, "sshd");
  await mkdir(sshContext);
  await writeFile(join(sshContext, "Dockerfile"), `FROM mcr.microsoft.com/devcontainers/base:noble
RUN apt-get update -qq && apt-get install -y --no-install-recommends openssh-server git >/dev/null && passwd -d vscode && mkdir -p /run/sshd && git config --system --add safe.directory /repo.git
COPY sshd_config /etc/ssh/sshd_config
CMD ["/usr/sbin/sshd","-D","-e"]
`);
  await writeFile(join(sshContext, "sshd_config"), `Port 2222
HostKey /fixture/host-key
AuthorizedKeysFile /fixture/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
UsePAM no
AllowUsers vscode
`);
  await copyFile(`${sourceKey}.pub`, join(fixtures, "authorized_keys"));
  await chmod(join(fixtures, "authorized_keys"), 0o644);
  await command(["docker", "build", "--quiet", "-t", sshImage, sshContext]);
  await command(["docker", "run", "-d", "--name", sshName, "--publish", "0.0.0.0::2222",
    "--mount", `type=bind,src=${hostKey},dst=/fixture/host-key,readonly`,
    "--mount", `type=bind,src=${join(fixtures, "authorized_keys")},dst=/fixture/authorized_keys,readonly`,
    "--mount", `type=bind,src=${join(fixtures, "repo.git")},dst=/repo.git,readonly`, sshImage]);
  const port = (await command(["docker", "inspect", "--format", '{{(index (index .NetworkSettings.Ports "2222/tcp") 0).HostPort}}', sshName])).stdout.trim();
  const knownHosts = join(app.homeDirectory, ".ssh", "known_hosts");
  await mkdir(join(app.homeDirectory, ".ssh"), { mode: 0o700 });
  await writeFile(knownHosts, `[${hostAddress}]:${port} ${(await readFile(`${hostKey}.pub`, "utf8")).trim()}\n`);
  const git = Bun.which("git");
  assert(git, "Git is required");
  await writeFile(join(app.providerBinDirectory, "git"), `#!/bin/sh
export GIT_SSH_COMMAND="\${GIT_SSH_COMMAND:-ssh}"${quote(` -o UserKnownHostsFile=${quote(knownHosts)}`)}
exec ${quote(git)} "$@"
`);
  await chmod(join(app.providerBinDirectory, "git"), 0o700);
  await command(["git", "config", "--file", join(app.homeDirectory, ".gitconfig"), "user.name", "Clanky acceptance"]);
  await command(["git", "config", "--file", join(app.homeDirectory, ".gitconfig"), "user.email", "acceptance@example.invalid"]);
  const controllerPort = await findFreeLoopbackPort();
  baseUrl = `https://${hostAddress}:${controllerPort}`;
  const password = `${randomUUID()}-${randomUUID()}`;
  await command([binary, "auth", "setup", "--username", "acceptance", "--password-stdin"], { stdin: `${password}\n` });
  await command([binary, "controller", "tls", "enable", "--endpoint", baseUrl]);
  const exported = await command([binary, "controller", "tls", "export"]);
  const match = exported.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  assert(match, "Controller TLS export did not include its public certificate");
  trustedCertificate = `${match[0]}\n`;
  await writeFile(certificate, trustedCertificate);
  controller = startManagedProcess([binary, "serve"], {
    cwd: root, env: {
      ...environment, CLANKY_HOST: "0.0.0.0", CLANKY_PORT: String(controllerPort), CLANKY_LOG_LEVEL: "warn",
      SSH_AUTH_SOCK: agentSocket, CLANKY_SSH_AGENT_SOURCE_SOCK: agentSocket,
      PATH: `${app.providerBinDirectory}:${environment["PATH"]}`,
    },
    stdoutPath: join(app.logsDirectory, `server-${controllerPort}.stdout.log`),
    stderrPath: join(app.logsDirectory, `server-${controllerPort}.stderr.log`),
  });
  await until("controller managed HTTPS", async () => {
    assert(controller!.child.exitCode === null, "The controller exited before readiness");
    const result = await command(["curl", "--silent", "--show-error", "--fail", "--cacert", certificate, `${baseUrl}/api/health`], { allowFailure: true });
    return result.exitCode === 0 ? true : undefined;
  });
  const login = await fetch(`${baseUrl}/api/auth/password/login`, {
    method: "POST", signal: AbortSignal.timeout(10_000), tls: { ca: trustedCertificate, rejectUnauthorized: true },
    headers: { origin: baseUrl, "content-type": "application/json" }, body: JSON.stringify({ username: "acceptance", password }),
  });
  assert(login.ok, `Private owner login failed with HTTP ${login.status}`);
  cookie = login.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ");
  await login.body?.cancel();
  assert(cookie, "Owner login did not issue a session");
  await api("/api/mesh/endpoint", "POST", { meshEndpoint: baseUrl });
  const hosts = await api<Array<{ ref: { kind: string; nodeId: string } }>>("/api/execution-hosts");
  const host = hosts.find((entry) => entry.ref.kind === "local")?.ref;
  assert(host, "Local execution-host discovery failed");
  const sourceAgent = await api<{ id: string }>("/api/ssh-key-access/sources", "POST", { name: "Acceptance agent", host }, 201);
  const identities = await api<{ identities: Array<{ publicKey: string }> }>(`/api/ssh-key-access/sources/${sourceAgent.id}/identities`);
  assert(identities.identities.length === 1, "The source must expose only the isolated loaded key");
  const key = await api<{ id: string }>(`/api/ssh-key-access/sources/${sourceAgent.id}/keys`, "POST", {
    publicKey: identities.identities[0]!.publicKey, alias: "Acceptance repository key",
  }, 201);
  await pass("Isolated non-root controller, managed TLS, private SSH repository and selected source key");
  observer = (async () => {
    while (!stopObserver) {
      try {
        const found = await containers();
        assert(found.length <= 1, "Provisioning created duplicate physical environments");
        const current = found[0];
        if (current?.State.Running) {
          containerId = current.Id;
          await seedRelease(current);
          return;
        }
      } catch (error) { seedingError = error; return; }
      await Bun.sleep(300);
    }
  })();
  const provisionRequest = {
    name: "Clanky self-hosting", executionHost: host, repoUrl: `ssh://vscode@${hostAddress}:${port}/repo.git`,
    basePath: projectBase, provider: "copilot", adapter: "copilot", mode: "provision",
    devcontainerSubpath: null, targetDirectory: null, workspaceId: null, channel: "stable",
  };
  const admitted = await api<Snapshot>("/api/provisioning-jobs", "POST", { ...provisionRequest, sshKeyIds: [key.id] }, 201);
  await finishJob(admitted.job.config.id);
  assert(seeded, "The external release fixture was not staged before worker startup");
  const workspace = (await api<Workspace[]>("/api/workspaces?sensitive=true")).find((entry) => entry.name === provisionRequest.name);
  assert(workspace, "Provisioning did not publish its workspace");
  workspaceId = workspace.id;
  const originalBinding = JSON.stringify(workspace.executionHostBinding);
  const initialContainer = containerId;
  await workspaceExec(`test -n "$COPILOT_HOME"
mkdir -p "$COPILOT_HOME"
printf preserved > "$COPILOT_HOME/acceptance-profile"
printf preserved > .acceptance-source
copilot --version
mkdir -p /var/lib/clanky/acceptance-dind
printf 'FROM busybox:1.37\\nCMD ["echo","acceptance-dind"]\\n' > /var/lib/clanky/acceptance-dind/Dockerfile
docker build --quiet -t acceptance-dind /var/lib/clanky/acceptance-dind >/dev/null
test "$(docker run --rm acceptance-dind)" = acceptance-dind`, false, 120_000);
  await verifyWorkspace();
  await pass("Public private clone, exact implementation worker, unchanged Clanky hooks, non-root profiles, real SSH and declared DinD");
  const models = await api<Array<{ providerID: string; modelID: string; connected: boolean }>>(`/api/models?workspaceId=${workspaceId}`);
  const model = models.find((entry) => entry.connected);
  assert(model, "The dedicated worker did not expose a connected native model");
  const chat = await api<{ config: { id: string } }>("/api/chats", "POST", {
    name: "Self-hosting conversation", workspaceId, useWorktree: false,
    model: { providerID: model.providerID, modelID: model.modelID, variant: "" },
  }, 201);
  await api(`/api/chats/${chat.config.id}/messages`, "POST", { message: "[plan-first] Prepare the project plan in .clanky-planning/plan.md." });
  await until("native conversation", async () => {
    const value = await api<{ state: { status: string } }>(`/api/chats/${chat.config.id}`);
    assert(value.state.status !== "failed", "The native conversation failed");
    const snapshot = await api<{ transcript: { messages: Array<{ role: string; content: string }> } }>(`/api/chats/${chat.config.id}/snapshot?full=1`);
    return value.state.status === "idle" && snapshot.transcript.messages.some((message) => message.role === "assistant" && message.content.length > 0) ? true : undefined;
  });
  await workspaceExec("test -s .clanky-planning/plan.md");
  await api(`/api/workspaces/${workspaceId}/ssh-key-access/${key.id}`, "PUT", { enabled: false });
  assert(!(await workspaceExec("git ls-remote origin HEAD", true)).success, "A revoked key still authenticated a new SSH connection");
  await api(`/api/workspaces/${workspaceId}/ssh-key-access/${key.id}`, "PUT", { enabled: true });
  await verifyWorkspace();
  await pass("Native conversation writes in the real checkout; live key revocation and reauthorization change actual SSH access");
  async function maintenance(mode: "restart" | "rebuild") {
    const admitted = await api<Snapshot>("/api/provisioning-jobs", "POST", { ...provisionRequest, mode, workspaceId, targetDirectory: checkout }, 201);
    await finishJob(admitted.job.config.id);
    const current = await api<Workspace>(`/api/workspaces/${workspaceId}?sensitive=true`);
    assert(JSON.stringify(current.executionHostBinding) === originalBinding, "Maintenance changed the durable workspace worker binding");
    const found = await containers();
    assert(found.length === 1, "Maintenance did not leave exactly one owned physical environment");
    containerId = found[0]!.Id;
    await verifyWorkspace();
  }
  const initialBinary = (await workspaceExec("stat -c '%i' /var/lib/clanky/bin/clanky")).stdout.trim();
  await maintenance("restart");
  assert(containerId === initialContainer, "Restart unexpectedly replaced the actual container");
  assert((await workspaceExec("stat -c '%i' /var/lib/clanky/bin/clanky")).stdout.trim() !== initialBinary, "Restart did not install a fresh release artifact");
  await pass("Public real restart refreshes the artifact and retains worker identity, private profiles, checkout and SSH");
  await dockerExec("touch /var/lib/clanky/acceptance-release/offline");
  await maintenance("restart");
  const fallback = await api<{ updateWarning: string | null }>(`/api/workspaces/${workspaceId}/environment`);
  assert(typeof fallback.updateWarning === "string" && fallback.updateWarning.length > 0, "Valid-cache startup did not expose its degraded update warning");
  await writeFile(join(reportDirectory, "cached-environment.json"), JSON.stringify(fallback, null, 2));
  await pass("Unavailable release service starts the valid worker with a public cached-update warning");
  await dockerExec("rm /var/lib/clanky/acceptance-release/offline");
  await maintenance("rebuild");
  assert(containerId !== initialContainer, "Rebuild did not replace the physical container");
  await workspaceExec('test "$(docker run --rm acceptance-dind)" = acceptance-dind', false, 60_000);
  await pass("Public replacement rebuild preserves the exact worker, durable binding, private profile, source, SSH and DinD data");
  const config = await api<{ currentUser: { id: string } }>("/api/config");
  async function hostCommand(action: "exec" | "shell", args: string[]) {
    const result = await api<CommandResult & { success: boolean }>(`/api/execution-hosts/local/${host!.nodeId}/exec`, "POST", {
      command: binary, args: ["environment", action, "--directory", checkout, "--owner", config.currentUser.id, "--", ...args],
      cwd: checkout, timeoutMs: 20_000,
    });
    assert(result.success, `Host-side recovery failed: ${result.stderr || result.stdout}`);
    return result;
  }
  await hostCommand("exec", ["sh", "/var/lib/clanky/supervisor.sh", "stop"]);
  const status = await hostCommand("exec", ["sh", "/var/lib/clanky/supervisor.sh", "status"]);
  assert(JSON.parse(status.stdout).running === false, "The dedicated worker was not actually stopped");
  await hostCommand("shell", ["sh", "-lc", 'set -eu; test "$(id -u)" != 0; test -w .; test "$(cat .acceptance-source)" = preserved']);
  await hostCommand("exec", ["sh", "/var/lib/clanky/launcher.sh"]);
  await waitForWorkspace();
  await api(`/api/workspaces/${workspaceId}/environment/stop`, "POST");
  const arise = await api<Snapshot>("/api/provisioning-jobs", "POST", {
    name: "Recover owned environments", executionHost: host, mode: "arise",
    repoUrl: "", basePath: "", provider: "copilot", adapter: "copilot",
    devcontainerSubpath: null, targetDirectory: null, workspaceId: null,
  }, 201);
  await finishJob(arise.job.config.id);
  await waitForWorkspace();
  await verifyWorkspace();
  await pass("Worker-independent non-root shell and public stop/arise restore the managed workspace");
  const validation = await workspaceExec("bun install --frozen-lockfile && bun run build && CLANKY_TEST_MAX_WORKERS=4 bun run test", false, 300_000);
  await writeFile(join(reportDirectory, "in-container-validation.log"), `${validation.stdout}\n${validation.stderr}`);
  await pass("Normal install, build and four-worker sanity suite inside the publicly provisioned workspace");
  complete = true;
} catch (error) {
  await writeFile(join(reportDirectory, "error.txt"), error instanceof Error ? error.stack ?? error.message : String(error));
  if (lastSnapshot) await writeFile(join(reportDirectory, "last-job.json"), JSON.stringify(lastSnapshot, null, 2));
  process.exitCode = 1;
} finally {
  stopObserver = true;
  await observer;
  const cleanupErrors: Error[] = [];
  async function clean(label: string, action: () => Promise<unknown>) {
    try { await action(); }
    catch (error) { cleanupErrors.push(new Error(`Unable to clean ${label}`, { cause: error })); }
  }
  await clean("diagnostics", async () => {
    await cp(app.logsDirectory, join(reportDirectory, "controller-logs"), { recursive: true });
    await writeFile(join(reportDirectory, "controller.log"), await app.diagnostics());
  });
  if (controller) await clean("controller", () => stopManagedProcess(controller!));
  await clean("owned container discovery", async () => { await containers(); });
  const remaining = new Set<string>();
  await clean("container inventory", async () => {
    for (const id of (await command(["docker", "ps", "-aq", "--no-trunc"])).stdout.trim().split(/\s+/).filter(Boolean)) remaining.add(id);
  });
  for (const id of ownedContainers) if (remaining.has(id)) await clean("owned environment", () => command(["docker", "rm", "-f", id]));
  await clean("SSH repository", async () => {
    const found = await command(["docker", "ps", "-aq", "--filter", `name=^/${sshName}$`]);
    if (found.stdout.trim()) await command(["docker", "rm", "-f", sshName]);
  });
  await clean("SSH image", async () => {
    if ((await command(["docker", "image", "ls", "-q", sshImage])).stdout.trim()) await command(["docker", "image", "rm", sshImage]);
  });
  for (const volume of ownedVolumes) await clean("owned private/DinD volume", () => command(["docker", "volume", "rm", volume]));
  if (agent) await clean("SSH agent", () => stopManagedProcess(agent!));
  await clean("owned application directory", () => app.cleanup());
  await writeFile(join(reportDirectory, "results.json"), JSON.stringify({ results, complete, resourcesCleaned: cleanupErrors.length === 0 }, null, 2));
  if (cleanupErrors.length) {
    process.exitCode = 1;
    await writeFile(join(reportDirectory, "cleanup-errors.json"), JSON.stringify(cleanupErrors.map((error) => ({
      message: error.message, cause: error.cause instanceof Error ? error.cause.stack : String(error.cause),
    })), null, 2));
  }
  console.log(`Self-hosting acceptance ${complete && !cleanupErrors.length ? "passed" : "failed"}. Private evidence: ${reportDirectory}`);
}
