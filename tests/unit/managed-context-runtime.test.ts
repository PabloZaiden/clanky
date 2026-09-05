import { describe, expect, test } from "bun:test";
import { buildConnectionConfig } from "../../src/core/backend/backend-connection-pool";
import { buildManagedContextEnvironment } from "../../src/core/managed-context-environment";
import {
  buildDirectShellCommand,
} from "../../src/core/ssh-bridge/command-builders";
import {
  buildPersistentSessionAttachCommand,
  PERSISTENT_SESSION_ATTACH_UNAVAILABLE_EXIT_CODE,
} from "../../src/core/ssh-persistent-session";
import type { Workspace, TerminalSession } from "@/shared";

const managedEnvironment = buildManagedContextEnvironment({
  baseUrl: "https://clanky.example",
  token: "wapp_test_secret",
});

const sshWorkspace: Workspace = {
  id: "workspace-id",
  name: "SSH workspace",
  directory: "/workspace",
  workspaceType: "git",
  executionTargetRevision: 1,
  executionHostBinding: {
    host: { kind: "ssh", serverId: "ssh-server-id" },
    targetKey: "ssh:example.test:22:runner",
    revision: 1,
  },
  allowClankyContext: true,
  serverSettings: {
    agent: {
      provider: "opencode",
    },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const terminalSession: TerminalSession = {
  config: {
    id: "session-id",
    name: "Terminal",
    workspaceId: sshWorkspace.id,
    directory: sshWorkspace.directory,
    connectionMode: "dtach",
    useTmux: false,
    remoteSessionName: "clanky-session",
    executionHostBinding: {
      host: { kind: "ssh", serverId: "ssh-server-id" },
      targetKey: "ssh-target-key",
      revision: 1,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  state: {
    status: "ready",
  },
};

describe("managed runtime environment propagation", () => {
  test("merges managed values into ACP stdio and remote provider commands", () => {
    const stdio = buildConnectionConfig(
      {
        agent: {
          provider: "opencode",
          transport: "stdio",
        },
      },
      "/workspace",
      managedEnvironment,
    );
    expect(stdio.env?.["CLANKY_BASE_URL"]).toBe("https://clanky.example");
    expect(stdio.env?.["CLANKY_API_KEY"]).toBe("wapp_test_secret");

    const remote = buildConnectionConfig(
      {
        agent: {
          provider: "opencode",
          transport: "ssh",
          hostname: "example.test",
          port: 22,
          username: "runner",
          identityFile: "/tmp/id_rsa",
        },
      },
      sshWorkspace.directory,
      managedEnvironment,
    );
    expect(remote.args?.join(" ")).toContain("CLANKY_BASE_URL");
    expect(remote.args?.join(" ")).toContain("CLANKY_API_KEY");
    expect(remote.args?.join(" ")).not.toContain("wapp_test_secret");
    expect(remote.startupStdin).toBe("https://clanky.example\nwapp_test_secret\n");
  });

  test("exports managed values for direct and persistent SSH runtime creation", () => {
    const direct = buildDirectShellCommand(
      {
        config: {
          id: terminalSession.config.id,
          directory: terminalSession.config.directory,
          useTmux: terminalSession.config.useTmux,
        },
      },
      managedEnvironment,
    );
    expect(direct).toContain("read -r clanky_base_url");
    expect(direct).toContain("read -r clanky_api_key");
    expect(direct).not.toContain("wapp_test_secret");

    const persistent = buildPersistentSessionAttachCommand(terminalSession, managedEnvironment);
    expect(persistent).toContain("read -r clanky_base_url");
    expect(persistent).toContain("read -r clanky_api_key");
    expect(persistent).not.toContain("wapp_test_secret");
    const lockDirectoryIndex = persistent.indexOf("session_lock_dir='/tmp/clanky-session.dtach.lock'");
    const lockFunctionIndex = persistent.indexOf("acquire_session_lock()");
    expect(lockDirectoryIndex).toBeGreaterThanOrEqual(0);
    expect(lockFunctionIndex).toBeGreaterThan(lockDirectoryIndex);

    const attachOnly = buildPersistentSessionAttachCommand(terminalSession, undefined, { allowCreate: false });
    expect(attachOnly).toContain(`exit ${String(PERSISTENT_SESSION_ATTACH_UNAVAILABLE_EXIT_CODE)};`);
    expect(attachOnly).not.toContain("dtach -N");
  });

  test("redacts managed ACP command arguments from diagnostic output", async () => {
    const { sanitizeSpawnArgsForLogging } = await import("../../src/backends/acp/process-utils");
    expect(sanitizeSpawnArgsForLogging("ssh", [
      "sh",
      "-lc",
      "CLANKY_API_KEY='wapp_test_secret' 'provider'",
    ])).toEqual(["[managed runtime command redacted]"]);
  });
});
