import { describe, expect, test } from "bun:test";
import { parseCliCommand, runCli, runMain } from "../../src/cli/runtime";

function createOutputCapture(): {
  messages: string[];
  out: (message: string) => void;
  err: (message: string) => void;
} {
  const messages: string[] = [];
  return {
    messages,
    out: (message: string) => messages.push(message),
    err: (message: string) => messages.push(message),
  };
}

describe("clanky CLI runtime", () => {
  test("prints help and exits non-zero when no command is provided", async () => {
    const output = createOutputCapture();

    const exitCode = await runCli([], output);

    expect(exitCode).toBe(1);
    expect(output.messages.join("\n")).toContain("Usage:");
    expect(output.messages.join("\n")).toContain("clanky serve");
  });

  test("prints help and exits successfully for help aliases", async () => {
    for (const helpArg of ["help", "--help", "-h"]) {
      const output = createOutputCapture();

      const exitCode = await runCli([helpArg], output);

      expect(exitCode).toBe(0);
      expect(output.messages.join("\n")).toContain("Commands:");
    }
  });

  test("starts the server for the serve command", async () => {
    let started = false;

    const exitCode = await runCli(["serve"], {
      startServerFn: async () => {
        started = true;
      },
    });

    expect(exitCode).toBeUndefined();
    expect(started).toBe(true);
  });

  test("runMain delegates all command handling to the CLI runtime", async () => {
    let forwardedArgs: string[] | undefined;

    const exitCode = await runMain(["serve"], {
      runCliFn: async (args) => {
        forwardedArgs = args;
        return 42;
      },
    });

    expect(exitCode).toBe(42);
    expect(forwardedArgs).toEqual(["serve"]);
  });

  test("parses representative existing subcommands", () => {
    expect(parseCliCommand(["version"])).toEqual({ action: "version" });
    expect(parseCliCommand(["update", "--check"])).toEqual({
      action: "update",
      checkOnly: true,
      version: undefined,
    });
    expect(parseCliCommand(["auth", "http://localhost:3000", "--client-id", "device"])).toEqual({
      action: "auth",
      baseUrl: "http://localhost:3000",
      clientId: "device",
      cookies: undefined,
    });
    expect(parseCliCommand(["status", "http://localhost:3000"])).toEqual({
      action: "status",
      baseUrl: "http://localhost:3000",
    });
    expect(parseCliCommand(["api", "tasks", "--method", "post", "--payload", "{\"name\":\"demo\"}"])).toEqual({
      action: "api",
      endpoint: "/api/tasks",
      method: "POST",
      payload: "{\"name\":\"demo\"}",
    });
    expect(parseCliCommand(["schema", "tasks"])).toEqual({
      action: "schema",
      endpoint: "/api/tasks",
    });
    expect(parseCliCommand(["ws", "http://localhost:3000", "--task-id", "task-1"])).toEqual({
      action: "ws",
      baseUrl: "http://localhost:3000",
      taskId: "task-1",
      chatId: undefined,
      sshSessionId: undefined,
      sshServerSessionId: undefined,
      provisioningJobId: undefined,
    });
  });
});
