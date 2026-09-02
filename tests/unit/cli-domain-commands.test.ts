import { describe, expect, test } from "bun:test";
import { parsePreviewCommandArgs } from "../../src/cli/preview";
import { parseWorkspaceCommandArgs } from "../../src/cli/workspace";

describe("CLI preview command parsing", () => {

  test("rejects invalid ports and accepts host overrides", () => {
    expect(() => parsePreviewCommandArgs([
      "--workspace",
      "app",
      "--port",
      "70000",
    ])).toThrow("--port must be an integer between 1 and 65535");
    expect(parsePreviewCommandArgs([
      "--workspace",
      "app",
      "--port",
      "3000",
      "--remote-host",
      "127.0.0.1",
      "--host",
      "0.0.0.0",
      "--local-port",
      "43123",
      "--open",
    ])).toEqual({
      baseUrl: undefined,
      workspace: "app",
      port: 3000,
      remoteHost: "127.0.0.1",
      host: "0.0.0.0",
      localPort: 43123,
      path: "/",
      open: true,
    });
  });
});

describe("CLI workspace command parsing", () => {

  test("requires a command separator for exec", () => {
    expect(() => parseWorkspaceCommandArgs(["exec", "workspace-id", "printf"]))
      .toThrow("workspace exec requires -- before COMMAND");
  });
});
