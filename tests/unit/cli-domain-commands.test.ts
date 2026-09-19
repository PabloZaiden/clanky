import { describe, expect, test } from "bun:test";
import { parsePreviewCommandArgs } from "../../src/cli/preview";
import { parseWorkspaceCommandArgs } from "../../src/cli/workspace";
import { parseRelayCommandArgs } from "../../src/cli/relay";
import {
  parseWorkerBootstrapArgs,
  parseWorkerJoinArgs,
} from "../../src/cli/worker";

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
      server: undefined,
      port: 3000,
      remoteHost: "127.0.0.1",
      host: "0.0.0.0",
      localPort: 43123,
      path: "/",
      open: true,
    });
  });

  test("accepts a direct server target and rejects combining target selectors", () => {
    expect(parsePreviewCommandArgs([
      "--server",
      "mesh-node",
      "--port",
      "3000",
    ])).toMatchObject({
      workspace: undefined,
      server: "mesh-node",
      remoteHost: "localhost",
    });
    expect(() => parsePreviewCommandArgs([
      "--workspace",
      "app",
      "--server",
      "mesh-node",
    ])).toThrow("--workspace and --server may not be used together");
  });
});

describe("CLI workspace command parsing", () => {

  test("requires a command separator for exec", () => {
    expect(() => parseWorkspaceCommandArgs(["exec", "workspace-id", "printf"]))
      .toThrow("workspace exec requires -- before COMMAND");
  });

  describe("CLI worker enrollment parsing", () => {
    test("uses one positional target", () => {
      expect(parseWorkerJoinArgs([
        "join",
        "https://controller.example.com",
        "--token",
        "token",
        "--fingerprint",
        "fingerprint",
      ])).toEqual({
        target: "https://controller.example.com",
        enrollmentToken: "token",
        controllerFingerprint: "fingerprint",
      });
    });

    test("accepts relay-only bootstrap without a public endpoint", () => {
      expect(parseWorkerBootstrapArgs([
        "bootstrap",
        "--relay-only",
        "--worker-directory",
        "/srv/workspaces",
        "--instance-name",
        "worker-1",
      ])).toMatchObject({
        relayOnly: true,
        host: "127.0.0.1",
        port: 0,
        meshEndpoint: null,
        insecure: false,
      });
      expect(() => parseWorkerBootstrapArgs([
        "bootstrap",
        "--relay-only",
        "--host",
        "0.0.0.0",
        "--worker-directory",
        "/srv/workspaces",
        "--instance-name",
        "worker-1",
      ])).toThrow("requires a loopback --host");
      expect(() => parseWorkerBootstrapArgs([
        "bootstrap",
        "--relay-only",
        "--mesh-endpoint",
        "https://worker.example.com",
        "--worker-directory",
        "/srv/workspaces",
        "--instance-name",
        "worker-1",
      ])).toThrow("does not accept --mesh-endpoint");
    });
  });

  test("accepts relay server startup and offline pairing reset", () => {
    expect(parseRelayCommandArgs([])).toEqual({ operation: "serve" });
    expect(parseRelayCommandArgs(["pairing", "reset"])).toEqual({
      operation: "pairing-reset",
    });
    expect(() => parseRelayCommandArgs(["--port", "4000"])).toThrow(
      "Relay command must be",
    );
  });
});
