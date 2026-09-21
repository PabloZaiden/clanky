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
