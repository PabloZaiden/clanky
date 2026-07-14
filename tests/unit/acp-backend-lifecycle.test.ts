import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { AcpBackend } from "../../src/backends/acp/acp-backend";

const directory = process.cwd();

function buildConnectionConfig(script: string) {
  return {
    mode: "spawn" as const,
    provider: "opencode" as const,
    transport: "stdio" as const,
    directory,
    command: process.execPath,
    args: ["-e", script],
  };
}

function buildPromptRuntimeScript(): string {
  return [
    "const readline = require('node:readline');",
    "const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
    "const reader = readline.createInterface({ input: process.stdin });",
    "reader.on('line', (line) => {",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') write({ jsonrpc: '2.0', id: message.id, result: {} });",
    "  if (message.method === 'session/new') write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session-1', cwd: message.params.cwd } });",
    "  if (message.method === 'session/prompt') process.exit(17);",
    "});",
  ].join("\n");
}

type ControlledProcess = {
  subprocess: Bun.Subprocess;
  sendRaw: (value: string) => void;
  sendJson: (message: Record<string, unknown>) => void;
  closeStreams: () => void;
};

function createControlledProcess(): ControlledProcess {
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let resolveExited: ((exitCode: number) => void) | undefined;
  let exitCode: number | null = null;
  let streamsClosed = false;
  const encoder = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
    },
  });
  const sendRaw = (value: string): void => {
    if (!stdoutController) {
      throw new Error("Controlled stdout is not ready");
    }
    stdoutController.enqueue(encoder.encode(value));
  };
  const sendJson = (message: Record<string, unknown>): void => {
    sendRaw(`${JSON.stringify(message)}\n`);
  };
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  const stdin = {
    write(value: string): void {
      const message = JSON.parse(value) as { id?: number; method?: string };
      if (message.method === "initialize" && message.id !== undefined) {
        sendJson({
          jsonrpc: "2.0",
          id: message.id,
          result: {},
        });
      }
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
      if (exitCode !== null) {
        return;
      }
      exitCode = 0;
      resolveExited?.(0);
    },
  } as unknown as Bun.Subprocess;

  return {
    subprocess,
    sendRaw,
    sendJson,
    closeStreams: (): void => {
      if (streamsClosed) {
        return;
      }
      streamsClosed = true;
      stdoutController?.close();
      stderrController?.close();
    },
  };
}

describe("AcpBackend lifecycle", () => {
  let backend: AcpBackend | undefined;

  afterEach(async () => {
    await backend?.disconnect();
    backend = undefined;
  });

  test("surfaces an ACP process exit to active prompt subscribers before closing", async () => {
    backend = new AcpBackend();
    await backend.connect(buildConnectionConfig(buildPromptRuntimeScript()));

    const session = await backend.createSession({ directory });
    const stream = await backend.subscribeToEvents(session.id);
    await backend.sendPromptAsync(session.id, {
      parts: [{ type: "text", text: "trigger process exit" }],
    });

    await expect(stream.next()).resolves.toMatchObject({
      type: "error",
      code: "acp_process_failed",
    });
    await expect(stream.next()).resolves.toBeNull();
  });

  test("cleans connection metadata after initialization process failure", async () => {
    backend = new AcpBackend();

    await expect(
      backend.connect(buildConnectionConfig("process.exit(17);")),
    ).rejects.toMatchObject({ code: "acp_process_failed" });

    expect(backend.isConnected()).toBe(false);
    expect(backend.getDirectory()).toBe("");
    expect(backend.getConnectionInfo()).toBeNull();
    expect(backend.getSdkClient()).toBeNull();
  });

  test("ignores buffered output from a replaced process", async () => {
    const firstProcess = createControlledProcess();
    const secondProcess = createControlledProcess();
    const processes = [firstProcess, secondProcess];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
      const nextProcess = processes.shift();
      if (!nextProcess) {
        throw new Error("Unexpected extra ACP process");
      }
      return nextProcess.subprocess;
    });

    try {
      backend = new AcpBackend();
      await backend.connect(buildConnectionConfig("controlled"));
      await backend.disconnect();
      await backend.connect(buildConnectionConfig("controlled"));

      const sessionPromise = backend.createSession({ directory });
      firstProcess.sendRaw(JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: { sessionId: "stale-session", cwd: directory },
      }));
      firstProcess.closeStreams();
      await new Promise<void>((resolve) => setImmediate(resolve));

      secondProcess.sendJson({
        jsonrpc: "2.0",
        id: 3,
        result: { sessionId: "fresh-session", cwd: directory },
      });

      await expect(sessionPromise).resolves.toMatchObject({ id: "fresh-session" });
    } finally {
      spawnSpy.mockRestore();
      firstProcess.closeStreams();
      secondProcess.closeStreams();
    }
  });
});
