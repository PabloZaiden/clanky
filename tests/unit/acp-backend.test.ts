/**
 * Unit tests for AcpBackend.
 * 
 * Note: These tests verify the class structure and basic behaviors.
 * Integration tests that actually connect to a provider runtime are in tests/api/.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { AcpBackend, sanitizeSpawnArgsForLogging } from "../../src/backends/acp";

describe("AcpBackend", () => {
  let backend: AcpBackend;

  beforeEach(() => {
    backend = new AcpBackend();
  });

  test("has correct name", () => {
    expect(backend.name).toBe("acp");
  });

  test("isConnected returns false initially", () => {
    expect(backend.isConnected()).toBe(false);
  });

  test("supports active prompt queueing", () => {
    expect(backend.supportsActivePromptQueueing()).toBe(true);
  });

  test("disconnect on unconnected backend does nothing", async () => {
    // Should not throw
    await backend.disconnect();
    expect(backend.isConnected()).toBe(false);
  });

  test("throws when createSession called before connect", async () => {
    await expect(
      backend.createSession({ directory: "/tmp" })
    ).rejects.toThrow("Not connected");
  });

  test("throws when getSession called before connect", async () => {
    await expect(backend.getSession("test-id")).rejects.toThrow("Not connected");
  });

  test("throws when deleteSession called before connect", async () => {
    await expect(backend.deleteSession("test-id")).rejects.toThrow("Not connected");
  });

  test("throws when sendPrompt called before connect", async () => {
    await expect(
      backend.sendPrompt("test-id", { parts: [{ type: "text", text: "test" }] })
    ).rejects.toThrow("Not connected");
  });

  test("throws when sendPromptAsync called before connect", async () => {
    await expect(
      backend.sendPromptAsync("test-id", { parts: [{ type: "text", text: "test" }] })
    ).rejects.toThrow("Not connected");
  });

  test("throws when abortSession called before connect", async () => {
    await expect(backend.abortSession("test-id")).rejects.toThrow("Not connected");
  });

  test("abortSession falls back through supported ACP cancellation methods", async () => {
    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | Record<string, never> | null;
      sendRpcRequest: (method: string, params: { sessionId: string }, timeoutMs: number) => Promise<void>;
    };

    const attemptedMethods: string[] = [];
    internal.connected = true;
    internal.process = {} as Record<string, never>;
    internal.sendRpcRequest = async (method: string): Promise<void> => {
      attemptedMethods.push(method);
      if (method === "session/cancel") {
        throw new Error("Method not found");
      }
      if (method === "session/abort") {
        throw new Error("RPC error -32601");
      }
    };

    await backend.abortSession("test-session");

    expect(attemptedMethods).toEqual([
      "session/cancel",
      "session/abort",
      "session/stop",
    ]);
  });

  test("abortSession rethrows non-method-not-found errors", async () => {
    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | Record<string, never> | null;
      sendRpcRequest: (method: string, params: { sessionId: string }, timeoutMs: number) => Promise<void>;
    };

    internal.connected = true;
    internal.process = {} as Record<string, never>;
    internal.sendRpcRequest = async (): Promise<void> => {
      throw new Error("transport disconnected");
    };

    await expect(backend.abortSession("test-session")).rejects.toThrow("transport disconnected");
  });
});

describe("sanitizeSpawnArgsForLogging", () => {
  test("masks only sshpass password argument values", () => {
    const args = [
      "-p",
      "super-secret-password",
      "ssh",
      "-o",
      "NumberOfPasswordPrompts=1",
      "-p",
      "5001",
      "host",
      "--",
      "bash -lc 'copilot --yolo --acp'",
    ];

    const sanitized = sanitizeSpawnArgsForLogging("sshpass", args);

    expect(sanitized).toEqual([
      "-p",
      "***",
      "ssh",
      "-o",
      "NumberOfPasswordPrompts=1",
      "-p",
      "5001",
      "host",
      "--",
      "bash -lc 'copilot --yolo --acp'",
    ]);
    expect(args[1]).toBe("super-secret-password");
  });

  test("leaves non-sshpass commands unchanged", () => {
    const args = ["-o", "BatchMode=yes", "-p", "5001", "host"];
    const sanitized = sanitizeSpawnArgsForLogging("ssh", args);
    expect(sanitized).toBe(args);
  });
});

describe("AcpBackend Connection Config", () => {
  test("connect rejects when already connected", async () => {
    const backend = new AcpBackend();
    
    // We can't actually connect without a server, but we can test the double-connect check
    // by mocking the internal state. For now, we test that connect with invalid config fails.
    // This is more of an integration test scenario.
    
    // Try to connect to a non-existent server (will fail, which is expected)
    const config = {
      mode: "connect" as const,
      hostname: "localhost",
      port: 59999, // Unlikely to be used
      directory: "/tmp",
    };

    // This should fail because no server is running
    await expect(backend.connect(config)).rejects.toThrow();
  });
});

describe("AcpBackend abortAllSubscriptions", () => {
  test("abortAllSubscriptions works when no subscriptions exist", () => {
    const backend = new AcpBackend();
    
    // Should not throw when called with no active subscriptions
    expect(() => backend.abortAllSubscriptions()).not.toThrow();
  });

  test("abortAllSubscriptions aborts all tracked subscriptions", () => {
    const backend = new AcpBackend();
    
    // Access the private activeSubscriptions set via type assertion
    const b = backend as unknown as { activeSubscriptions: Set<AbortController> };
    
    // Create mock AbortControllers
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    const controller3 = new AbortController();
    
    // Track abort calls by checking signal.aborted after calling abort
    b.activeSubscriptions.add(controller1);
    b.activeSubscriptions.add(controller2);
    b.activeSubscriptions.add(controller3);
    
    expect(b.activeSubscriptions.size).toBe(3);
    expect(controller1.signal.aborted).toBe(false);
    expect(controller2.signal.aborted).toBe(false);
    expect(controller3.signal.aborted).toBe(false);
    
    // Call abortAllSubscriptions
    backend.abortAllSubscriptions();
    
    // Verify all controllers were aborted
    expect(controller1.signal.aborted).toBe(true);
    expect(controller2.signal.aborted).toBe(true);
    expect(controller3.signal.aborted).toBe(true);
    
    // Verify the set was cleared
    expect(b.activeSubscriptions.size).toBe(0);
  });

  test("abortAllSubscriptions clears the subscription set", () => {
    const backend = new AcpBackend();
    
    // Access the private activeSubscriptions set
    const b = backend as unknown as { activeSubscriptions: Set<AbortController> };
    
    // Add some controllers
    b.activeSubscriptions.add(new AbortController());
    b.activeSubscriptions.add(new AbortController());
    
    expect(b.activeSubscriptions.size).toBe(2);
    
    backend.abortAllSubscriptions();
    
    expect(b.activeSubscriptions.size).toBe(0);
  });
});

describe("AcpBackend replyToPermission", () => {
  test("throws when replyToPermission called before connect", async () => {
    const backend = new AcpBackend();
    
    await expect(
      backend.replyToPermission("request-123", "once")
    ).rejects.toThrow("Not connected");
  });

  test("throws when replyToPermission called with 'always' before connect", async () => {
    const backend = new AcpBackend();
    
    await expect(
      backend.replyToPermission("request-456", "always")
    ).rejects.toThrow("Not connected");
  });

  test("throws when replyToPermission called with 'reject' before connect", async () => {
    const backend = new AcpBackend();
    
    await expect(
      backend.replyToPermission("request-789", "reject")
    ).rejects.toThrow("Not connected");
  });
});

describe("AcpBackend replyToQuestion", () => {
  test("throws when replyToQuestion called before connect", async () => {
    const backend = new AcpBackend();
    
    await expect(
      backend.replyToQuestion("question-123", [["answer1"]])
    ).rejects.toThrow("Not connected");
  });

  test("throws when replyToQuestion called with multiple answers before connect", async () => {
    const backend = new AcpBackend();
    
    await expect(
      backend.replyToQuestion("question-456", [["option1", "option2"], ["choice1"]])
    ).rejects.toThrow("Not connected");
  });

  test("throws when replyToQuestion called with empty answers before connect", async () => {
    const backend = new AcpBackend();
    
    await expect(
      backend.replyToQuestion("question-789", [])
    ).rejects.toThrow("Not connected");
  });

  test("throws when replyToQuestion called with empty answer arrays before connect", async () => {
    const backend = new AcpBackend();
    
    await expect(
      backend.replyToQuestion("question-101", [[], []])
    ).rejects.toThrow("Not connected");
  });
});

describe("AcpBackend transport validation", () => {
  test("getConnectionInfo returns null when not connected", () => {
    const backend = new AcpBackend();
    expect(backend.getConnectionInfo()).toBe(null);
  });

  test("connect mode is rejected by ACP runtime", async () => {
    const backend = new AcpBackend();
    const config = {
      mode: "connect" as const,
      hostname: "test-server.example.com",
      port: 4096,
      directory: "/tmp",
    };

    await expect(backend.connect(config)).rejects.toThrow(
      "Connect mode is not supported by ACP runtime. Use stdio or ssh transport."
    );
    expect(backend.isConnected()).toBe(false);
  });

  test("connect mode with legacy HTTPS fields is still rejected", async () => {
    const backend = new AcpBackend();
    const config = {
      mode: "connect" as const,
      hostname: "test-server.example.com",
      port: 8443,
      directory: "/tmp",
    };

    await expect(backend.connect(config)).rejects.toThrow(
      "Connect mode is not supported by ACP runtime. Use stdio or ssh transport."
    );
    expect(backend.isConnected()).toBe(false);
  });
});

describe("AcpBackend spawn cwd selection", () => {
  test("uses root cwd for ssh transport spawn", async () => {
    const originalSpawn = Bun.spawn;
    let capturedCwd: string | undefined;

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((...args: unknown[]) => {
      const options = (args.length === 1 ? args[0] : args[1]) as { cwd?: string } | undefined;
      capturedCwd = options?.cwd;
      throw new Error("mock spawn failure");
    }) as unknown as typeof Bun.spawn;

    const backend = new AcpBackend();
    try {
      await expect(
        backend.connect({
          mode: "spawn",
          provider: "copilot",
          transport: "ssh",
          command: "sshpass",
          args: ["-p", "secret", "ssh", "user@host", "--", "copilot", "--yolo", "--acp"],
          directory: "/workspaces/remote-only-path",
        }),
      ).rejects.toThrow("Failed to spawn ACP process");
      expect(capturedCwd).toBe("/");
      expect(backend.isConnected()).toBe(false);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  test("uses configured cwd for stdio transport spawn", async () => {
    const originalSpawn = Bun.spawn;
    let capturedCwd: string | undefined;

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((...args: unknown[]) => {
      const options = (args.length === 1 ? args[0] : args[1]) as { cwd?: string } | undefined;
      capturedCwd = options?.cwd;
      throw new Error("mock spawn failure");
    }) as unknown as typeof Bun.spawn;

    const backend = new AcpBackend();
    try {
      await expect(
        backend.connect({
          mode: "spawn",
          provider: "copilot",
          transport: "stdio",
          command: "copilot",
          args: ["--yolo", "--acp"],
          directory: "/tmp/stdio-workdir",
        }),
      ).rejects.toThrow("Failed to spawn ACP process");
      expect(capturedCwd).toBe("/tmp/stdio-workdir");
      expect(backend.isConnected()).toBe(false);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });
});

describe("AcpBackend process exit handling", () => {
  test("rejects initialize request when ACP process exits early", async () => {
    const originalSpawn = Bun.spawn;
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const encoder = new TextEncoder();

    const fakeProcess = {
      stdin: {
        write: () => {
          resolveExit(255);
        },
      },
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("Permission denied\n"));
          controller.close();
        },
      }),
      exited,
    } as unknown as Bun.Subprocess;

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((..._args: unknown[]) => {
      return fakeProcess;
    }) as unknown as typeof Bun.spawn;

    const backend = new AcpBackend();
    try {
      await expect(
        backend.connect({
          mode: "spawn",
          provider: "copilot",
          transport: "ssh",
          command: "sshpass",
          args: ["-p", "secret", "ssh", "user@host", "--", "copilot", "--yolo", "--acp"],
          directory: "/workspaces/remote-path",
        }),
      ).rejects.toThrow("ACP process exited with code 255");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  test("includes auth hint for sshpass exit code 5", async () => {
    const originalSpawn = Bun.spawn;
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const fakeProcess = {
      stdin: {
        write: () => {
          resolveExit(5);
        },
      },
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      exited,
    } as unknown as Bun.Subprocess;

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((..._args: unknown[]) => {
      return fakeProcess;
    }) as unknown as typeof Bun.spawn;

    const backend = new AcpBackend();
    try {
      await expect(
        backend.connect({
          mode: "spawn",
          provider: "copilot",
          transport: "ssh",
          command: "sshpass",
          args: ["-p", "secret", "ssh", "user@host", "--", "copilot", "--yolo", "--acp"],
          directory: "/workspaces/remote-path",
        }),
      ).rejects.toThrow("sshpass reported authentication failure");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });
});

describe("AcpBackend setConfigOption", () => {
  test("throws when setConfigOption called before connect", async () => {
    const backend = new AcpBackend();
    await expect(
      backend.setConfigOption("session-1", "model", "gpt-5.2")
    ).rejects.toThrow("Not connected");
  });
});

describe("AcpBackend setSessionModel", () => {
  test("throws when setSessionModel called before connect", async () => {
    const backend = new AcpBackend();
    await expect(
      backend.setSessionModel("session-1", "anthropic/claude-sonnet-4")
    ).rejects.toThrow("Not connected");
  });
});
