import { resolve } from "node:path";
import { createClankyCommandRuntime, createDeviceAuthCliCommand } from "@/platform/cli";
import { createRouteCatalog } from "@/platform/server";
import { CLANKY_VERSION } from "../version";
import { createMeshCommand, type ClankyCliContext } from "./mesh";
import { parsePreviewCommandArgs, runPreviewCommand } from "./preview";
import { createWorkspaceCommand } from "./workspace";
import { createServerCommand } from "./server";
import { createWorkerCommand } from "./worker";
import { createControllerCommand } from "./controller";
import { createAuthCommand } from "./auth-setup";
import { CLANKY_SERVE_OPTIONS } from "./serve-options";
import { createRelayCommand } from "./relay";
import { parseCodeCommandArgs } from "./code";
import type { WebAppCliCommandContext } from "@/platform/cli";
import type { PreviewCommandOptions } from "./preview";
import { readConfiguredWorkerChannel } from "./worker-channel";

const CLANKY_UPDATER_CONFIG = {
  repository: "pablozaiden/clanky",
  binaryName: "clanky",
  currentVersion: CLANKY_VERSION,
  productName: "Clanky CLI",
  checksum: { required: true },
};

async function buildClankyFromSource(sourcePath: string): Promise<void> {
  const bunExecutable = Bun.which("bun");
  if (!bunExecutable) {
    throw new Error("serve up --dev requires the Bun executable to be available as `bun` on PATH");
  }
  const build = Bun.spawn([bunExecutable, "run", "build"], {
    cwd: sourcePath,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await build.exited;
  if (exitCode !== 0) {
    throw new Error(`Clanky development build failed with exit code ${String(exitCode)}`);
  }
}

export function createClankyCli() {
  const appContext: ClankyCliContext = {
    routeCatalog: async () => createRouteCatalog((await import("../server")).routes),
  };
  const environment = { ...process.env };
  delete environment["CLANKY_MESH_WORKER"];
  const previewHandler = (parse: (args: readonly string[]) => PreviewCommandOptions) =>
    async (context: WebAppCliCommandContext<ClankyCliContext>) => ({
      exitCode: await runPreviewCommand(parse(context.args), {
        fetchFn: context.fetchFn,
        now: () => new Date(),
        envPrefix: context.envPrefix,
        environment: context.environment,
        credentials: context.profiles.credentials(context.profile),
        out: (message) => context.stdout.write(`${message}\n`),
        err: (message) => context.stderr.write(`${message}\n`),
      }),
    });
  return createClankyCommandRuntime<ClankyCliContext>({
    appName: "Clanky",
    commandName: "clanky",
    envPrefix: "CLANKY",
    environment,
    version: CLANKY_VERSION,
    realtimePath: "/api/ws",
    routeCatalog: appContext.routeCatalog,
    update: { ...CLANKY_UPDATER_CONFIG, channel: readConfiguredWorkerChannel(environment) },
    serve: {
      options: CLANKY_SERVE_OPTIONS,
      development: {
        build: async ({ sourcePath }) => await buildClankyFromSource(sourcePath),
        command: ({ sourcePath }) => [resolve(sourcePath, "dist", "clanky"), "serve"],
      },
    },
    start: async ({ options }) => {
      const { getWebAppServer } = await import("../server");
      const server = await getWebAppServer({
        apiOnly: options["api-only"] === true,
        meshWorker: options["mesh-worker"] === true,
        relayOnly: options["relay-only"] === true,
        workerDirectory: typeof options["worker-directory"] === "string"
          ? options["worker-directory"]
          : undefined,
        workerExecutionEnabled: options["worker-execution-enabled"] !== false,
        managedTls: options["managed-tls"] === true,
      });
      await server.start();
    },
    appContext,
    commands: {
      auth: {
        ...createAuthCommand(createDeviceAuthCliCommand<ClankyCliContext>({
          commandName: "clanky", envPrefix: "CLANKY",
        })),
        override: true,
      },
      mesh: createMeshCommand(),
      code: {
        description: "Open an existing workspace, chat, or task directory in a VS Code web preview.",
        usage: "code WORKSPACE [--chat NAME_OR_ID | --task NAME_OR_ID] [--open]",
        handler: previewHandler(parseCodeCommandArgs),
      },
      preview: {
        description: "Start a local CLI-owned live preview for a workspace or server service.",
        usage: "preview (--workspace ID_OR_NAME | --server NAME_OR_ID) --port PORT [--local-port PORT] [--https [--tls-cert FILE --tls-key FILE]] [options]",
        handler: previewHandler(parsePreviewCommandArgs),
      },
      workspace: createWorkspaceCommand(),
      server: createServerCommand(),
      worker: createWorkerCommand(),
      controller: createControllerCommand(),
      relay: createRelayCommand(),
    },
  });
}
