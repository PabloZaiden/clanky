import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { getProviderAcpCommand } from "../../src/core/agent-runtime-command";

describe("getProviderAcpCommand", () => {
  const originalMockAcpEnv = process.env["RALPHER_MOCK_ACP"];

  afterEach(() => {
    if (originalMockAcpEnv === undefined) {
      delete process.env["RALPHER_MOCK_ACP"];
    } else {
      process.env["RALPHER_MOCK_ACP"] = originalMockAcpEnv;
    }
  });

  test("returns provider defaults when mock ACP is disabled", () => {
    delete process.env["RALPHER_MOCK_ACP"];

    expect(getProviderAcpCommand("copilot")).toEqual({
      command: "copilot",
      args: ["--yolo", "--acp"],
    });
    expect(getProviderAcpCommand("opencode")).toEqual({
      command: "opencode",
      args: ["acp"],
    });
  });

  test("returns the mock ACP runtime command when enabled", () => {
    process.env["RALPHER_MOCK_ACP"] = "true";

    expect(getProviderAcpCommand("copilot")).toEqual({
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL("../../src/backends/acp/mock-acp-server.ts", import.meta.url),
        ),
      ],
    });
  });
});
