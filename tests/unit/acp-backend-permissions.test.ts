import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../../src/backends/types";
import type { JsonRpcMessage } from "../../src/backends/acp/types";
import type { RpcRequester } from "../../src/backends/acp/contracts";
import { SessionStateStore } from "../../src/backends/acp/session-state";
import { SubscriptionService } from "../../src/backends/acp/subscription-service";
import { PermissionCoordinator } from "../../src/backends/acp/permission-coordinator";
import { AcpError } from "../../src/backends/acp/errors";

function createRequester(overrides: {
  sendRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
} = {}): {
  requester: RpcRequester;
  written: JsonRpcMessage[];
} {
  const written: JsonRpcMessage[] = [];
  const requester: RpcRequester = {
    async sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
      if (overrides.sendRequest) {
        return (await overrides.sendRequest(method, params)) as T;
      }
      return undefined as T;
    },
    writeMessage(message: JsonRpcMessage): void {
      written.push(message);
    },
  };
  return { requester, written };
}

describe("PermissionCoordinator", () => {
  test("abortAll closes active event streams", async () => {
    const state = new SessionStateStore();
    const subscriptions = new SubscriptionService(state);
    const stream = subscriptions.subscribe("session-1");
    const pending = stream.next();

    subscriptions.abortAll();

    await expect(pending).resolves.toBeNull();
    await expect(stream.next()).resolves.toBeNull();
  });

  test("replies to permission requests that use string JSON-RPC ids", async () => {
    const state = new SessionStateStore();
    const subscriptions = new SubscriptionService(state);
    const { requester, written } = createRequester();
    const permissions = new PermissionCoordinator(requester, state);

    const stream = subscriptions.subscribe("session-1");

    permissions.handleRequestPermission({
      jsonrpc: "2.0",
      id: "codex-permission-1",
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: {
          kind: "execute",
          title: "Execute shell command",
          rawInput: {
            command: "touch index.html",
          },
        },
        options: [
          { optionId: "deny", kind: "reject_once" },
          { optionId: "allow", kind: "allow_once" },
        ],
      },
    });

    const event = await stream.next();
    expect(event).toMatchObject({
      type: "permission.asked",
      sessionId: "session-1",
      permission: "execute",
      patterns: ["touch index.html"],
    } satisfies Partial<AgentEvent>);

    if (!event || event.type !== "permission.asked") {
      throw new Error("Expected permission.asked event");
    }

    await permissions.replyToPermission(event.requestId, "always");

    expect(written).toEqual([
      {
        jsonrpc: "2.0",
        id: "codex-permission-1",
        result: {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        },
      },
    ]);
  });

  test("falls back to legacy reply methods and stops at the first supported one", async () => {
    const state = new SessionStateStore();
    const attempted: string[] = [];
    const { requester } = createRequester({
      async sendRequest(method: string): Promise<unknown> {
        attempted.push(method);
        if (method === "session/reply_permission") {
          throw new AcpError("acp_method_not_found", "Method not found");
        }
        return {};
      },
    });
    const permissions = new PermissionCoordinator(requester, state);

    await permissions.replyToPermission("unknown-request", "allow");

    expect(attempted).toEqual(["session/reply_permission", "session/permission_reply"]);
  });

  test("propagates non method-not-found failures from legacy reply attempts", async () => {
    const state = new SessionStateStore();
    const { requester } = createRequester({
      async sendRequest(): Promise<unknown> {
        throw new AcpError("acp_request_timed_out", "timed out");
      },
    });
    const permissions = new PermissionCoordinator(requester, state);

    await expect(permissions.replyToPermission("unknown-request", "allow")).rejects.toMatchObject({
      code: "acp_request_timed_out",
    });
  });

  test("clearAll discards pending permission requests so replies fall back to legacy methods", async () => {
    const state = new SessionStateStore();
    const attempted: string[] = [];
    const { requester } = createRequester({
      async sendRequest(method: string): Promise<unknown> {
        attempted.push(method);
        return {};
      },
    });
    const permissions = new PermissionCoordinator(requester, state);

    permissions.handleRequestPermission({
      jsonrpc: "2.0",
      id: "req-1",
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        options: [{ optionId: "allow", kind: "allow_once" }],
      },
    });

    permissions.clearAll();

    await permissions.replyToPermission("req-1", "allow");
    expect(attempted).toEqual(["session/reply_permission"]);
  });

  test("clears session-owned permission requests and subscriptions", async () => {
    const state = new SessionStateStore();
    const subscriptions = new SubscriptionService(state);
    const { requester, written } = createRequester();
    const permissions = new PermissionCoordinator(requester, state);
    const stream = subscriptions.subscribe("session-1");

    permissions.handleRequestPermission({
      jsonrpc: "2.0",
      id: "req-1",
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        options: [{ optionId: "allow", kind: "allow_once" }],
      },
    });

    subscriptions.clearSession("session-1");
    permissions.clearSession("session-1");

    await permissions.replyToPermission("req-1", "allow");
    expect(written).toEqual([]);
    await expect(stream.next()).resolves.toBeNull();
  });
});
