import type { WebAppCliCommandDefinition } from "@/platform/cli";
import type { ClankyCliContext } from "./mesh";
import { EnvironmentManager, type EnvironmentOptions } from "../core/environments/manager";
import { listEnvironmentTemplates } from "../core/environments/templates";
import { HARNESS_ADAPTER_IDS, createAgentSettings } from "@/shared/settings";

const help = `Usage: clanky environment COMMAND [options]

Commands: up, status, exec -- COMMAND, shell, stop, restart, rebuild, remove, arise, list, templates

Options:
  --directory PATH           Source checkout (defaults to the current directory)
  --id UUID                  Stable identity for a new or existing environment
  --owner ID                 Local registry namespace (defaults to the OS user)
  --template NAME            Fallback only when the project has no devcontainer
  --devcontainer-subpath PATH Select a project definition
  --gh-user NAME             Explicit GitHub account to share with this workspace
  --release-channel CHANNEL  Explicit worker selection: stable, latest, prerelease
  --runtime-adapter ADAPTER   Explicit managed native runtime selection
  --startup-command COMMAND  Persist a command run as remoteUser at container start
  --no-startup-command       Remove the saved startup command
  --reset-credentials        With remove: also destroy private runtime state

remove never deletes source. Without --reset-credentials, up restores private state.
shell and arise run on the provisioning host and do not need a connected worker.
`;

export async function runEnvironmentCommand(args: readonly string[]): Promise<number> {
  const command = args[0];
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(help);
    return 0;
  }
  const options: EnvironmentOptions = {};
  const values: Record<string, keyof Pick<EnvironmentOptions, "directory" | "id" | "owner" | "template" | "devcontainerSubpath" | "githubUser" | "startupCommand">> = {
    "--directory": "directory", "--id": "id", "--owner": "owner", "--template": "template",
    "--devcontainer-subpath": "devcontainerSubpath", "--gh-user": "githubUser", "--startup-command": "startupCommand",
  };
  let resetCredentials = false;
  let trailing: readonly string[] = [];
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--") { trailing = args.slice(index + 1); break; }
    if (argument === "--no-startup-command") { options.clearStartupCommand = true; continue; }
    if (argument === "--reset-credentials") { resetCredentials = true; continue; }
    if (argument === "--runtime-adapter") {
      const value = args[++index];
      const adapter = HARNESS_ADAPTER_IDS.find((candidate) => candidate === value);
      if (!adapter) throw new Error(`--runtime-adapter must be ${HARNESS_ADAPTER_IDS.join(", ")}.`);
      options.runtime = createAgentSettings(adapter);
      continue;
    }
    if (argument === "--release-channel") {
      const channel = args[++index];
      if (channel !== "stable" && channel !== "latest" && channel !== "prerelease") {
        throw new Error("--release-channel must be stable, latest or prerelease.");
      }
      options.releaseChannel = channel;
      continue;
    }
    const property = values[argument];
    const value = args[++index];
    if (!property || !value || value.startsWith("--")) throw new Error(`Invalid environment option: ${argument}`);
    options[property] = value;
  }
  if (resetCredentials && command !== "remove") throw new Error("--reset-credentials is valid only with environment remove.");
  if (trailing.length && command !== "exec" && command !== "shell") throw new Error("Only exec and shell accept a trailing command.");
  if (command === "templates") { console.log(JSON.stringify(listEnvironmentTemplates())); return 0; }
  const manager = new EnvironmentManager(options);
  const interrupt = () => { void manager.close(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    switch (command) {
      case "up": console.log(JSON.stringify(await manager.up())); return 0;
      case "rebuild": console.log(JSON.stringify(await manager.up(true))); return 0;
      case "restart": await manager.restart(); console.log(JSON.stringify(await manager.status())); return 0;
      case "status": console.log(JSON.stringify(await manager.status())); return 0;
      case "list": console.log(JSON.stringify(await manager.list())); return 0;
      case "arise": console.log(JSON.stringify({ started: await manager.arise() })); return 0;
      case "stop": await manager.stop(); return 0;
      case "remove": await manager.remove(resetCredentials); return 0;
      case "exec": return await manager.exec(trailing, true);
      case "shell": return await manager.exec(trailing.length ? trailing : ["sh", "-l"], true);
      default: throw new Error(`Unknown environment command: ${command}`);
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await manager.close();
  }
}

export function createEnvironmentCommand(): WebAppCliCommandDefinition<ClankyCliContext> {
  return {
    description: "Manage project devcontainers and recover them from their provisioning host.",
    usage: "environment COMMAND [options]",
    handler: async (context) => ({ exitCode: await runEnvironmentCommand(context.args) }),
  };
}
