import { describe, expect, test } from "bun:test";
import { sanitizeServerSettings } from "@/lib/sensitive-data";

describe("sensitive data sanitization", () => {
  test("projects legacy server settings to the public provider-only shape", () => {
    const legacySettings = {
      agent: {
        provider: "copilot" as const,
        transport: "ssh",
        hostname: "example.test",
        username: "builder",
        password: "secret",
        identityFile: "private-key",
      },
    };

    expect(sanitizeServerSettings(legacySettings)).toEqual({
      agent: {
        provider: "copilot",
      },
    });
  });
});
