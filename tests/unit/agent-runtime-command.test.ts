import { describe, expect, test } from "bun:test";
import {
  AgentRuntimeUnavailableError,
  buildProviderShellInvocation,
  isAgentProviderAvailable,
  resolveProviderAcpCommand,
} from "../../src/core/agent-runtime-command";

describe("agent runtime command", () => {
  test("quotes shell invocation arguments safely", () => {
    expect(buildProviderShellInvocation({
      command: "provider",
      args: ["arg with spaces", "it's quoted"],
    })).toBe("'provider' 'arg with spaces' 'it'\"'\"'s quoted'");
  });

  test("falls back to package runners without a shell", () => {
    const command = resolveProviderAcpCommand("copilot", (executable) =>
      executable === "npx"
        ? "C:\\Program Files\\nodejs\\npx.cmd"
        : executable === "powershell.exe"
          ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
          : null,
    "win32");

    expect(command).toEqual({
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$commandPath = $args[0]; $commandArgs = @($args | Select-Object -Skip 1); & $commandPath @commandArgs; exit $LASTEXITCODE",
        "C:\\Program Files\\nodejs\\npx.cmd",
        "--yes",
        "@github/copilot",
        "--yolo",
        "--acp",
      ],
    });
  });

  test("requires provider prerequisites before selecting a package runner", () => {
    const which = (executable: string): string | null =>
      executable === "npx" ? "/usr/bin/npx" : null;

    expect(() => resolveProviderAcpCommand("codex", which))
      .toThrow(AgentRuntimeUnavailableError);
    expect(isAgentProviderAvailable("codex", which)).toBe(false);
  });
});
