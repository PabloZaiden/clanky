import { resolve } from "node:path";
import { createWebAppCli } from "@pablozaiden/webapp/cli";
import { createRouteCatalog } from "@pablozaiden/webapp/server";
import { routes, getWebAppServer } from "../server";
import { CLANKY_VERSION } from "../version";
import { createMeshCommand, type ClankyCliContext } from "./mesh";
import { parsePreviewCommandArgs, runPreviewCommand } from "./preview";

const CLANKY_UPDATER_CONFIG = {
  repository: "pablozaiden/clanky",
  binaryName: "clanky",
  currentVersion: CLANKY_VERSION,
  productName: "Clanky CLI",
  checksum: { required: true },
  companionBinaries: [
    {
      binaryName: "clanky",
      assetPrefix: "clanky",
      required: false,
    },
  ],
};

async function buildClankyFromSource(sourcePath: string): Promise<void> {
  const bunExecutable = Bun.which("bun") ?? process.execPath;
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
      development: {
        build: async ({ sourcePath }) => await buildClankyFromSource(sourcePath),
        command: ({ sourcePath }) => [resolve(sourcePath, "dist", "clanky"), "serve"],
      },
    },
    start: async () => {
      await (await getWebAppServer()).start();
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
    },
  });
}
