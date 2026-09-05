import { resolve } from "node:path";
import { createWebAppCli } from "@pablozaiden/webapp/cli";
import { createRouteCatalog } from "@pablozaiden/webapp/server";
import { routes, getWebAppServer } from "../server";
import { CLANKY_VERSION } from "../version";
import { createMeshCommand, type ClankyCliContext } from "./mesh";
import { parsePreviewCommandArgs, runPreviewCommand } from "./preview";
import { createWorkspaceCommand } from "./workspace";
import { createWorkerCommand } from "./worker";
import { connectWorkerHandoffFromEnvironment } from "../core/mesh-worker-handoff";
import { getDataDir } from "../persistence/database";

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
    routeCatalog: createRouteCatalog(routes),
  };
  return createWebAppCli<ClankyCliContext>({
    appName: "Clanky",
    commandName: "clanky",
    envPrefix: "CLANKY",
    version: CLANKY_VERSION,
    realtimePath: "/api/ws",
    routeCatalog: appContext.routeCatalog,
    update: CLANKY_UPDATER_CONFIG,
    serve: {
      options: [
        {
          name: "mesh-worker",
          type: "boolean",
          description: "Run the restricted Mesh execution worker surface.",
          defaultValue: false,
        },
        {
          name: "worker-directory",
          type: "string",
          description: "Set the worker-owned default execution directory.",
        },
        {
          name: "worker-execution-enabled",
          type: "boolean",
          description: "Allow enrolled controllers to execute on this worker.",
          defaultValue: true,
        },
      ],
      development: {
        build: async ({ sourcePath }) => await buildClankyFromSource(sourcePath),
        command: ({ sourcePath }) => [resolve(sourcePath, "dist", "clanky"), "serve"],
      },
    },
    start: async ({ options }) => {
      const handoff = await connectWorkerHandoffFromEnvironment();
      const server = await getWebAppServer({
        meshWorker: options["mesh-worker"] === true,
        workerDirectory: typeof options["worker-directory"] === "string"
          ? options["worker-directory"]
          : undefined,
        workerExecutionEnabled: options["worker-execution-enabled"] !== false,
      });
      await server.start();
      await handoff?.started(getDataDir());
    },
    appContext,
    commands: {
      mesh: createMeshCommand(),
      preview: {
        description: "Start a local CLI-owned live preview for a workspace service.",
        usage: "preview --workspace ID_OR_NAME --port PORT [options]",
        handler: async (context) => {
          const command = parsePreviewCommandArgs(context.args);
          const exitCode = await runPreviewCommand(command, {
            fetchFn: context.fetchFn,
            now: () => new Date(),
            envPrefix: context.envPrefix,
            environment: context.environment,
            credentials: context.profiles.credentials(context.profile),
            out: (message) => context.stdout.write(`${message}\n`),
            err: (message) => context.stderr.write(`${message}\n`),
          });
          return { exitCode };
        },
      },
      workspace: createWorkspaceCommand(),
      worker: createWorkerCommand(),
    },
  });
}
