import {
  runUpdateCommand as runInstallerUpdateCommand,
  type UpdateCommandOptions,
} from "@pablozaiden/installer";
import type {
  CreateWebAppCliOptions,
  WebAppCliCommandDefinition,
} from "./create-web-app-cli";
import type { CliCommandResult } from "./runtime";
import type { CliOutput } from "./websocket-command";

interface UpdateCommandDependencies<TAppContext> {
  input: CreateWebAppCliOptions<TAppContext>;
  fetchFn: typeof fetch;
  stdout: CliOutput;
  stderr: CliOutput;
}

function parseUpdateArgs(
  args: readonly string[],
): UpdateCommandOptions | CliCommandResult {
  let checkOnly = false;
  let preRelease = false;
  let version: string | undefined;
  let channel: UpdateCommandOptions["channel"];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--check") {
      if (checkOnly) {
        return { exitCode: 1, error: "--check may only be specified once" };
      }
      checkOnly = true;
      continue;
    }
    if (arg === "--pre-release") {
      if (preRelease) {
        return { exitCode: 1, error: "--pre-release may only be specified once" };
      }
      preRelease = true;
      continue;
    }
    if (arg === "--channel" || arg.startsWith("--channel=")) {
      if (channel !== undefined) {
        return { exitCode: 1, error: "--channel may only be specified once" };
      }
      const value = arg === "--channel" ? args[++index] : arg.slice("--channel=".length);
      if (value !== "stable" && value !== "latest") {
        return { exitCode: 1, error: "--channel requires stable or latest" };
      }
      channel = value;
      continue;
    }
    if (arg === "--version") {
      if (version !== undefined) {
        return { exitCode: 1, error: "--version may only be specified once" };
      }
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { exitCode: 1, error: "--version requires a value" };
      }
      version = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--version=")) {
      if (version !== undefined) {
        return { exitCode: 1, error: "--version may only be specified once" };
      }
      const value = arg.slice("--version=".length);
      if (!value) {
        return { exitCode: 1, error: "--version requires a value" };
      }
      version = value;
      continue;
    }
    return { exitCode: 1, error: `Unknown update option: ${arg}` };
  }

  if (checkOnly && version !== undefined) {
    return { exitCode: 1, error: "Cannot combine --check with --version" };
  }
  if (channel && (version !== undefined || preRelease)) {
    return { exitCode: 1, error: "Cannot combine --channel with --version or --pre-release" };
  }
  return { checkOnly, version, preRelease, channel };
}

export function updateCommand<TAppContext>(
  dependencies: UpdateCommandDependencies<TAppContext>,
): WebAppCliCommandDefinition<TAppContext> {
  return {
    description: "Check for or install application binaries, following the installed release channel.",
    usage: "update [--check] [--channel stable|latest | --pre-release | --version VERSION]",
    handler: async ({ args }) => {
      const command = parseUpdateArgs(args);
      if ("exitCode" in command) return command;
      if (!dependencies.input.update) {
        return {
          exitCode: 1,
          error: "Update is not configured for this application",
        };
      }

      const exitCode = await runInstallerUpdateCommand(command, dependencies.input.update, {
        fetchFn: dependencies.fetchFn,
        out: (message) => dependencies.stdout.write(`${message}\n`),
        err: (message) => dependencies.stderr.write(`${message}\n`),
      });
      return { exitCode };
    },
  };
}
