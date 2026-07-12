import { describe, expect, test } from "bun:test";
import {
  buildProviderShellInvocation,
  buildProviderSpawnEnvironment,
  getProviderAcpCommand,
} from "../../src/core/agent-runtime-command";
import { buildConnectionConfig } from "../../src/core/backend/backend-connection-pool";

describe("agent runtime command", () => {
  test("quotes shell invocation arguments safely", () => {
    expect(buildProviderShellInvocation({
      command: "provider",
      args: ["arg with spaces", "it's quoted"],
    })).toBe("'provider' 'arg with spaces' 'it'\"'\"'s quoted'");
  });

  test("configures Codex ACP with its full-access environment", () => {
    const codexCommand = getProviderAcpCommand("codex");
    const codexConfig = JSON.stringify({
      approval_policy: "never",
      sandbox_mode: "danger-full-access",
    });

    expect(codexCommand.env).toEqual({
      INITIAL_AGENT_MODE: "agent-full-access",
      CODEX_CONFIG: codexConfig,
    });
    expect(codexCommand.args).not.toContain("approval_policy=\"never\"");
    expect(codexCommand.args).not.toContain("sandbox_mode=\"danger-full-access\"");
    expect(buildProviderShellInvocation(codexCommand)).toContain(
      `INITIAL_AGENT_MODE='agent-full-access' CODEX_CONFIG='${codexConfig}'`,
    );
  });

  test("merges provider environment with inherited and explicit values", () => {
    const codexCommand = getProviderAcpCommand("codex");

    expect(buildProviderSpawnEnvironment(
      codexCommand,
      {
        PATH: "/bin",
        HOME: "/home/test",
        CODEX_CONFIG: "inherited-value",
      },
      {
        CUSTOM_VALUE: "explicit-value",
      },
    )).toEqual({
      PATH: "/bin",
      HOME: "/home/test",
      CODEX_CONFIG: codexCommand.env?.["CODEX_CONFIG"],
      INITIAL_AGENT_MODE: "agent-full-access",
      CUSTOM_VALUE: "explicit-value",
    });
  });

  test("propagates Codex environment to local and remote connection configs", () => {
    const localConfig = buildConnectionConfig({
      agent: {
        provider: "codex",
        transport: "stdio",
      },
    }, "/workspace");
    expect(localConfig.env).toMatchObject({
      INITIAL_AGENT_MODE: "agent-full-access",
      CODEX_CONFIG: JSON.stringify({
        approval_policy: "never",
        sandbox_mode: "danger-full-access",
      }),
    });

    const remoteConfig = buildConnectionConfig({
      agent: {
        provider: "codex",
        transport: "ssh",
        hostname: "example.test",
        port: 22,
        username: "tester",
        password: "ssh-password",
      },
    }, "/workspace");
    const remoteCommandIndex = remoteConfig.args?.indexOf("--") ?? -1;
    const remoteCommand = remoteConfig.args?.[remoteCommandIndex + 1] ?? "";

    expect(remoteCommand).toContain("INITIAL_AGENT_MODE=");
    expect(remoteCommand).toContain("agent-full-access");
    expect(remoteCommand).toContain("CODEX_CONFIG=");
    expect(remoteCommand).toContain("approval_policy");
    expect(remoteCommand).toContain("danger-full-access");
    expect(remoteCommand).not.toContain("ssh-password");
    expect(remoteConfig.env).toMatchObject({ SSHPASS: "ssh-password" });
  });
});
