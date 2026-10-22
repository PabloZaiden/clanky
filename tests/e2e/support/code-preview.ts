/**
 * User journey through the compiled CLI, IDE preview and host process lifecycle.
 */

import { expect } from "bun:test";
import { join } from "node:path";
import { compiledClankyCommand } from "./mesh-cluster";
import { pollUntil } from "./polling";
import {
  currentEnvironment,
  readProcessDiagnostics,
  startManagedProcess,
  stopManagedProcess,
} from "./process";
import { LIFECYCLE_TIMEOUT_MS, OPERATION_TIMEOUT_MS } from "./timeouts";

async function exerciseIdeConnection(url: string, timeoutMs: number): Promise<void> {
  const socket = new WebSocket(url.replace("http:", "ws:"));
  socket.binaryType = "arraybuffer";
  let reply: Uint8Array | undefined;
  let failure: Error | undefined;
  socket.onmessage = (event: MessageEvent) => {
    if (event.data instanceof ArrayBuffer) reply = new Uint8Array(event.data);
    else failure = new Error("IDE protocol did not return binary data");
  };
  socket.onerror = () => { failure = new Error("IDE protocol connection failed"); };
  socket.onclose = () => { failure = new Error("IDE protocol connection closed"); };
  try {
    await pollUntil(() => {
      if (failure) throw failure;
      return socket.readyState;
    }, (state) => state === WebSocket.OPEN, {
      description: "IDE protocol connection", timeoutMs,
    });
    const message = new Uint8Array([0, 1, 2, 127, 128, 255]);
    socket.send(message);
    const received = await pollUntil(() => {
      if (failure) throw failure;
      return reply;
    }, (value) => value !== undefined, {
      description: "IDE protocol response", timeoutMs,
    });
    expect(received).toEqual(message);
  } finally {
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
  }
}

async function closePreviewViaApi(options: {
  baseUrl: string;
  apiKey: string;
  workspaceId: string;
  localUrl: string;
  timeoutMs: number;
}): Promise<void> {
  const previews = await fetch(`${options.baseUrl}/api/workspaces/${encodeURIComponent(options.workspaceId)}/previews`, {
    headers: { authorization: `Bearer ${options.apiKey}` },
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  expect(previews.status).toBe(200);
  const active = await previews.json() as Array<{ config: { id: string; localUrl: string } }>;
  const preview = active.find((item) => item.config.localUrl === options.localUrl);
  if (!preview) throw new Error("IDE preview is not available to close");
  const closed = await fetch(`${options.baseUrl}/api/previews/${encodeURIComponent(preview.config.id)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${options.apiKey}` },
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  expect(closed.status).toBe(200);
}

export async function exerciseCodePreview(options: {
  baseUrl: string;
  apiKey: string;
  homeDirectory: string;
  logsDirectory: string;
  workspace: string;
  workspaceId?: string;
  expectedDirectory: string;
  selector?: { chat: string } | { task: string };
  timeoutMs?: number;
  restartController?: () => Promise<string>;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? LIFECYCLE_TIMEOUT_MS;
  const operationTimeoutMs = options.timeoutMs ?? OPERATION_TIMEOUT_MS;
  let baseUrl = options.baseUrl;
  const selector = options.selector
    ? "chat" in options.selector
      ? ["--chat", options.selector.chat]
      : ["--task", options.selector.task]
    : [];
  const name = `code-${crypto.randomUUID()}`;
  const cli = startManagedProcess([
    ...await compiledClankyCommand(), "code", options.workspace,
    ...selector,
  ], {
    cwd: options.homeDirectory,
    env: currentEnvironment({
      HOME: options.homeDirectory,
      CLANKY_BASE_URL: options.baseUrl,
      CLANKY_API_KEY: options.apiKey,
    }),
    stdoutPath: join(options.logsDirectory, `${name}.stdout.log`),
    stderrPath: join(options.logsDirectory, `${name}.stderr.log`),
  });
  try {
    const readyUrl = await pollUntil(async () => {
      if (cli.child.exitCode !== null) throw new Error(await readProcessDiagnostics(cli));
      return /VS Code ready: (http:\/\/[^\s]+)/.exec(await Bun.file(cli.stdoutPath).text())?.[1];
    }, (value) => value !== undefined, {
      description: "VS Code preview availability",
      timeoutMs,
      formatLastObserved: () => `CLI exit=${String(cli.child.exitCode)}`,
    });
    const url = new URL(readyUrl!);
    url.hostname = "localhost";
    const page = await fetch(url, { signal: AbortSignal.timeout(operationTimeoutMs) });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(options.expectedDirectory);
    const remotePort = /Remote target: 127\.0\.0\.1:(\d+)/.exec(await Bun.file(cli.stdoutPath).text())?.[1];
    if (!remotePort) throw new Error("IDE did not report its execution-host listener");

    await exerciseIdeConnection(url.href, operationTimeoutMs);

    if (options.restartController) {
      baseUrl = await options.restartController();
      const previews = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(options.workspaceId ?? options.workspace)}/previews`, {
        headers: { authorization: `Bearer ${options.apiKey}` },
        signal: AbortSignal.timeout(operationTimeoutMs),
      });
      expect(previews.status).toBe(200);
      expect(await previews.json()).toEqual([]);
    } else if (process.platform === "win32") {
      // Bun.kill cannot deliver a console Ctrl+C event on Windows.
      await closePreviewViaApi({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        workspaceId: options.workspaceId ?? options.workspace,
        localUrl: readyUrl!,
        timeoutMs,
      });
    } else {
      cli.child.kill("SIGINT");
    }
    await pollUntil(() => cli.child.exitCode, (code) => code !== null, {
      description: "VS Code command shutdown",
      timeoutMs,
    });
    if (!options.restartController) expect(cli.child.exitCode).toBe(0);
    await expect(fetch(url, { signal: AbortSignal.timeout(operationTimeoutMs) })).rejects.toThrow();
    const closed = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(options.workspaceId ?? options.workspace)}/exec`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(operationTimeoutMs),
      body: JSON.stringify({
        command: process.execPath,
        args: ["-e", [
          'try { const response = await fetch(process.argv[1], { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); console.log("running"); }',
          'catch (error) { if (!["ConnectionRefused", "ECONNREFUSED"].includes(error.code)) throw error; console.log("closed"); }',
        ].join("\n"), `http://127.0.0.1:${remotePort}/`],
        timeoutMs: operationTimeoutMs,
      }),
    });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ success: true, stdout: "closed\n" });
  } catch (error) {
    console.error(await readProcessDiagnostics(cli));
    throw error;
  } finally {
    await stopManagedProcess(cli);
  }
}
