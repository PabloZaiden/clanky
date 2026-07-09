import { describe, expect, test } from "bun:test";
import { buildProviderAvailabilityShellCheck, buildProviderShellInvocation, getProviderAcpCommand } from "../../src/core/agent-runtime-command";

describe("agent runtime command", () => {
  test("quotes shell invocation arguments safely", () => {
    expect(buildProviderShellInvocation({
      command: "provider",
      args: ["arg with spaces", "it's quoted"],
    })).toBe("'provider' 'arg with spaces' 'it'\"'\"'s quoted'");
  });

  test("builds Grok ACP command with always-approve mode and package fallback", () => {
    const command = getProviderAcpCommand("grok");

    expect(command.command).toBe("sh");
    expect(command.args).toContain("grok");
    expect(command.args).toContain("agent");
    expect(command.args).toContain("--always-approve");
    expect(command.args).toContain("stdio");
    expect(command.args[1]).toContain("command -v grok");
    expect(command.args[1]).toContain("npx --yes @xai-official/grok");
    expect(command.args[1]).toContain("bunx --yes @xai-official/grok");
  });

  test("checks Grok availability through installed CLI or package runners", () => {
    expect(buildProviderAvailabilityShellCheck("grok")).toBe(
      "{ command -v grok >/dev/null 2>&1 || command -v npx >/dev/null 2>&1 || command -v bunx >/dev/null 2>&1; }",
    );
  });
});
