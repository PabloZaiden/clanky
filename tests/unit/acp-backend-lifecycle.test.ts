import { afterEach, describe, expect, test } from "bun:test";

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
});
