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
  getSshReliabilityPolicy,
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

});
