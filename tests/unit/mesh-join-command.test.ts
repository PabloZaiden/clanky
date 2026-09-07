import { describe, expect, test } from "bun:test";
import { buildWorkerJoinCommand } from "../../src/core/mesh-join-command";

describe("Mesh worker join command", () => {
  test("renders one copyable shell command with safely quoted values", () => {
    expect(buildWorkerJoinCommand({
      controllerEndpoint: "https://controller.example.com",
      enrollmentToken: "clanky_mesh_token",
      controllerFingerprint: "fingerprint-123",
    })).toBe(
      "clanky worker join --controller 'https://controller.example.com' "
      + "--token 'clanky_mesh_token' --fingerprint 'fingerprint-123'",
    );
  });

  test("does not allow shell expansion in command arguments", () => {
    expect(buildWorkerJoinCommand({
      controllerEndpoint: "https://controller.example.com",
      enrollmentToken: "token'$(touch /tmp/unexpected)",
      controllerFingerprint: "fingerprint",
    })).toContain("'token'\\''$(touch /tmp/unexpected)'");
  });
});
