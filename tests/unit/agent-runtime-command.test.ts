import { describe, expect, test } from "bun:test";
import {
  buildProviderAvailabilityShellCheck,
  buildProviderShellInvocation,
  getProviderAcpCommand,
} from "../../src/core/agent-runtime-command";
import { AgentProviderSchema } from "../../src/types/schemas/workspace";
import { DiscoverSshServerChatModelsRequestSchema } from "../../src/types/schemas/chat";

describe("agent runtime command", () => {
  test("returns resolver commands for providers with package runner fallbacks", () => {
    const opencode = getProviderAcpCommand("opencode", "ssh");
    const copilot = getProviderAcpCommand("copilot", "ssh");

    expect(opencode.command).toBe("sh");
    expect(opencode.args[0]).toBe("-c");
    expect(opencode.args[1]).toContain("command -v opencode");
    expect(opencode.args[1]).toContain("exec opencode \"$@\"");
    expect(opencode.args[1]).toContain("exec npx --yes opencode-ai \"$@\"");
    expect(opencode.args[1]).toContain("exec bunx --yes opencode-ai \"$@\"");
    expect(opencode.args[1]!.indexOf("command -v opencode")).toBeLessThan(
      opencode.args[1]!.indexOf("command -v npx"),
    );
    expect(opencode.args[1]!.indexOf("command -v npx")).toBeLessThan(
      opencode.args[1]!.indexOf("command -v bunx"),
    );
    expect(opencode.args.slice(2)).toEqual(["opencode", "acp"]);

    expect(copilot.command).toBe("sh");
    expect(copilot.args[0]).toBe("-c");
    expect(copilot.args[1]).toContain("command -v copilot");
    expect(copilot.args[1]).toContain("exec copilot \"$@\"");
    expect(copilot.args[1]).toContain("exec npx --yes @github/copilot \"$@\"");
    expect(copilot.args[1]).toContain("exec bunx --yes @github/copilot \"$@\"");
    expect(copilot.args[1]!.indexOf("command -v copilot")).toBeLessThan(
      copilot.args[1]!.indexOf("command -v npx"),
    );
    expect(copilot.args[1]!.indexOf("command -v npx")).toBeLessThan(
      copilot.args[1]!.indexOf("command -v bunx"),
    );
    expect(copilot.args.slice(2)).toEqual(["copilot", "--yolo", "--acp"]);
  });

  test("uses the same POSIX resolver command for stdio and ssh providers", () => {
    expect(getProviderAcpCommand("copilot", "stdio")).toEqual(getProviderAcpCommand("copilot", "ssh"));
    expect(getProviderAcpCommand("opencode", "stdio")).toEqual(getProviderAcpCommand("opencode", "ssh"));
    expect(getProviderAcpCommand("codex", "stdio")).toEqual(getProviderAcpCommand("codex", "ssh"));
  });

  test("returns a synchronous resolver command for Codex ACP", () => {
    const command = getProviderAcpCommand("codex", "ssh");

    expect(command.command).toBe("sh");
    expect(command.args[0]).toBe("-c");
    expect(command.args[1]).toContain("command -v codex-acp");
    expect(command.args[1]).toContain("command -v npx");
    expect(command.args[1]).toContain("command -v bunx");
    expect(command.args[1]!.indexOf("command -v codex-acp")).toBeLessThan(
      command.args[1]!.indexOf("command -v npx"),
    );
    expect(command.args[1]!.indexOf("command -v npx")).toBeLessThan(
      command.args[1]!.indexOf("command -v bunx"),
    );
    expect(command.args.slice(2)).toEqual([
      "codex-acp",
      "-c",
      "approval_policy=\"never\"",
      "-c",
      "sandbox_mode=\"danger-full-access\"",
    ]);
  });

  test("quotes provider commands for shell invocation", () => {
    const invocation = buildProviderShellInvocation(getProviderAcpCommand("codex", "ssh"));

    expect(invocation.startsWith("'sh' '-c' '")).toBe(true);
    expect(invocation).toContain("exec npx --yes @zed-industries/codex-acp");
    expect(invocation).toContain("exec bunx --yes @zed-industries/codex-acp");
    expect(invocation).toContain("'approval_policy=\"never\"'");
    expect(invocation).toContain("'sandbox_mode=\"danger-full-access\"'");
    expect(buildProviderShellInvocation({
      command: "provider",
      args: ["arg with spaces", "it's quoted"],
    })).toBe("'provider' 'arg with spaces' 'it'\"'\"'s quoted'");
  });

  test("quotes package fallbacks for Copilot and OpenCode shell invocations", () => {
    const copilotInvocation = buildProviderShellInvocation(getProviderAcpCommand("copilot", "ssh"));
    const opencodeInvocation = buildProviderShellInvocation(getProviderAcpCommand("opencode", "ssh"));

    expect(copilotInvocation.startsWith("'sh' '-c' '")).toBe(true);
    expect(copilotInvocation).toContain("exec npx --yes @github/copilot");
    expect(copilotInvocation).toContain("exec bunx --yes @github/copilot");
    expect(copilotInvocation).toContain("'--yolo' '--acp'");
    expect(opencodeInvocation.startsWith("'sh' '-c' '")).toBe(true);
    expect(opencodeInvocation).toContain("exec npx --yes opencode-ai");
    expect(opencodeInvocation).toContain("exec bunx --yes opencode-ai");
    expect(opencodeInvocation).toContain("'opencode' 'acp'");
  });

  test("builds provider availability checks matching resolver fallbacks", () => {
    expect(buildProviderAvailabilityShellCheck("copilot")).toBe(
      "{ command -v copilot >/dev/null 2>&1 || command -v npx >/dev/null 2>&1 || command -v bunx >/dev/null 2>&1; }",
    );
    expect(buildProviderAvailabilityShellCheck("opencode")).toBe(
      "{ command -v opencode >/dev/null 2>&1 || command -v npx >/dev/null 2>&1 || command -v bunx >/dev/null 2>&1; }",
    );
    expect(buildProviderAvailabilityShellCheck("codex")).toBe(
      "command -v codex >/dev/null 2>&1 && { command -v codex-acp >/dev/null 2>&1 || command -v npx >/dev/null 2>&1 || command -v bunx >/dev/null 2>&1; }",
    );
  });

  test("accepts Codex in provider schemas", () => {
    expect(AgentProviderSchema.parse("codex")).toBe("codex");
    expect(DiscoverSshServerChatModelsRequestSchema.parse({
      credentialToken: "token",
      directory: "/workspace",
      providerID: "codex",
    }).providerID).toBe("codex");
  });
});
