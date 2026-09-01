import { describe, expect, test } from "bun:test";
import {
  buildMeshRequest,
  parseMeshCommandArgs,
} from "../../src/cli/mesh";
import { parsePreviewCommandArgs } from "../../src/cli/preview";
import { parseWorkspaceCommandArgs } from "../../src/cli/workspace";

describe("CLI preview command parsing", () => {
  test("requires workspace and port", () => {
    expect(() => parsePreviewCommandArgs(["--workspace", "app"])).toThrow(
      "Missing required option: --port",
    );
    expect(() => parsePreviewCommandArgs(["--port", "3000"])).toThrow(
      "Missing required option: --workspace",
    );
  });

  test("parses defaults and normalizes path", () => {
    expect(parsePreviewCommandArgs([
      "--workspace",
      "app",
      "--port",
      "3000",
      "--path",
      "dashboard",
    ])).toEqual({
      baseUrl: undefined,
      workspace: "app",
      port: 3000,
      remoteHost: "localhost",
      host: "localhost",
      localPort: undefined,
      path: "/dashboard",
      open: false,
    });
  });

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
  test("parses exec options and preserves command arguments after --", () => {
    expect(parseWorkspaceCommandArgs([
      "exec",
      "workspace-name",
      "--cwd",
      "/tmp",
      "--timeout",
      "5000",
      "--",
      "printf",
      "%s",
      "--value",
    ])).toEqual({
      operation: "exec",
      workspace: "workspace-name",
      cwd: "/tmp",
      timeoutMs: 5000,
      command: "printf",
      args: ["%s", "--value"],
    });
  });

  test("parses download output and force options", () => {
    expect(parseWorkspaceCommandArgs([
      "download",
      "workspace-id",
      "/tmp/report.bin",
      "--output",
      "report.bin",
      "--force",
    ])).toEqual({
      operation: "download",
      workspace: "workspace-id",
      remotePath: "/tmp/report.bin",
      output: "report.bin",
      force: true,
    });
  });

  test("requires a command separator for exec", () => {
    expect(() => parseWorkspaceCommandArgs(["exec", "workspace-id", "printf"]))
      .toThrow("workspace exec requires -- before COMMAND");
  });
});

describe("CLI mesh command parsing and requests", () => {
  test("parses representative subcommands and options", () => {
    expect(parseMeshCommandArgs([
      "pair",
      "start",
      "https://peer.example",
      "--target-user-id",
      "user-2",
    ])).toEqual({
      operation: "pair-start",
      endpoint: "https://peer.example",
      targetUserId: "user-2",
    });

    expect(parseMeshCommandArgs([
      "rejoin",
      "https://peer.example",
      "--target-user-id",
      "user-2",
    ])).toEqual({
      operation: "rejoin",
      endpoint: "https://peer.example",
      targetUserId: "user-2",
    });
  });

  test("builds representative API requests", () => {
    expect(buildMeshRequest(parseMeshCommandArgs(["status"]))).toEqual({
      endpoint: "/api/mesh/status",
      method: "GET",
    });
    expect(buildMeshRequest(parseMeshCommandArgs([
      "pair",
      "approve",
      "request/1",
      "--link-id",
      "link-1",
    ]))).toEqual({
      endpoint: "/api/mesh/pairing-requests/request%2F1/approve",
      method: "POST",
      payload: "{\"linkId\":\"link-1\"}",
    });
    expect(buildMeshRequest(parseMeshCommandArgs([
      "revoke",
      "node-1",
    ]))).toEqual({
      endpoint: "/api/mesh/members/revoke",
      method: "POST",
      payload: "{\"nodeId\":\"node-1\"}",
    });
  });
});
