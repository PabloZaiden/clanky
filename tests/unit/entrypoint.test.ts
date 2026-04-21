import { describe, expect, test } from "bun:test";
import { parseMainCommand, runMain } from "../../src/entrypoint";

describe("entrypoint", () => {
  test("defaults to server mode when no cli command is present", () => {
    expect(parseMainCommand([])).toEqual({ mode: "server" });
    expect(parseMainCommand(["--help"])).toEqual({ mode: "server" });
  });

  test("dispatches cli subcommands without starting the server", async () => {
    let serverStarted = false;
    let receivedCliArgs: string[] | null = null;

    const exitCode = await runMain(["cli", "status"], {
      startServerFn: async () => {
        serverStarted = true;
      },
      runCliFn: async (args: string[]) => {
        receivedCliArgs = args;
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    expect(serverStarted).toBe(false);
    expect(receivedCliArgs).not.toBeNull();
    expect(receivedCliArgs!).toEqual(["status"]);
  });
});
