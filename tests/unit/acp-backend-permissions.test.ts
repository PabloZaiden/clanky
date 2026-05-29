import { describe, expect, test } from "bun:test";
import { AcpBackend } from "../../src/backends/acp/acp-backend";
import type { AgentEvent } from "../../src/backends/types";
import type { JsonRpcMessage } from "../../src/backends/acp/types";

type TestableAcpBackend = {
  connected: boolean;
  process: object;
  handleRpcMessage(message: JsonRpcMessage): void;
  writeRpcMessage(message: JsonRpcMessage): void;
};

describe("AcpBackend permission responses", () => {
  test("replies to permission requests that use string JSON-RPC ids", async () => {
    const backend = new AcpBackend();
    const testBackend = backend as unknown as TestableAcpBackend;
    const writtenMessages: JsonRpcMessage[] = [];

    testBackend.connected = true;
    testBackend.process = {};
    testBackend.writeRpcMessage = (message: JsonRpcMessage): void => {
      writtenMessages.push(message);
    };

    const stream = await backend.subscribeToEvents("session-1");

    testBackend.handleRpcMessage({
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

    await backend.replyToPermission(event.requestId, "always");

    expect(writtenMessages).toEqual([
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
});
