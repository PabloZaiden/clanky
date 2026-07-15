import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../../src/backends/types";
import type { JsonRpcMessage } from "../../src/backends/acp/types";
import type { RpcRequester } from "../../src/backends/acp/contracts";
import { SessionStateStore } from "../../src/backends/acp/session-state";
import { SubscriptionService } from "../../src/backends/acp/subscription-service";
import { PermissionCoordinator } from "../../src/backends/acp/permission-coordinator";

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

  test("clearAll discards pending permission requests and subsequent replies are no-ops", async () => {
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
    expect(attempted).toEqual([]);
  });

  test("reply to unknown request id is a no-op without making an rpc call", async () => {
    const state = new SessionStateStore();
    const attempted: string[] = [];
    const { requester } = createRequester({
      async sendRequest(method: string): Promise<unknown> {
        attempted.push(method);
        return {};
      },
    });
    const permissions = new PermissionCoordinator(requester, state);

    await permissions.replyToPermission("completely-unknown-id", "allow");
    expect(attempted).toEqual([]);
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

  test("replyToQuestion sends only session/reply_question", async () => {
    const state = new SessionStateStore();
    const attempted: string[] = [];
    const { requester } = createRequester({
      async sendRequest(method: string): Promise<unknown> {
        attempted.push(method);
        return {};
      },
    });
    const permissions = new PermissionCoordinator(requester, state);

    await permissions.replyToQuestion("req-q1", [["option-a"]]);
    expect(attempted).toEqual(["session/reply_question"]);
  });
});
