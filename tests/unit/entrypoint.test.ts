import { describe, expect, test } from "bun:test";
import { parseMainCommand, runMain } from "../../src/entrypoint";

describe("entrypoint", () => {
  test("requires an explicit command instead of defaulting to server mode", () => {
    expect(parseMainCommand([])).toEqual({ action: "help", exitCode: 1 });
    expect(parseMainCommand(["--help"])).toEqual({ action: "help", exitCode: 0 });
  });

  test("starts the server only for the explicit web command", async () => {
    let serverStarted = false;

    const exitCode = await runMain(["web"], {
      startServerFn: async () => {
        serverStarted = true;
      },
    });

    expect(exitCode).toBeUndefined();
    expect(serverStarted).toBe(true);
  });

  test("dispatches non-web commands through the CLI runtime", async () => {
    let serverStarted = false;
    let receivedCliArgs: string[] | null = null;

    const exitCode = await runMain(["status"], {
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

  test("docker starts the explicit web command", async () => {
    const dockerfile = await Bun.file(new URL("../../Dockerfile", import.meta.url)).text();
    expect(dockerfile).toContain('CMD ["/app/ralpher", "web"]');
  });
});
