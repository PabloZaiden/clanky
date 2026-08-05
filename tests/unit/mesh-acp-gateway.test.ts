import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { MeshAcpGateway } from "../../src/core/mesh-acp-gateway";
import { meshExecutionGateway } from "../../src/core/mesh-execution-gateway";

type ControlledProcess = {
  subprocess: Bun.Subprocess;
  sendJson: (message: Record<string, unknown>) => void;
  exit: (code?: number) => void;
};

function createControlledProcess(): ControlledProcess {
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let resolveExited: ((code: number) => void) | undefined;
  let exitCode: number | null = null;
  const encoder = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  const stdin = {
    writes: [] as string[],
    write(value: string): void {
      this.writes.push(value);
    },
  };
  const subprocess = {
    stdin,
    stdout,
    stderr,
    exited,
    get exitCode(): number | null {
      return exitCode;
    },
    kill(): void {
      if (exitCode !== null) return;
      exitCode = 0;
      resolveExited?.(0);
    },
  } as unknown as Bun.Subprocess;

  return {
    subprocess,
    sendJson(message): void {
      stdoutController?.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
    },
    exit(code = 17): void {
      exitCode = code;
      resolveExited?.(code);
      stdoutController?.close();
    },
  };
}

describe("MeshAcpGateway", () => {
  let gateway: MeshAcpGateway | undefined;

  afterEach(async () => {
    await gateway?.close("session-1");
    gateway = undefined;
  });

  test("relays bidirectional JSON-RPC frames and cleans up on process exit", async () => {
    const controlled = createControlledProcess();
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue(controlled.subprocess);
    const configSpy = spyOn(meshExecutionGateway, "getAcpSessionConfig").mockResolvedValue({
      sessionId: "session-1",
      sessionToken: "token",
      provider: "opencode",
      directory: process.cwd(),
      expiresAt: Date.now() + 30_000,
    });
    const sent: string[] = [];
    const socket = {
      send(data: string): void {
        sent.push(data);
      },
      close(): void {},
    };
    gateway = new MeshAcpGateway();

    try {
      await gateway.open(socket, "session-1", "token");
      await gateway.message("session-1", JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }));
      expect((controlled.subprocess.stdin as unknown as { writes: string[] }).writes).toHaveLength(1);

      controlled.sendJson({ jsonrpc: "2.0", id: 1, result: { ok: true } });
      await Bun.sleep(0);
      expect(sent).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"ok":true}}']);

      controlled.exit();
      await Bun.sleep(0);
      await expect(gateway.message("session-1", "{}")).rejects.toMatchObject({
        code: "mesh_acp_unavailable",
      });
      expect(configSpy).toHaveBeenCalledWith("session-1", "token");
    } finally {
      configSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  test("rejects malformed inbound and outbound protocol frames", async () => {
    const controlled = createControlledProcess();
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue(controlled.subprocess);
    const configSpy = spyOn(meshExecutionGateway, "getAcpSessionConfig").mockResolvedValue({
      sessionId: "session-1",
      sessionToken: "token",
      provider: "opencode",
      directory: process.cwd(),
      expiresAt: Date.now() + 30_000,
    });
    let closeCount = 0;
    const socket = { send(): void {}, close(): void { closeCount += 1; } };
    gateway = new MeshAcpGateway();

    try {
      await gateway.open(socket, "session-1", "token");
      await expect(gateway.message("session-1", JSON.stringify({ method: "not-json-rpc" })))
        .rejects.toMatchObject({ code: "mesh_acp_message_invalid" });
      controlled.sendJson({ jsonrpc: "1.0", id: 1, result: {} });
      await Bun.sleep(0);
      expect(closeCount).toBe(0);
    } finally {
      configSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });
});
