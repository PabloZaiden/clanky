import { resolveCliAuth, type ResolveCliAuthOptions } from "./auth-resolution";
import type { CliCommandResult } from "./runtime";
import { realtimeClientMessageSchema, realtimeServerMessageSchema } from "@pablozaiden/webapp/contracts";

export interface CliInput extends AsyncIterable<string | Uint8Array> {}

export interface CliOutput {
  write(chunk: string): unknown;
}

export interface CliWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void, options?: { once?: boolean }): void;
  addEventListener(type: "error", listener: () => void, options?: { once?: boolean }): void;
}

export type CliWebSocketFactory = (
  url: string,
  options: { headers: Headers },
) => CliWebSocket;

export interface CliSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}

export interface WebSocketCliCommandOptions extends ResolveCliAuthOptions {
  realtimePath: string;
  input: CliInput;
  output: CliOutput;
  createWebSocket?: CliWebSocketFactory;
  signals?: CliSignalSource;
}

function websocketUrl(baseUrl: string, path: string): string {
  const url = new URL(path, `${baseUrl.replace(/\/+$/, "")}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function defaultWebSocketFactory(url: string, options: { headers: Headers }): CliWebSocket {
  const WebSocketClient = WebSocket as unknown as {
    new (target: string, options: Bun.WebSocketOptions): WebSocket;
  };
  return new WebSocketClient(url, {
    headers: Object.fromEntries(options.headers.entries()),
  }) as unknown as CliWebSocket;
}

function defaultSignals(): CliSignalSource {
  return {
    on: (signal, listener) => process.on(signal, listener),
    off: (signal, listener) => process.off(signal, listener),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runWebSocketCliCommand(
  input: WebSocketCliCommandOptions,
): Promise<CliCommandResult> {
  const auth = await resolveCliAuth(input);
  if (auth.source === "anonymous" || !auth.baseUrl) {
    return {
      exitCode: 1,
      error: "No authenticated CLI instance is configured",
    };
  }

  const headers = new Headers(auth.headers);
  headers.set("origin", new URL(auth.baseUrl).origin);
  const socket = (input.createWebSocket ?? defaultWebSocketFactory)(
    websocketUrl(auth.baseUrl, input.realtimePath),
    { headers },
  );
  const signals = input.signals ?? defaultSignals();
  const iterator = input.input[Symbol.asyncIterator]();

  return await new Promise<CliCommandResult>((resolve) => {
    let settled = false;
    let closingCleanly = false;

    const cleanup = () => {
      signals.off("SIGINT", onSignal);
      signals.off("SIGTERM", onSignal);
      void iterator.return?.();
    };
    const finish = (result: CliCommandResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const closeWithError = (message: string) => {
      finish({ exitCode: 1, error: message });
      try {
        socket.close(1003, "invalid websocket input");
      } catch {
        // The original error is the command result.
      }
    };
    const onSignal = () => {
      closingCleanly = true;
      socket.close(1000, "signal");
    };

    signals.on("SIGINT", onSignal);
    signals.on("SIGTERM", onSignal);

    socket.addEventListener("message", (event) => {
      if (settled) return;
      if (typeof event.data !== "string") {
        closeWithError("Received a non-text WebSocket frame");
        return;
      }
      try {
        realtimeServerMessageSchema.parse(JSON.parse(event.data));
        input.output.write(`${event.data}\n`);
      } catch (error) {
        closeWithError(`Unable to write WebSocket output: ${errorMessage(error)}`);
      }
    });
    socket.addEventListener("error", () => {
      finish({ exitCode: 1, error: "WebSocket connection failed" });
      try {
        socket.close(1011, "websocket error");
      } catch {
        // The connection error is already reported.
      }
    }, { once: true });
    socket.addEventListener("close", (event) => {
      if (settled) return;
      if (closingCleanly || event.code === 1000 || event.code === 1001) {
        finish({ exitCode: 0 });
        return;
      }
      finish({
        exitCode: 1,
        error: `WebSocket closed abnormally (${String(event.code)}${event.reason ? `: ${event.reason}` : ""})`,
      });
    }, { once: true });
    socket.addEventListener("open", () => {
      void (async () => {
        const decoder = new TextDecoder();
        let pending = "";
        try {
          while (!settled) {
            const next = await iterator.next();
            if (next.done) break;
            pending += typeof next.value === "string"
              ? next.value
              : decoder.decode(next.value, { stream: true });
            let newline = pending.indexOf("\n");
            while (newline >= 0) {
              const line = pending.slice(0, newline).replace(/\r$/, "");
              pending = pending.slice(newline + 1);
              if (line) {
                realtimeClientMessageSchema.parse(JSON.parse(line));
                socket.send(line);
              }
              newline = pending.indexOf("\n");
            }
          }
          pending += decoder.decode();
          const finalLine = pending.replace(/\r$/, "");
          if (finalLine) {
            realtimeClientMessageSchema.parse(JSON.parse(finalLine));
            socket.send(finalLine);
          }
          if (!settled) {
            closingCleanly = true;
            socket.close(1000, "stdin closed");
          }
        } catch (error) {
          closeWithError(`Unable to process WebSocket input: ${errorMessage(error)}`);
        }
      })();
    }, { once: true });
  });
}
