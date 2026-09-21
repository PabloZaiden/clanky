import { describe, expect, test } from "bun:test";
import { buildWorkerJoinCommand } from "../../src/core/mesh-join-command";

describe("Mesh worker join command", () => {
  test("does not allow shell expansion in command arguments", () => {
    expect(buildWorkerJoinCommand({
      target: "https://controller.example.com",
      enrollmentToken: "token'$(touch /tmp/unexpected)",
      controllerFingerprint: "fingerprint",
    })).toContain("'token'\\''$(touch /tmp/unexpected)'");
  });
});
