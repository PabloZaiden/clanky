import { runCli } from "./cli";
import { startServer } from "./server";

export type MainCommand =
  | {
    mode: "server";
  }
  | {
    mode: "cli";
    args: string[];
  };

export function parseMainCommand(args: string[]): MainCommand {
  const [firstArg, ...restArgs] = args;
  if (firstArg === "cli") {
    return {
      mode: "cli",
      args: restArgs,
    };
  }

  return {
    mode: "server",
  };
}

export async function runMain(
  args: string[],
  dependencies: {
    runCliFn?: typeof runCli;
    startServerFn?: typeof startServer;
  } = {},
): Promise<number | undefined> {
  const runCliFn = dependencies.runCliFn ?? runCli;
  const startServerFn = dependencies.startServerFn ?? startServer;
  const command = parseMainCommand(args);

  if (command.mode === "cli") {
    return await runCliFn(command.args);
  }

  await startServerFn();
  return undefined;
}
