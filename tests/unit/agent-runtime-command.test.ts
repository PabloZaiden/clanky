import { describe, expect, test } from "bun:test";
import {
  buildProviderShellInvocation,
  getProviderAcpCommand,
} from "../../src/core/agent-runtime-command";
import { AgentProviderSchema } from "../../src/types/schemas/workspace";
import { DiscoverSshServerChatModelsRequestSchema } from "../../src/types/schemas/chat";

describe("agent runtime command", () => {
  test("returns static ACP commands for providers with native ACP support", () => {
    expect(getProviderAcpCommand("opencode", "ssh")).toEqual({
      command: "opencode",
      args: ["acp"],
    });
    expect(getProviderAcpCommand("copilot", "ssh")).toEqual({
      command: "copilot",
      args: ["--yolo", "--acp"],
    });
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

  test("accepts Codex in provider schemas", () => {
    expect(AgentProviderSchema.parse("codex")).toBe("codex");
    expect(DiscoverSshServerChatModelsRequestSchema.parse({
      credentialToken: "token",
      directory: "/workspace",
      providerID: "codex",
    }).providerID).toBe("codex");
  });
});
