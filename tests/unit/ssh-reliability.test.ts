import { afterEach, describe, expect, test } from "bun:test";

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
  type SshReliabilityPolicy,
} from "../../src/core/ssh-reliability-policy";

const policy: SshReliabilityPolicy = {
  connectTimeoutMs: 30_000,
  connectTimeoutSeconds: 30,
  connectionAttempts: 2,
  serverAliveIntervalSeconds: 30,
  serverAliveCountMax: 3,
  connectionTimeoutMs: 75_000,
  maxConcurrentHandshakes: 4,
};

describe("SSH reliability policy", () => {
  afterEach(() => {
    delete process.env["CLANKY_SSH_CONNECT_TIMEOUT_MS"];
    delete process.env["CLANKY_SSH_CONNECTION_ATTEMPTS"];
    delete process.env["CLANKY_SSH_CONNECTION_TIMEOUT_MS"];
    delete process.env["CLANKY_SSH_SERVER_ALIVE_INTERVAL_SECONDS"];
    delete process.env["CLANKY_SSH_SERVER_ALIVE_COUNT_MAX"];
    delete process.env["CLANKY_SSH_MAX_CONCURRENT_HANDSHAKES"];
  });

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

  test("derives an outer deadline that contains configured connection attempts", () => {
    process.env["CLANKY_SSH_CONNECT_TIMEOUT_MS"] = "12000";
    process.env["CLANKY_SSH_CONNECTION_ATTEMPTS"] = "3";
    process.env["CLANKY_SSH_CONNECTION_TIMEOUT_MS"] = "60000";
    process.env["CLANKY_SSH_SERVER_ALIVE_INTERVAL_SECONDS"] = "45";
    process.env["CLANKY_SSH_SERVER_ALIVE_COUNT_MAX"] = "4";
    process.env["CLANKY_SSH_MAX_CONCURRENT_HANDSHAKES"] = "2";

    const configured = getSshReliabilityPolicy();

    expect(configured.connectTimeoutSeconds).toBe(12);
    expect(configured.connectionAttempts).toBe(3);
    expect(configured.connectionTimeoutMs).toBe(60_000);
    expect(configured.serverAliveIntervalSeconds).toBe(45);
    expect(configured.serverAliveCountMax).toBe(4);
    expect(configured.maxConcurrentHandshakes).toBe(2);
  });

  test("rounds each OpenSSH attempt up when deriving the outer deadline", () => {
    process.env["CLANKY_SSH_CONNECT_TIMEOUT_MS"] = "1001";
    process.env["CLANKY_SSH_CONNECTION_ATTEMPTS"] = "2";
    process.env["CLANKY_SSH_CONNECTION_TIMEOUT_MS"] = "18999";

    expect(() => getSshReliabilityPolicy()).toThrow(
      "CLANKY_SSH_CONNECTION_TIMEOUT_MS must be an integer between 19000 and 1800000",
    );
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
});
