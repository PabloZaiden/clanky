import { describe, expect, test } from "bun:test";
import { RpcClient } from "../../src/backends/acp/rpc-client";
import type { JsonRpcMessage } from "../../src/backends/acp/types";
import type { RpcTransport } from "../../src/backends/acp/contracts";
import { AcpError } from "../../src/backends/acp/errors";

function createClient(options: {
  writable?: boolean;
  onWrite?: (message: JsonRpcMessage) => void;
} = {}): {
  client: RpcClient;
  written: JsonRpcMessage[];
  notifications: JsonRpcMessage[];
} {
  const written: JsonRpcMessage[] = [];
  const notifications: JsonRpcMessage[] = [];
  const transport: RpcTransport = {
    write(message: JsonRpcMessage): void {
      options.onWrite?.(message);
      written.push(message);
    },
    isWritable: () => options.writable ?? true,
  };
  const client = new RpcClient({
    transport,
    ensureUsable: () => {},
    onNotification: (message) => notifications.push(message),
  });
  return { client, written, notifications };
}

describe("RpcClient", () => {
  test("correlates a numeric-id response and resolves the request", async () => {
    const { client, written } = createClient();
    const promise = client.sendRequest<{ ok: boolean }>("session/new", { cwd: "/repo" });

    expect(written).toHaveLength(1);
    const id = written[0]!.id;
    expect(typeof id).toBe("number");

    client.handleMessage({ jsonrpc: "2.0", id, result: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  test("preserves the JSON-RPC error code when a request fails", async () => {
    const { client, written } = createClient();
    const promise = client.sendRequest("session/set_config_option", {});
    const id = written[0]!.id;

    client.handleMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    });

    await expect(promise).rejects.toMatchObject({ code: "acp_method_not_found" });
  });

  test("routes inbound string-id method messages to the notification sink", async () => {
    const { client, notifications } = createClient();

    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: "codex-permission-1",
      method: "session/request_permission",
      params: { sessionId: "s1" },
    };
    client.handleMessage(message);

    expect(notifications).toEqual([message]);
  });

  test("ignores a response for an unknown id without throwing", () => {
    const { client } = createClient();
    expect(() => client.handleMessage({ jsonrpc: "2.0", id: 999, result: {} })).not.toThrow();
  });

  test("rejects with a typed timeout error and clears pending state", async () => {
    const { client, written } = createClient();
    const promise = client.sendRequest("session/prompt", {}, 5);

    await expect(promise).rejects.toMatchObject({ code: "acp_request_timed_out" });

    // A late response for the timed-out id must not throw or resolve anything.
    const id = written[0]!.id;
    expect(() => client.handleMessage({ jsonrpc: "2.0", id, result: {} })).not.toThrow();
  });

  test("rejects and clears pending state when the transport write fails", async () => {
    const { client } = createClient({
      onWrite: () => {
        throw new Error("stdin closed");
      },
    });

    await expect(client.sendRequest("initialize", {})).rejects.toThrow("stdin closed");
  });

  test("rejectPending fails every in-flight request with the provided error", async () => {
    const { client } = createClient();
    const first = client.sendRequest("session/prompt", {}).catch((error: unknown) => error);
    const second = client.sendRequest("session/prompt", {}).catch((error: unknown) => error);

    client.rejectPending(new AcpError("acp_process_failed", "Disconnected"));

    expect(await first).toMatchObject({ code: "acp_process_failed" });
    expect(await second).toMatchObject({ code: "acp_process_failed" });
  });
});
