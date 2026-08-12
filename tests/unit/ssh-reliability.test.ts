import { describe, expect, test } from "bun:test";

import {
  createAcpProcessError,
  AcpBackend,
  LocalAcpTransportLifecycle,
} from "../../src/backends/acp";
import {
  buildSshCommandArgs,
  buildSshRemoteShellCommand,
} from "../../src/core/remote-executor/ssh-helpers";
import { SshConnectionGate } from "../../src/core/ssh-connection-gate";
import {
  buildSshConnectionKey,
  getSshReliabilityPolicy,
  SSH_CONNECT_TIMEOUT_MS,
  SSH_CONNECTION_ATTEMPTS,
  SSH_CONNECTION_TIMEOUT_MS,
  SSH_MAX_CONCURRENT_HANDSHAKES,
  SSH_SERVER_ALIVE_COUNT_MAX,
  SSH_SERVER_ALIVE_INTERVAL_SECONDS,
  type SshReliabilityPolicy,
} from "../../src/core/ssh-reliability-policy";

const policy: SshReliabilityPolicy = getSshReliabilityPolicy();

describe("SSH reliability policy", () => {
  test("uses native OpenSSH retry and keepalive options without changing the remote shell", () => {
    const args = buildSshCommandArgs({
      authMode: "batch",
      port: 5002,
      target: "user@example.test",
      remoteCommand: buildSshRemoteShellCommand("copilot --acp"),
      policy,
    });

    expect(args).toContain("ConnectTimeout=30");
    expect(args).toContain("ConnectionAttempts=2");
    expect(args).toContain("ServerAliveInterval=30");
    expect(args).toContain("ServerAliveCountMax=3");
    expect(args.join(" ")).toContain("-ilc");
  });

  test("uses the code-defined SSH reliability constants", () => {
    expect(getSshReliabilityPolicy()).toEqual({
      connectTimeoutMs: SSH_CONNECT_TIMEOUT_MS,
      connectTimeoutSeconds: 30,
      connectionAttempts: SSH_CONNECTION_ATTEMPTS,
      serverAliveIntervalSeconds: SSH_SERVER_ALIVE_INTERVAL_SECONDS,
      serverAliveCountMax: SSH_SERVER_ALIVE_COUNT_MAX,
      connectionTimeoutMs: SSH_CONNECTION_TIMEOUT_MS,
      maxConcurrentHandshakes: SSH_MAX_CONCURRENT_HANDSHAKES,
    });
  });

  test("normalizes SSH connection keys and separates authentication modes", () => {
    const identityKey = JSON.parse(buildSshConnectionKey({
      hostname: " Example.TEST ",
      username: " Root ",
      identityFile: " /keys/id_ed25519 ",
    })) as Record<string, unknown>;
    const passwordKey = JSON.parse(buildSshConnectionKey({
      hostname: "example.test",
      username: "root",
      password: "test-secret",
    })) as Record<string, unknown>;
    const agentKey = JSON.parse(buildSshConnectionKey({
      hostname: "example.test",
      username: "root",
    })) as Record<string, unknown>;

    expect(identityKey).toEqual({
      hostname: "example.test",
      port: 22,
      username: "root",
      authMode: "identity",
      identityFile: "/keys/id_ed25519",
    });
    expect(passwordKey).toMatchObject({
      hostname: "example.test",
      port: 22,
      username: "root",
      authMode: "password",
      identityFile: "",
    });
    expect(agentKey).toMatchObject({
      hostname: "example.test",
      port: 22,
      username: "root",
      authMode: "agent",
      identityFile: "",
    });
  });

  test("classifies SSH authentication only from the documented sshpass exit code", () => {
    const genericSshFailure = createAcpProcessError(
      "ssh reported permission denied",
      {
        command: "ssh",
        exitCode: 255,
        transport: "ssh",
        stage: "initialize",
      },
    );
    const sshpassFailure = createAcpProcessError(
      "sshpass exited",
      {
        command: "sshpass",
        exitCode: 5,
        transport: "ssh",
        stage: "initialize",
      },
    );

    expect(genericSshFailure.code).toBe("acp_process_failed");
    expect(sshpassFailure.code).toBe("acp_ssh_authentication_failed");
  });

  test("accepts an explicit structured authentication result without parsing stderr", () => {
    const structuredAuthenticationFailure = createAcpProcessError(
      "Permission denied (publickey,password)",
      {
        command: "ssh",
        exitCode: 255,
        transport: "ssh",
        authenticationMode: "identity",
        authenticationFailure: true,
      },
    );

    expect(structuredAuthenticationFailure.code).toBe("acp_ssh_authentication_failed");
    expect(structuredAuthenticationFailure.details).toMatchObject({
      exitCode: 255,
      transport: "ssh",
      authenticationMode: "identity",
      authenticationFailure: true,
    });
  });

  test("limits only concurrent connection establishment and releases slots deterministically", async () => {
    const gate = new SshConnectionGate(1);
    const firstRelease = await gate.acquire("same-target");
    const secondReleasePromise = gate.acquire("same-target");

    expect(gate.getActiveCount("same-target")).toBe(1);
    expect(gate.getWaitingCount("same-target")).toBe(1);

    firstRelease();
    const secondRelease = await secondReleasePromise;
    expect(gate.getActiveCount("same-target")).toBe(1);
    expect(gate.getWaitingCount("same-target")).toBe(0);

    secondRelease();
    expect(gate.getActiveCount("same-target")).toBe(0);
  });

  test("does not serialize independent SSH targets", async () => {
    const gate = new SshConnectionGate(1);
    const firstRelease = await gate.acquire("target-a");
    const secondRelease = await gate.acquire("target-b");

    expect(gate.getActiveCount("target-a")).toBe(1);
    expect(gate.getActiveCount("target-b")).toBe(1);

    firstRelease();
    secondRelease();
  });

  test("removes an aborted waiter without consuming a connection slot", async () => {
    const gate = new SshConnectionGate(1);
    const firstRelease = await gate.acquire("same-target");
    const controller = new AbortController();
    const waiting = gate.acquire("same-target", controller.signal);

    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    expect(gate.getWaitingCount("same-target")).toBe(0);
    expect(gate.getActiveCount("same-target")).toBe(1);

    firstRelease();
    expect(gate.getActiveCount("same-target")).toBe(0);
  });

  test("aborts a stalled SSH ACP initialization and cleans up its process", async () => {
    const lifecycle = new LocalAcpTransportLifecycle({
      reliabilityPolicy: {
        ...policy,
        connectionTimeoutMs: 25,
      },
      connectionGate: new SshConnectionGate(1),
    });
    const backend = new AcpBackend({ transportLifecycle: lifecycle });

    try {
      await expect(
        backend.connect({
          mode: "spawn",
          provider: "opencode",
          transport: "ssh",
          hostname: "example.test",
          port: 5002,
          directory: "/workspace",
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000);"],
        }),
      ).rejects.toMatchObject({
        code: "acp_connection_timed_out",
      });

      expect(lifecycle.isConnected()).toBe(false);
      expect(lifecycle.hasProcess()).toBe(false);
    } finally {
      await backend.disconnect();
    }
  });

  test("keeps a generic SSH exit 255 ambiguous in structured process errors", async () => {
    const lifecycle = new LocalAcpTransportLifecycle({
      reliabilityPolicy: policy,
      connectionGate: new SshConnectionGate(1),
    });
    const backend = new AcpBackend({ transportLifecycle: lifecycle });

    try {
      await expect(
        backend.connect({
          mode: "spawn",
          provider: "opencode",
          transport: "ssh",
          hostname: "example.test",
          port: 5002,
          directory: "/workspace",
          command: process.execPath,
          args: ["-e", "process.exit(255);"],
        }),
      ).rejects.toMatchObject({
        code: "acp_process_failed",
        details: {
          exitCode: 255,
          transport: "ssh",
        },
      });
    } finally {
      await backend.disconnect();
    }
  });

  test("normalizes SSH authentication mode with identity precedence", async () => {
    const lifecycle = new LocalAcpTransportLifecycle({
      reliabilityPolicy: policy,
      connectionGate: new SshConnectionGate(1),
    });
    const backend = new AcpBackend({ transportLifecycle: lifecycle });

    try {
      await expect(
        backend.connect({
          mode: "spawn",
          provider: "opencode",
          transport: "ssh",
          hostname: "example.test",
          port: 5002,
          directory: "/workspace",
          password: "  password  ",
          identityFile: "  /keys/id_ed25519  ",
          command: process.execPath,
          args: ["-e", "process.exit(255);"],
        }),
      ).rejects.toMatchObject({
        code: "acp_process_failed",
        details: {
          authenticationMode: "identity",
        },
      });
    } finally {
      await backend.disconnect();
    }
  });

  test("treats whitespace-only SSH credentials as agent authentication", async () => {
    const lifecycle = new LocalAcpTransportLifecycle({
      reliabilityPolicy: policy,
      connectionGate: new SshConnectionGate(1),
    });
    const backend = new AcpBackend({ transportLifecycle: lifecycle });

    try {
      await expect(
        backend.connect({
          mode: "spawn",
          provider: "opencode",
          transport: "ssh",
          hostname: "example.test",
          port: 5002,
          directory: "/workspace",
          password: "   ",
          identityFile: "   ",
          command: process.execPath,
          args: ["-e", "process.exit(255);"],
        }),
      ).rejects.toMatchObject({
        code: "acp_process_failed",
        details: {
          authenticationMode: "agent",
        },
      });
    } finally {
      await backend.disconnect();
    }
  });
});
