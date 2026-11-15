import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { environmentTemplateConfiguration } from "./templates";
import { ENVIRONMENT_CONTAINER_STATE_ROOT, ENVIRONMENT_RUNTIME_ROOT, environmentRuntimeFeature, environmentRuntimeInstall, environmentRuntimeLaunch, environmentRuntimeStart } from "./runtime-feature";
import { getWorkerPathsForSupervisor, shellQuote, type AutomaticWorkerChannel } from "../provisioning/worker-assets";
import { getExistingLauncherChannel, withWorkerLauncherChannel } from "../provisioning/worker-runtime-assets";
import { parseWorkerChannel } from "../worker-channel";
import { scopedSshAgentEnvironment, workspaceSshAgentSocketPath } from "../ssh-agent-environment";

const environmentSchema = z.object({
  id: z.string().uuid(), owner: z.string().min(1), directory: z.string().min(1),
  config: z.string().min(1), override: z.string().min(1), volume: z.string().min(1),
  runtimeDirectory: z.string().optional(), remoteUser: z.string().optional(),
  containerId: z.string().optional(), workdir: z.string().optional(),
  createdAt: z.string(), template: z.string().optional(), githubUser: z.string().optional(),
});
type EnvironmentRecord = z.infer<typeof environmentSchema>;
const upSchema = z.object({
  outcome: z.literal("success"), containerId: z.string().min(1),
  remoteUser: z.string(), remoteWorkspaceFolder: z.string().min(1),
});
const runtimeSchema = z.object({ user: z.string().min(1), home: z.string().min(1), runtime: z.string().min(1) });
const inspectSchema = z.array(z.object({
  Id: z.string(), State: z.object({ Running: z.boolean() }),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  NetworkSettings: z.object({ Ports: z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable()) }),
}));

export interface EnvironmentOptions {
  owner?: string;
  directory?: string;
  id?: string;
  template?: string;
  devcontainerSubpath?: string;
  githubUser?: string;
  startupCommand?: string;
  clearStartupCommand?: boolean;
  releaseChannel?: AutomaticWorkerChannel;
}

export class EnvironmentManager {
  private readonly owner: string;
  private readonly root: string;
  private readonly processes = new Set<Bun.Subprocess>();

  constructor(private readonly options: EnvironmentOptions = {}) {
    this.owner = options.owner ?? `uid:${userInfo().uid}`;
    const namespace = createHash("sha256").update(this.owner).digest("hex").slice(0, 24);
    this.root = join(process.env["CLANKY_DATA_DIR"] ?? join(homedir(), ".clanky"), "environments", namespace);
  }

  async up(rebuild = false): Promise<EnvironmentRecord> {
    let record = await this.find(false);
    if (!record) {
      const directory = await realpath(this.options.directory ?? process.cwd());
      const id = this.options.id ?? randomUUID();
      z.string().uuid().parse(id);
      const folder = join(this.root, id);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      let config: string;
      try {
        config = await this.discoverConfiguration(directory, folder);
      } catch (error) {
        await rm(folder, { recursive: true, force: true });
        throw error;
      }
      record = {
        id, owner: this.owner, directory, config, override: join(folder, ".devcontainer", "devcontainer.json"),
        volume: `clanky-${createHash("sha256").update(`${this.owner}:${id}`).digest("hex").slice(0, 32)}`,
        template: this.options.template, githubUser: this.options.githubUser, createdAt: new Date().toISOString(),
      };
      await this.save(record);
    }
    const previous = (await this.inspectOwned(record))[0];
    if (previous) {
      if (!previous.State.Running) {
        await this.command("docker", ["start", previous.Id]);
        await this.runStartCommands(record);
      }
      await this.syncAssets(record);
      await this.saveStartupCommand(record);
    }
    await this.writeConfiguration(record);
    if (!record.runtimeDirectory || !previous || rebuild) {
      const built = z.object({ imageName: z.array(z.string()).min(1) }).parse(
        await this.jsonCommand("devcontainer", ["build", ...this.configArgs(record)]),
      );
      const inspection = await this.command("docker", [
        "create", "--label", `clanky.environment-inspection=${this.labelValue(record)}`, "--entrypoint", "/bin/true", built.imageName[0]!,
      ]);
      const containerId = inspection.trim();
      const marker = join(dirname(record.override), "runtime-image.json");
      try {
        await this.command("docker", ["cp", `${containerId}:/usr/local/share/clanky-environment/runtime.json`, marker]);
        const runtime = runtimeSchema.parse(JSON.parse(await readFile(marker, "utf8")));
        record.runtimeDirectory = runtime.runtime;
        record.remoteUser = runtime.user;
        await this.save(record);
      } finally {
        await this.command("docker", ["rm", containerId]);
        await rm(marker, { force: true });
      }
      await this.writeConfiguration(record);
    }
    await this.ensureVolume(record);
    const result = upSchema.parse(await this.jsonCommand("devcontainer", [
      "up", ...this.configArgs(record), "--id-label", this.label(record),
      ...(rebuild ? ["--remove-existing-container"] : []),
    ]));
    record.containerId = result.containerId;
    record.remoteUser = result.remoteUser;
    record.workdir = result.remoteWorkspaceFolder;
    await this.save(record);
    const configured = await this.saveRemoteEnvironment(record);
    await this.syncAssets(record);
    await this.configureIdentity(record);
    await this.saveStartupCommand(record);
    if (!configured || this.options.startupCommand !== undefined) {
      await this.launchStartupCommand(record);
    }
    return record;
  }

  async status() {
    const record = await this.requireRecord();
    const containers = await this.inspectOwned(record);
    const container = containers[0];
    const updateWarning = container?.State.Running
      ? (await this.execIn(record, ["sh", "-c", 'if [ -f /var/lib/clanky/update-warning ]; then cat /var/lib/clanky/update-warning; fi'])).trim() || null
      : null;
    return {
      id: record.id, directory: record.directory, containerId: container?.Id ?? null,
      running: container?.State.Running ?? false, workdir: record.workdir ?? "",
      remoteUser: record.remoteUser ?? null, runtimeDirectory: ENVIRONMENT_RUNTIME_ROOT,
      hostRuntimeDirectory: join(dirname(record.override), "assets"),
      updateWarning,
      ports: Object.keys(container?.NetworkSettings.Ports ?? {}).map((key) => Number(key.split("/")[0])),
      publishedPorts: Object.fromEntries(Object.entries(container?.NetworkSettings.Ports ?? {}).map(([key, entries]) =>
        [key, (entries ?? []).map((entry) => ({ hostIp: entry.HostIp || null, hostPort: Number(entry.HostPort) || null }))])),
    };
  }

  async exec(args: readonly string[], interactive = false): Promise<number> {
    const record = await this.requireRecord();
    await this.assertOwned(record);
    if (!args.length) throw new Error("environment exec requires a command after --.");
    const socketDirectory = (await this.execIn(record, ["sh", "-c", 'printf "%s" "${CLANKY_SSH_AGENT_SOCKET_DIR-}"'])).trim();
    const paths = getWorkerPathsForSupervisor(`${ENVIRONMENT_RUNTIME_ROOT}/supervisor.sh`);
    const environment = scopedSshAgentEnvironment(workspaceSshAgentSocketPath(paths.containerData, socketDirectory || undefined));
    const remoteEnvironment = Object.entries(environment).flatMap(([name, value]) => ["--remote-env", `${name}=${value}`]);
    const child = Bun.spawn(["devcontainer", "exec", ...this.execArgs(record), ...remoteEnvironment, "sh", "-c",
      'if [ -f /var/lib/clanky/github-token ]; then GH_TOKEN=$(cat /var/lib/clanky/github-token); export GH_TOKEN; fi; exec "$@"',
      "clanky-environment", ...args], { stdin: interactive ? "inherit" : "ignore", stdout: "inherit", stderr: "inherit" });
    this.processes.add(child);
    try { return await child.exited; }
    finally { this.processes.delete(child); }
  }

  async stop(): Promise<void> {
    const record = await this.requireRecord();
    const container = (await this.inspectOwned(record))[0];
    if (container?.State.Running) await this.command("docker", ["stop", container.Id]);
  }

  async restart(): Promise<void> {
    const record = await this.requireRecord();
    const previous = (await this.inspectOwned(record))[0];
    if (!previous) { await this.up(); return; }
    if (!previous.State.Running) {
      await this.command("docker", ["start", previous.Id]);
      await this.runStartCommands(record);
    }
    await this.syncAssets(record);
    await this.saveRemoteEnvironment(record);
    await this.saveStartupCommand(record);
    await this.command("docker", ["restart", record.containerId!]);
    await this.runStartCommands(record);
  }

  async remove(resetCredentials: boolean): Promise<void> {
    const record = await this.requireRecord();
    const container = (await this.inspectOwned(record))[0];
    if (container) await this.command("docker", ["rm", "--force", container.Id]);
    record.containerId = undefined;
    await this.save(record);
    if (resetCredentials) {
      const exists = (await this.command("docker", ["volume", "ls", "--filter", `name=^${record.volume}$`, "--format", "{{.Name}}"])).trim();
      if (exists) {
        const volume = await this.jsonCommand("docker", ["volume", "inspect", record.volume]);
        const parsed = z.array(z.object({ Labels: z.record(z.string(), z.string()).nullable() })).parse(volume);
        if (parsed[0]?.Labels?.["clanky.environment"] !== this.labelValue(record)) {
          throw new Error("Refusing to remove a volume without this environment's ownership label.");
        }
        await this.command("docker", ["volume", "rm", record.volume]);
      }
      await rm(join(dirname(record.override), "assets"), { recursive: true, force: true });
      record.runtimeDirectory = undefined;
      record.remoteUser = undefined;
      await this.save(record);
    }
  }

  async arise(): Promise<string[]> {
    const records = await this.records();
    const started: string[] = [];
    for (const record of records) {
      const container = (await this.inspectOwned(record))[0];
      if (container && !container.State.Running) {
        await this.command("docker", ["start", container.Id]);
        await this.runStartCommands(record);
        started.push(record.id);
      }
    }
    return started;
  }

  async list() { return await this.records(); }

  async close(): Promise<void> {
    for (const child of this.processes) child.kill("SIGTERM");
    await Promise.all([...this.processes].map((child) => child.exited));
    this.processes.clear();
  }

  private labelValue(record: EnvironmentRecord): string {
    return `${createHash("sha256").update(this.owner).digest("hex").slice(0, 24)}:${record.id}`;
  }
  private label(record: EnvironmentRecord): string { return `clanky.environment=${this.labelValue(record)}`; }
  private configArgs(record: EnvironmentRecord): string[] {
    return ["--workspace-folder", dirname(dirname(record.override)), "--config", record.override];
  }
  private execArgs(record: EnvironmentRecord): string[] {
    return [...this.configArgs(record), "--id-label", this.label(record)];
  }

  private async discoverConfiguration(directory: string, folder: string): Promise<string> {
    const base = this.options.devcontainerSubpath ? resolve(directory, this.options.devcontainerSubpath) : directory;
    for (const candidate of [join(base, ".devcontainer", "devcontainer.json"), join(base, ".devcontainer.json"), join(base, "devcontainer.json")]) {
      if (await this.exists(candidate)) return candidate;
    }
    if (await this.exists(join(base, ".devcontainer"))) {
      const candidates = (await readdir(join(base, ".devcontainer"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory());
      const definitions: string[] = [];
      for (const entry of candidates) {
        const candidate = join(base, ".devcontainer", entry.name, "devcontainer.json");
        if (await this.exists(candidate)) definitions.push(candidate);
      }
      if (definitions.length > 0) throw new Error("Select the project's devcontainer definition with --devcontainer-subpath.");
    }
    if (!this.options.template) throw new Error("No devcontainer definition found. Select a language with --template.");
    const config = join(folder, "template", "devcontainer.json");
    await mkdir(dirname(config), { recursive: true, mode: 0o700 });
    await writeFile(config, JSON.stringify(environmentTemplateConfiguration(this.options.template)), { mode: 0o600 });
    return config;
  }

  private async writeConfiguration(record: EnvironmentRecord): Promise<void> {
    const parsed = z.object({
      configuration: z.record(z.string(), z.unknown()),
      workspace: z.object({ workspaceFolder: z.string(), workspaceMount: z.string() }),
    }).parse(
      await this.jsonCommand("devcontainer", ["read-configuration", "--workspace-folder", record.directory, "--config", record.config]),
    );
    const { configFilePath: _path, ...configuration } = parsed.configuration;
    if ("dockerComposeFile" in configuration) throw new Error("Clanky-managed environments currently require an image or Dockerfile devcontainer; Docker Compose definitions are not rewritten.");
    const featureFolder = join(dirname(record.override), "feature");
    await mkdir(featureFolder, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(featureFolder, "devcontainer-feature.json"), JSON.stringify(environmentRuntimeFeature), { mode: 0o600 }),
      writeFile(join(featureFolder, "install.sh"), environmentRuntimeInstall, { mode: 0o700 }),
      writeFile(join(featureFolder, "start.sh"), environmentRuntimeStart, { mode: 0o700 }),
      writeFile(join(featureFolder, "launch.cjs"), environmentRuntimeLaunch, { mode: 0o600 }),
    ]);
    const sourceFolder = dirname(record.config);
    const absolute = (value: string) => isAbsolute(value) ? value : resolve(sourceFolder, value);
    const features: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(z.record(z.string(), z.unknown()).parse(configuration["features"] ?? {}))) {
      if (name.startsWith(".")) {
        const key = createHash("sha256").update(absolute(name)).digest("hex").slice(0, 24);
        const target = join(dirname(record.override), "project-features", key);
        await rm(target, { recursive: true, force: true });
        await cp(absolute(name), target, { recursive: true });
        features[`./project-features/${key}`] = value;
      } else {
        features[name] = value;
      }
    }
    if (configuration["build"]) {
      const build = z.record(z.string(), z.unknown()).parse(configuration["build"]);
      configuration["build"] = {
        ...build,
        ...(typeof build["dockerfile"] === "string" ? { dockerfile: absolute(build["dockerfile"]) } : {}),
        context: absolute(z.string().parse(build["context"] ?? ".")),
      };
    } else if (typeof configuration["dockerFile"] === "string") {
      configuration["dockerFile"] = absolute(configuration["dockerFile"]);
      configuration["context"] = absolute(z.string().parse(configuration["context"] ?? "."));
    }
    let featurePath = relative(dirname(record.override), featureFolder);
    if (!featurePath.startsWith(".")) featurePath = `./${featurePath}`;
    const mounts = z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).parse(configuration["mounts"] ?? []);
    const derived = {
      ...configuration, features: { ...features, [featurePath]: {} },
      workspaceFolder: configuration["workspaceFolder"] ?? parsed.workspace.workspaceFolder,
      workspaceMount: configuration["workspaceMount"] ?? parsed.workspace.workspaceMount,
      ...(configuration["initializeCommand"] !== undefined
        ? { initializeCommand: this.initializeCommand(configuration["initializeCommand"], record.directory) } : {}),
      ...(record.runtimeDirectory ? { mounts: [...mounts, { type: "volume", source: record.volume, target: record.runtimeDirectory }] } : {}),
    };
    await writeFile(record.override, JSON.stringify(derived), { mode: 0o600 });
    const lockfile = join(sourceFolder, "devcontainer-lock.json");
    if (await this.exists(lockfile)) await copyFile(lockfile, join(dirname(record.override), "devcontainer-lock.json"));
    await mkdir(join(dirname(record.override), "assets"), { recursive: true, mode: 0o700 });
  }

  private async ensureVolume(record: EnvironmentRecord): Promise<void> {
    const names = await this.command("docker", ["volume", "ls", "--filter", `name=^${record.volume}$`, "--format", "{{.Name}}"]);
    if (names.trim()) {
      const volumes = z.array(z.object({ Labels: z.record(z.string(), z.string()).nullable() })).parse(
        await this.jsonCommand("docker", ["volume", "inspect", record.volume]),
      );
      if (volumes[0]?.Labels?.["clanky.environment"] !== this.labelValue(record)) throw new Error("The runtime volume exists but belongs to a different environment.");
    } else {
      await this.command("docker", ["volume", "create", "--label", this.label(record), record.volume]);
    }
  }

  private async syncAssets(record: EnvironmentRecord): Promise<void> {
    const assets = join(dirname(record.override), "assets");
    const channelPath = join(assets, "update-channel");
    const launcherPath = join(assets, "launcher.sh");
    for (const entry of await readdir(assets, { withFileTypes: true })) {
      if (!entry.isFile()) throw new Error("Environment runtime staging must contain regular files only.");
    }
    if (await this.exists(channelPath) || await this.exists(launcherPath)) {
      const current = z.object({ channel: z.string().nullable(), launcher: z.string().nullable() }).parse(
        JSON.parse(await this.execIn(record, ["node", "-e", `
const fs = require("node:fs");
const read = name => fs.existsSync("/var/lib/clanky/" + name) ? fs.readFileSync("/var/lib/clanky/" + name, "utf8") : null;
process.stdout.write(JSON.stringify({channel:read("update-channel"),launcher:read("launcher.sh")}));
`])),
      );
      const channel = this.options.releaseChannel
        ?? (current.channel === null ? undefined : parseWorkerChannel(current.channel))
        ?? getExistingLauncherChannel(current.launcher)
        ?? (await this.exists(channelPath) ? parseWorkerChannel(await readFile(channelPath, "utf8")) : undefined)
        ?? getExistingLauncherChannel(await this.exists(launcherPath) ? await readFile(launcherPath, "utf8") : undefined);
      if (!channel) throw new Error("Cannot determine the selected workspace worker channel.");
      if (channel === "prerelease") {
        await this.execIn(record, ["rm", "-f", `${ENVIRONMENT_RUNTIME_ROOT}/update-channel`]);
        await rm(channelPath, { force: true });
      } else {
        await writeFile(channelPath, `${channel}\n`, { mode: 0o600 });
      }
      if (await this.exists(launcherPath)) {
        const launcher = withWorkerLauncherChannel(await readFile(launcherPath, "utf8"), channel);
        await writeFile(launcherPath, launcher, { mode: 0o700 });
      }
    }
    for (const entry of await readdir(assets, { withFileTypes: true })) {
      await this.copyToRuntime(record, join(assets, entry.name), entry.name);
    }
  }

  private async saveRemoteEnvironment(record: EnvironmentRecord): Promise<boolean> {
    const parsed = z.object({
      mergedConfiguration: z.object({ remoteEnv: z.record(z.string(), z.string().nullable()).optional() }),
    }).parse(await this.jsonCommand("devcontainer", [
      "read-configuration", ...this.execArgs(record), "--include-merged-configuration",
    ]));
    const names = Object.keys(parsed.mergedConfiguration.remoteEnv ?? {});
    const result = z.object({
      configured: z.boolean(), environment: z.record(z.string(), z.string().nullable()),
    }).parse(JSON.parse(
      await this.execIn(record, ["node", "-e", `
process.stdout.write(JSON.stringify({
  configured: require("node:fs").existsSync("${ENVIRONMENT_CONTAINER_STATE_ROOT}/remote-env.json"),
  environment: Object.fromEntries(${JSON.stringify(names)}.map(name => [name, process.env[name] ?? null])),
}));
`]),
    ));
    const source = join(dirname(record.override), "remote-env.json");
    if (!result.configured) await this.waitForStartup(record, true);
    try {
      await writeFile(source, JSON.stringify(result.environment), { mode: 0o600 });
      await this.copyToRuntime(record, source, "remote-env.json", ENVIRONMENT_CONTAINER_STATE_ROOT);
    } finally { await rm(source, { force: true }); }
    return result.configured;
  }

  private async runStartCommands(record: EnvironmentRecord): Promise<void> {
    await this.command("devcontainer", ["run-user-commands", ...this.execArgs(record), "--skip-post-attach"]);
    const configured = await this.saveRemoteEnvironment(record);
    if (!configured) await this.launchStartupCommand(record);
    else await this.waitForStartup(record);
  }

  private async launchStartupCommand(record: EnvironmentRecord): Promise<void> {
    await this.execIn(record, ["sh", "-c", ". /usr/local/share/clanky-environment/start.sh"]);
    await this.waitForStartup(record);
  }

  private async saveStartupCommand(record: EnvironmentRecord): Promise<void> {
    if (this.options.clearStartupCommand) {
      await this.execIn(record, ["rm", "-f", `${ENVIRONMENT_RUNTIME_ROOT}/startup-command`]);
    } else if (this.options.startupCommand !== undefined) {
      const source = join(dirname(record.override), "startup-command");
      await writeFile(source, this.options.startupCommand, { mode: 0o600 });
      try { await this.copyToRuntime(record, source, "startup-command"); }
      finally { await rm(source, { force: true }); }
    }
  }

  private async waitForStartup(record: EnvironmentRecord, allowUnconfigured = false): Promise<void> {
    const deadline = Date.now() + 15 * 60_000;
    let observed = "starting";
    while (Date.now() < deadline) {
      const output = await this.command("docker", ["exec", "--user", record.remoteUser!, record.containerId!, "sh", "-c", `
${allowUnconfigured ? "" : "if [ ! -f /var/lib/clanky/startup-command ]; then printf success; exit 0; fi"}
process=$(cat /proc/1/stat); process=\${process##*) }; set -- $process; shift 19; boot=$1
if [ -f /var/lib/clanky/startup-state ]; then
    state=$(cat /var/lib/clanky/startup-state)
    case "$state" in "$boot:success") printf success;; "$boot:failed") printf failed;; "$boot:unconfigured") printf unconfigured;; *) printf starting;; esac
else printf starting
fi`]);
      observed = output.trim();
      if (observed === "success" || (allowUnconfigured && observed === "unconfigured")) return;
      if (observed === "failed") throw new Error("The environment started, but Clanky worker startup failed. Inspect /var/lib/clanky/startup.log using environment shell.");
      await Bun.sleep(250);
    }
    throw new Error(`Environment worker startup was not confirmed (${observed}); the container operation was not replayed.`);
  }

  private async copyToRuntime(record: EnvironmentRecord, source: string, name: string, directory = ENVIRONMENT_RUNTIME_ROOT): Promise<void> {
    await this.run("docker", ["exec", "-i", "--user", record.remoteUser!, record.containerId!, "sh", "-c",
      `umask 077; cat > ${shellQuote(`${directory}/${name}.pending`)} && mv ${shellQuote(`${directory}/${name}.pending`)} ${shellQuote(`${directory}/${name}`)}`],
    true, Bun.file(source).stream());
  }

  private async configureIdentity(record: EnvironmentRecord): Promise<void> {
    for (const field of ["user.name", "user.email"]) {
      const result = await this.run("git", ["config", "--global", "--get", field], false);
      if (result.code === 1) continue;
      if (result.code !== 0) throw new Error(`Cannot read host Git ${field}: ${result.stderr}`);
      if (result.stdout.trim()) await this.execIn(record, ["sh", "-c", 'cd "$HOME" && git config --global "$1" "$2"', "clanky-git-identity", field, result.stdout.trim()]);
    }
    for (const source of [join(homedir(), ".ssh", "known_hosts"), "/etc/ssh/ssh_known_hosts"]) {
      if (!await this.exists(source)) continue;
      await this.copyToRuntime(record, source, "host-known-hosts");
      await this.execIn(record, ["node", "-e", `
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const directory = path.join(os.homedir(), ".ssh"), target = path.join(directory, "known_hosts");
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
const entries = new Set(current.split(/\\r?\\n/));
const additions = fs.readFileSync("/var/lib/clanky/host-known-hosts", "utf8").split(/\\r?\\n/)
  .filter(line => line && !entries.has(line) && entries.add(line));
if (additions.length) fs.appendFileSync(target,
  (current && !current.endsWith("\\n") ? "\\n" : "") + additions.join("\\n") + "\\n", { mode: 0o600 });
`]);
    }
    const account = this.options.githubUser ?? record.githubUser;
    if (account) {
      const token = (await this.command("gh", ["auth", "token", "--user", account])).trim();
      if (!token) throw new Error("The selected GitHub account did not provide a token.");
      const source = join(dirname(record.override), "github-token");
      try {
        await writeFile(source, token, { mode: 0o600 });
        await this.copyToRuntime(record, source, "github-token");
      } finally { await rm(source, { force: true }); }
    }
  }

  private async execIn(record: EnvironmentRecord, args: string[]): Promise<string> {
    return await this.command("devcontainer", ["exec", ...this.execArgs(record), ...args]);
  }
  private async inspectOwned(record: EnvironmentRecord) {
    const ids = (await this.command("docker", ["ps", "--all", "--filter", `label=${this.label(record)}`, "--format", "{{.ID}}"])).trim().split(/\s+/).filter(Boolean);
    if (ids.length > 1) throw new Error("Multiple containers carry this environment identity; resolve ownership before continuing.");
    if (!ids.length) return [];
    const containers = inspectSchema.parse(await this.jsonCommand("docker", ["inspect", ids[0]!]));
    if (containers[0]?.Config.Labels?.["clanky.environment"] !== this.labelValue(record)) throw new Error("Environment container ownership could not be verified.");
    record.containerId = containers[0]!.Id;
    return containers;
  }
  private initializeCommand(command: unknown, directory: string): unknown {
    if (typeof command === "string") return `cd ${shellQuote(directory)} && ${command}`;
    if (Array.isArray(command)) {
      const args = z.array(z.string()).parse(command);
      return ["sh", "-c", 'cd "$1" && shift && exec "$@"', "clanky-initialize", directory, ...args];
    }
    return Object.fromEntries(Object.entries(z.record(z.string(), z.unknown()).parse(command))
      .map(([key, value]) => [key, this.initializeCommand(value, directory)]));
  }
  private async assertOwned(record: EnvironmentRecord): Promise<void> {
    if (!(await this.inspectOwned(record))[0]) throw new Error("The environment container is missing; use environment up to recreate it.");
  }
  private async records(): Promise<EnvironmentRecord[]> {
    if (!await this.exists(this.root)) return [];
    const records: EnvironmentRecord[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metadata = join(this.root, entry.name, "environment.json");
      if (!await this.exists(metadata)) {
        process.stderr.write("Ignoring incomplete environment staging without a saved environment.\n");
        continue;
      }
      const record = environmentSchema.parse(JSON.parse(await readFile(metadata, "utf8")));
      if (record.owner !== this.owner || record.id !== entry.name) throw new Error("Invalid environment registry ownership.");
      records.push(record);
    }
    return records;
  }
  private async find(required = true): Promise<EnvironmentRecord | undefined> {
    const directory = await realpath(this.options.directory ?? process.cwd());
    const matches = (await this.records()).filter((record) => this.options.id ? record.id === this.options.id : record.directory === directory);
    if (matches.length > 1) throw new Error("Several environments use this directory; select an --id.");
    if (required && !matches[0]) throw new Error("No Clanky-managed environment exists for this directory.");
    return matches[0];
  }
  private async requireRecord(): Promise<EnvironmentRecord> {
    const record = await this.find();
    if (!record) throw new Error("Environment not found.");
    return record;
  }
  private async save(record: EnvironmentRecord): Promise<void> {
    const folder = join(this.root, record.id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    const target = join(folder, "environment.json");
    const staged = `${target}.pending`;
    await writeFile(staged, JSON.stringify(environmentSchema.parse(record)), { mode: 0o600 });
    await rename(staged, target);
  }
  private async exists(path: string): Promise<boolean> {
    try { await stat(path); return true; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
  }
  private async jsonCommand(command: string, args: string[]): Promise<unknown> {
    return JSON.parse((await this.command(command, args)).trim());
  }
  private async command(command: string, args: string[]): Promise<string> {
    const result = await this.run(command, args);
    return result.stdout;
  }
  private async run(command: string, args: string[], fail = true, input?: ReadableStream<Uint8Array>) {
    const child = Bun.spawn([command, ...args], { stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe" });
    this.processes.add(child);
    try {
      let stderr = "";
      const consumeError = async () => {
        const decoder = new TextDecoder();
        for await (const chunk of child.stderr) {
          const text = decoder.decode(chunk, { stream: true });
          stderr = (stderr + text).slice(-20_000);
          if (fail) process.stderr.write(text);
        }
      };
      const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), consumeError(), child.exited]);
      if (fail && code !== 0) throw new Error(`${command} failed (${code}): ${stderr || stdout}`);
      return { stdout, stderr, code };
    } finally { this.processes.delete(child); }
  }
}
