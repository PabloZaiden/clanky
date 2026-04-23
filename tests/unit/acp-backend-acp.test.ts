import { describe, expect, test } from "bun:test";

import { AcpBackend } from "../../src/backends/acp";

type PrivateBackend = {
  handleRpcMessage(message: unknown): void;
  parseModelsFromSessionResult(result: unknown): unknown;
  buildPromptParams(sessionId: string, prompt: {
    parts: Array<
      | { type: "text"; text: string }
      | { type: "image"; mimeType: string; data: string }
    >;
    model?: { providerID: string; modelID: string; variant?: string };
  }): Record<string, unknown>;
  sessionSubscribers: Map<string, Set<(event: unknown) => void>>;
  pendingPermissionRequests: Map<string, { rpcId: number; options: Array<{ optionId: string; kind?: string }> }>;
  toolCallNames: Map<string, string>;
  sessionPromptSequences: Map<string, number>;
  sessionPromptHasActivity: Map<string, boolean>;
  sessionIgnoreStatusUntilActivity: Set<string>;
  sessionReasoningPartKeys: Map<string, string>;
  connected: boolean;
  process: { stdin: { write: (line: string) => void } } | null;
  replyToPermission(requestId: string, response: string): Promise<void>;
  abortSession(sessionId: string): Promise<void>;
  sendRpcRequest<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  sendPromptAsync(
    sessionId: string,
    prompt: {
      parts: Array<
        | { type: "text"; text: string }
        | { type: "image"; mimeType: string; data: string }
      >;
    },
  ): Promise<void>;
};

function getBackend(): PrivateBackend {
  return new AcpBackend() as unknown as PrivateBackend;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  return {
    promise,
    resolve: resolveFn,
    reject: rejectFn,
  };
}

describe("AcpBackend ACP parsing", () => {
  test("handles session/request_permission JSON-RPC requests with id", () => {
    const backend = getBackend();
    const sessionId = "session-1";
    const events: Array<Record<string, unknown>> = [];

    backend.sessionSubscribers.set(
      sessionId,
      new Set([
        (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      ]),
    );

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: {
          toolCallId: "shell-permission",
          kind: "execute",
          rawInput: { command: "pwd", commands: ["pwd"] },
        },
        options: [
          { optionId: "allow_once", kind: "allow_once" },
          { optionId: "allow_always", kind: "allow_always" },
        ],
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "permission.asked",
      sessionId,
      permission: "execute",
      patterns: ["pwd"],
    });

    const requestId = events[0]!["requestId"] as string;
    const pendingRequest = backend.pendingPermissionRequests.get(requestId);
    expect(pendingRequest).toEqual({
      rpcId: 0,
      options: [
        { optionId: "allow_once", kind: "allow_once" },
        { optionId: "allow_always", kind: "allow_always" },
      ],
    });
  });

  test("parses Copilot tool_call and tool_call_update payload shapes", () => {
    const backend = getBackend();
    const sessionId = "session-2";
    const events: Array<Record<string, unknown>> = [];

    backend.sessionSubscribers.set(
      sessionId,
      new Set([
        (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      ]),
    );

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          kind: "execute",
          rawInput: { command: "pwd" },
        },
      },
    });

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          rawOutput: { content: "/tmp" },
        },
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "tool.start",
      toolName: "execute",
      input: { command: "pwd" },
    });
    expect(events[1]).toEqual({
      type: "tool.complete",
      toolName: "execute",
      input: undefined,
      output: { content: "/tmp" },
    });
    expect(backend.toolCallNames.has("call-1")).toBe(false);
  });

  test("maps failed tool_call_update to tool.complete (non-fatal)", () => {
    const backend = getBackend();
    const sessionId = "session-2b";
    const events: Array<Record<string, unknown>> = [];

    backend.sessionSubscribers.set(
      sessionId,
      new Set([
        (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      ]),
    );

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-fail-1",
          kind: "read",
          rawInput: { path: "/tmp/missing.txt" },
        },
      },
    });

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-fail-1",
          status: "failed",
          rawOutput: { message: "file not found" },
        },
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "tool.start",
      toolName: "read",
    });
    expect(events[1]).toEqual({
      type: "tool.complete",
      toolName: "read",
      input: undefined,
      output: {
        message: "file not found",
        status: "failed",
        error: "file not found",
      },
    });
  });

  test("prefers completed rawInput from tool_call_update", () => {
    const backend = getBackend();
    const sessionId = "session-completed-input";
    const events: Array<Record<string, unknown>> = [];

    backend.sessionSubscribers.set(
      sessionId,
      new Set([
        (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      ]),
    );

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-read-1",
          kind: "read",
          rawInput: {},
        },
      },
    });

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-read-1",
          status: "completed",
          kind: "read",
          rawInput: { filePath: "/tmp/file.txt", offset: 1, limit: 20 },
          rawOutput: { output: "file contents" },
        },
      },
    });

    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: "tool.complete",
      toolName: "read",
      input: { filePath: "/tmp/file.txt", offset: 1, limit: 20 },
      output: { output: "file contents" },
    });
  });

  test("adds a line break between distinct reasoning parts", () => {
    const backend = getBackend();
    const sessionId = "session-reasoning-parts";
    const events: Array<Record<string, unknown>> = [];

    backend.sessionSubscribers.set(
      sessionId,
      new Set([
        (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      ]),
    );

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: {
            partId: "part-1",
            text: "First reasoning part.",
          },
        },
      },
    });

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: {
            partId: "part-2",
            text: "Second reasoning part.",
          },
        },
      },
    });

    expect(events).toEqual([
      {
        type: "reasoning.delta",
        content: "First reasoning part.",
      },
      {
        type: "reasoning.delta",
        content: "\nSecond reasoning part.",
      },
    ]);
  });

  test("does not add a line break when reasoning chunks belong to the same part", () => {
    const backend = getBackend();
    const sessionId = "session-reasoning-same-part";
    const events: Array<Record<string, unknown>> = [];

    backend.sessionSubscribers.set(
      sessionId,
      new Set([
        (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      ]),
    );

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: {
            partId: "part-1",
            text: "Chunk one",
          },
        },
      },
    });

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: {
            partId: "part-1",
            text: " chunk two",
          },
        },
      },
    });

    expect(events).toEqual([
      {
        type: "reasoning.delta",
        content: "Chunk one",
      },
      {
        type: "reasoning.delta",
        content: " chunk two",
      },
    ]);
    expect(backend.sessionReasoningPartKeys.get(sessionId)).toBe("id:part-1");
  });

  test("suppresses duplicate agent_thought_chunk notifications for the same part and text", () => {
    const backend = getBackend();
    const sessionId = "session-reasoning-duplicate";
    const events: Array<Record<string, unknown>> = [];

    backend.sessionSubscribers.set(
      sessionId,
      new Set([
        (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      ]),
    );

    const duplicateMessage = {
      jsonrpc: "2.0" as const,
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: {
            partId: "part-dup",
            text: "Inspecting repository",
          },
        },
      },
    };

    backend.handleRpcMessage(duplicateMessage);
    backend.handleRpcMessage(duplicateMessage);

    expect(events).toEqual([
      {
        type: "reasoning.delta",
        content: "Inspecting repository",
      },
    ]);
  });

  test("parses model lists from availableModels shape", () => {
    const backend = getBackend();
    const parsed = backend.parseModelsFromSessionResult({
      models: {
        availableModels: [
          { modelId: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
          { modelId: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
        ],
      },
    }) as Array<Record<string, unknown>>;

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      modelID: "gpt-5.3-codex",
      modelName: "GPT-5.3-Codex",
    });
    expect(parsed[1]).toMatchObject({
      modelID: "claude-sonnet-4.6",
      modelName: "Claude Sonnet 4.6",
    });
  });

  test("replyToPermission responds to pending JSON-RPC permission request", async () => {
    const backend = getBackend();
    const writes: string[] = [];

    backend.connected = true;
    backend.process = {
      stdin: {
        write: (line: string) => {
          writes.push(line);
        },
      },
    };
    backend.pendingPermissionRequests.set("request-1", {
      rpcId: 0,
      options: [
        { optionId: "allow_once", kind: "allow_once" },
        { optionId: "allow_always", kind: "allow_always" },
      ],
    });

    await backend.replyToPermission("request-1", "always");

    expect(backend.pendingPermissionRequests.has("request-1")).toBe(false);
    expect(writes).toHaveLength(1);

    const message = JSON.parse(writes[0]!);
    expect(message).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: {
        outcome: {
          outcome: "selected",
          optionId: "allow_always",
        },
      },
    });
  });

  test("emits message.complete when session becomes idle after prompt activity", () => {
    const backend = getBackend();
    const sessionId = "session-idle-complete";
    const events: Array<Record<string, unknown>> = [];

    backend.sessionSubscribers.set(
      sessionId,
      new Set([
        (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      ]),
    );
    backend.sessionPromptSequences.set(sessionId, 1);

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/status",
      params: {
        sessionId,
        status: "busy",
      },
    });

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/status",
      params: {
        sessionId,
        status: "idle",
      },
    });

    expect(events).toEqual([
      {
        type: "session.status",
        sessionId,
        status: "busy",
        attempt: undefined,
        message: undefined,
      },
      {
        type: "session.status",
        sessionId,
        status: "idle",
        attempt: undefined,
        message: undefined,
      },
      {
        type: "message.complete",
        content: "",
      },
    ]);
    expect(backend.sessionPromptSequences.has(sessionId)).toBe(false);
  });

  test("does not emit message.complete for idle status before prompt activity", () => {
    const backend = getBackend();
    const sessionId = "session-idle-no-activity";
    const events: Array<Record<string, unknown>> = [];

    backend.sessionSubscribers.set(
      sessionId,
      new Set([
        (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      ]),
    );
    backend.sessionPromptSequences.set(sessionId, 1);

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/status",
      params: {
        sessionId,
        status: "idle",
      },
    });

    expect(events).toEqual([
      {
        type: "session.status",
        sessionId,
        status: "idle",
        attempt: undefined,
        message: undefined,
      },
    ]);
    expect(backend.sessionPromptSequences.has(sessionId)).toBe(true);
  });

  test("ignores stale idle completion after abort until fresh prompt activity arrives", async () => {
    const backend = getBackend();
    const sessionId = "session-ignore-stale-idle";
    const events: Array<Record<string, unknown>> = [];

    backend.connected = true;
    backend.process = {
      stdin: {
        write: () => {
          // no-op
        },
      },
    };

    const originalSendRpcRequest = backend.sendRpcRequest.bind(backend);
    backend.sendRpcRequest = async <T>(
      method: string,
      params: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<T> => {
      if (method === "session/cancel") {
        return undefined as T;
      }
      return await originalSendRpcRequest(method, params, timeoutMs);
    };

    backend.sessionSubscribers.set(
      sessionId,
      new Set([
        (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      ]),
    );
    backend.sessionPromptSequences.set(sessionId, 1);
    backend.sessionPromptHasActivity.set(sessionId, true);

    await backend.abortSession(sessionId);

    expect(backend.sessionIgnoreStatusUntilActivity.has(sessionId)).toBe(true);
    expect(backend.sessionPromptSequences.get(sessionId)).toBe(2);

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/status",
      params: {
        sessionId,
        status: "idle",
      },
    });

    expect(events).toEqual([
      {
        type: "session.status",
        sessionId,
        status: "idle",
        attempt: undefined,
        message: undefined,
      },
    ]);
    expect(backend.sessionPromptSequences.get(sessionId)).toBe(2);

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            text: "fresh prompt output",
          },
        },
      },
    });

    expect(backend.sessionIgnoreStatusUntilActivity.has(sessionId)).toBe(false);

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/status",
      params: {
        sessionId,
        status: "idle",
      },
    });

    expect(events).toEqual([
      {
        type: "session.status",
        sessionId,
        status: "idle",
        attempt: undefined,
        message: undefined,
      },
      {
        type: "message.start",
        messageId: expect.any(String),
      },
      {
        type: "message.delta",
        content: "fresh prompt output",
      },
      {
        type: "session.status",
        sessionId,
        status: "idle",
        attempt: undefined,
        message: undefined,
      },
      {
        type: "message.complete",
        content: "",
      },
    ]);
    expect(backend.sessionPromptSequences.has(sessionId)).toBe(false);
  });

  test("does not emit error for session/prompt timeout in async mode", async () => {
    const backend = getBackend();
    const sessionId = "session-timeout";
    const events: Array<Record<string, unknown>> = [];

    backend.connected = true;
    backend.process = {
      stdin: {
        write: () => {
          // no-op
        },
      },
    };
    backend.sessionSubscribers.set(
      sessionId,
      new Set([
        (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      ]),
    );

    backend.sendRpcRequest = ((method: string) => {
      if (method === "session/prompt") {
        return Promise.reject(new Error("ACP request timed out for method 'session/prompt'"));
      }
      return Promise.resolve({}) as Promise<unknown>;
    }) as PrivateBackend["sendRpcRequest"];

    await backend.sendPromptAsync(sessionId, { parts: [{ type: "text", text: "hello" }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual([]);
  });

  test("keeps the prompt active when abort is unsupported", async () => {
    const backend = getBackend();
    const sessionId = "session-unsupported-abort";
    const events: Array<Record<string, unknown>> = [];
    const promptRequest = createDeferred<unknown>();

    backend.connected = true;
    backend.process = {
      stdin: {
        write: () => {
          // no-op
        },
      },
    };
    backend.sessionSubscribers.set(
      sessionId,
      new Set([
        (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      ]),
    );

    const originalSendRpcRequest = backend.sendRpcRequest.bind(backend);
    backend.sendRpcRequest = async <T>(
      method: string,
      params: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<T> => {
      if (method === "session/cancel" || method === "session/abort" || method === "session/stop") {
        throw new Error("Method not found");
      }
      if (method === "session/prompt") {
        return await promptRequest.promise as T;
      }
      return await originalSendRpcRequest(method, params, timeoutMs);
    };

    await backend.sendPromptAsync(sessionId, { parts: [{ type: "text", text: "hello" }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(backend.sessionPromptSequences.get(sessionId)).toBe(1);

    await backend.abortSession(sessionId);

    expect(backend.sessionPromptSequences.get(sessionId)).toBe(1);
    expect(backend.sessionIgnoreStatusUntilActivity.has(sessionId)).toBe(false);
    expect(events).toEqual([]);

    promptRequest.resolve({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual([]);
    expect(backend.sessionPromptSequences.get(sessionId)).toBe(1);
  });

  test("recovers after prompt error and only completes next prompt after activity", async () => {
    const backend = getBackend();
    const sessionId = "session-error-recovery";
    const events: Array<Record<string, unknown>> = [];

    backend.connected = true;
    backend.process = {
      stdin: {
        write: () => {
          // no-op
        },
      },
    };
    backend.sessionSubscribers.set(
      sessionId,
      new Set([
        (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      ]),
    );

    const secondPrompt = createDeferred<unknown>();
    let promptCallCount = 0;
    backend.sendRpcRequest = ((method: string) => {
      if (method !== "session/prompt") {
        return Promise.resolve({}) as Promise<unknown>;
      }
      promptCallCount += 1;
      if (promptCallCount === 1) {
        return Promise.reject(new Error("Backend exploded"));
      }
      return secondPrompt.promise;
    }) as PrivateBackend["sendRpcRequest"];

    await backend.sendPromptAsync(sessionId, { parts: [{ type: "text", text: "first" }] });
    await Promise.resolve();
    await Promise.resolve();
    expect(events.some((event) => event["type"] === "error")).toBe(true);

    events.length = 0;
    await backend.sendPromptAsync(sessionId, { parts: [{ type: "text", text: "second" }] });

    // Idle can arrive before the next response starts; that must not complete the turn.
    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/status",
      params: {
        sessionId,
        status: "idle",
      },
    });
    expect(events.filter((event) => event["type"] === "message.complete")).toHaveLength(0);

    // Real activity for the new prompt, then idle completion.
    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "Doing real work" },
        },
      },
    });
    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/status",
      params: {
        sessionId,
        status: "idle",
      },
    });

    expect(events.some((event) => event["type"] === "message.delta" && event["content"] === "Doing real work")).toBe(true);
    expect(events.filter((event) => event["type"] === "message.complete")).toHaveLength(1);

    secondPrompt.resolve({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();
    expect(events.filter((event) => event["type"] === "message.complete")).toHaveLength(1);
  });

  test("ignores stale message.complete from previous async prompt", async () => {
    const backend = getBackend();
    const sessionId = "session-stale";
    const events: Array<Record<string, unknown>> = [];

    backend.connected = true;
    backend.process = {
      stdin: {
        write: () => {
          // no-op
        },
      },
    };
    backend.sessionSubscribers.set(
      sessionId,
      new Set([
        (event: unknown) => {
          events.push(event as Record<string, unknown>);
        },
      ]),
    );

    const firstPrompt = createDeferred<unknown>();
    const secondPrompt = createDeferred<unknown>();
    let promptCallCount = 0;
    backend.sendRpcRequest = ((method: string) => {
      if (method !== "session/prompt") {
        return Promise.resolve({}) as Promise<unknown>;
      }
      promptCallCount += 1;
      return promptCallCount === 1 ? firstPrompt.promise : secondPrompt.promise;
    }) as PrivateBackend["sendRpcRequest"];

    await backend.sendPromptAsync(sessionId, { parts: [{ type: "text", text: "first" }] });
    await backend.sendPromptAsync(sessionId, { parts: [{ type: "text", text: "second" }] });

    firstPrompt.resolve({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toHaveLength(0);

    secondPrompt.resolve({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toHaveLength(0);

    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "Second prompt answer" },
        },
      },
    });
    backend.handleRpcMessage({
      jsonrpc: "2.0",
      method: "session/status",
      params: {
        sessionId,
        status: "idle",
      },
    });

    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      type: "message.start",
      messageId: expect.any(String),
    });
    expect(events[1]).toEqual({
      type: "message.delta",
      content: "Second prompt answer",
    });
    expect(events[2]).toEqual({
      type: "session.status",
      sessionId,
      status: "idle",
      attempt: undefined,
      message: undefined,
    });
    expect(events[3]).toEqual({
      type: "message.complete",
      content: "",
    });
  });

  test("buildPromptParams includes model when provided", () => {
    const backend = getBackend();
    const params = backend.buildPromptParams("session-1", {
      parts: [{ type: "text", text: "Hello" }],
      model: { providerID: "anthropic", modelID: "claude-sonnet-4.6", variant: "thinking" },
    });

    expect(params).toMatchObject({
      sessionId: "session-1",
      model: "claude-sonnet-4.6",
    });
    expect(params["prompt"]).toEqual([{ type: "text", text: "Hello" }]);
  });

  test("buildPromptParams omits model when not provided", () => {
    const backend = getBackend();
    const params = backend.buildPromptParams("session-1", {
      parts: [{ type: "text", text: "Hello" }],
    });

    expect(params).toMatchObject({
      sessionId: "session-1",
    });
    expect(params["model"]).toBeUndefined();
  });

  test("buildPromptParams includes model with empty variant", () => {
    const backend = getBackend();
    const params = backend.buildPromptParams("session-1", {
      parts: [{ type: "text", text: "Hello" }],
      model: { providerID: "copilot", modelID: "gpt-5.3-codex", variant: "" },
    });

    expect(params["model"]).toBe("gpt-5.3-codex");
  });

  test("buildPromptParams preserves image prompt parts", () => {
    const backend = getBackend();
    const params = backend.buildPromptParams("session-1", {
      parts: [
        { type: "text", text: "Hello" },
        { type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
      ],
    });

    expect(params["prompt"]).toEqual([
      { type: "text", text: "Hello" },
      { type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
    ]);
  });
});
