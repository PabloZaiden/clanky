import { describe, expect, test } from "bun:test";
import { parseMeshCommandArgs } from "../../src/cli/mesh";
import { parseWorkerBootstrapArgs } from "../../src/cli/worker";

describe("CLI security-sensitive parsing", () => {
  test("requires the enrollment token from --token", () => {
    const originalToken = process.env["CLANKY_MESH_ENROLLMENT_TOKEN"];
    process.env["CLANKY_MESH_ENROLLMENT_TOKEN"] = "environment-token";
    try {
      expect(() => parseMeshCommandArgs([
        "enroll",
        "https://worker.example.com",
        "--fingerprint",
        "fingerprint",
      ])).toThrow("Mesh enroll requires --token");
    } finally {
      if (originalToken === undefined) {
        delete process.env["CLANKY_MESH_ENROLLMENT_TOKEN"];
      } else {
        process.env["CLANKY_MESH_ENROLLMENT_TOKEN"] = originalToken;
      }
    }
  });

  test("requires named relay mutations and limits relay selection to relay invitations", () => {
    // CLI validation prevents an omitted name from mutating an unintended pairing.
    expect(() => parseMeshCommandArgs([
      "relay", "pair", "https://relay.example.com",
    ])).toThrow("Mesh relay pair requires --name");
    expect(() => parseMeshCommandArgs([
      "relay", "unpair",
    ])).toThrow("Mesh relay unpair requires --name");
    expect(parseMeshCommandArgs([
      "relay", "pair", "https://relay.example.com", "--name", "east",
    ])).toMatchObject({
      operation: "relay-pair",
      relayName: "east",
      relayUrl: "https://relay.example.com",
    });
    expect(parseMeshCommandArgs([
      "relay", "unpair", "--name", "east",
    ])).toMatchObject({ operation: "relay-unpair", relayName: "east" });
    expect(parseMeshCommandArgs([
      "relay", "primary", "west",
    ])).toMatchObject({ operation: "relay-primary", relayName: "west" });
    expect(parseMeshCommandArgs([
      "enrollment-token", "create", "--route", "relay", "--relay", "west",
    ])).toMatchObject({
      operation: "enrollment-token-create",
      route: "relay",
      relayName: "west",
    });
    expect(parseMeshCommandArgs([
      "enrollment-token", "create", "--route", "relay",
    ]).relayName).toBeUndefined();
    expect(() => parseMeshCommandArgs([
      "enrollment-token", "create", "--route", "direct", "--relay", "west",
    ])).toThrow("--relay requires --route relay");
  });

  test("restricts relay-only workers to loopback without a public endpoint", () => {
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
