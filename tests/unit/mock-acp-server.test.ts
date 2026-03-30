import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getMockAcpCommand } from "../../src/backends/acp";

type JsonRpcId = number | string;

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type Waiter = {
  predicate: (message: JsonRpcMessage) => boolean;
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

class MockAcpHarness {
  private readonly process: Bun.Subprocess;
  private readonly bufferedMessages: JsonRpcMessage[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly stderrLines: string[] = [];
  private nextRequestId = 1;

  constructor() {
    const command = getMockAcpCommand();
    this.process = Bun.spawn([command.command, ...command.args], {
      cwd: "/workspaces/ralpher/.ralph-worktrees/2a4c00cb-eacd-4e36-8f36-121f38e90abd",
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.startReader(this.process.stdout);
    this.startReader(this.process.stderr, true);
  }

  async initialize(clientCapabilities?: Record<string, unknown>): Promise<JsonRpcMessage> {
    return await this.request("initialize", {
      protocolVersion: 1,
      ...(clientCapabilities ? { clientCapabilities } : {}),
      clientInfo: {
        name: "mock-acp-test-client",
        version: "0.0.0-test",
      },
    });
  }

  async request(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    this.sendRequestWithId(id, method, params);
    return await this.waitFor((message) => message.id === id, 8000);
  }

  async requestWithId(id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    this.sendRequestWithId(id, method, params);
    return await this.waitFor((message) => message.id === id, 8000);
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  async waitFor(predicate: (message: JsonRpcMessage) => boolean, timeoutMs = 5000): Promise<JsonRpcMessage> {
    const bufferedIndex = this.bufferedMessages.findIndex(predicate);
    if (bufferedIndex >= 0) {
      const [message] = this.bufferedMessages.splice(bufferedIndex, 1);
      return message!;
    }

    return await new Promise<JsonRpcMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeWaiter(waiter);
        reject(new Error(`Timed out waiting for mock ACP message. stderr: ${this.stderrLines.join(" | ")}`));
      }, timeoutMs);
      const waiter: Waiter = {
        predicate,
        resolve: (message) => {
          clearTimeout(timeout);
          this.removeWaiter(waiter);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timeout);
          this.removeWaiter(waiter);
          reject(error);
        },
        timeout,
      };
      this.waiters.push(waiter);
    });
  }

  async shutdown(): Promise<void> {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Harness shutting down"));
    }
    if (this.process.exitCode === null) {
      this.process.kill("SIGTERM");
    }
    await this.process.exited;
  }

  private write(message: JsonRpcMessage): void {
    if (!this.process.stdin || typeof this.process.stdin === "number") {
      throw new Error("mock ACP stdin unavailable");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private sendRequestWithId(id: JsonRpcId, method: string, params: Record<string, unknown>): void {
    this.write({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
  }

  private removeWaiter(target: Waiter): void {
    const index = this.waiters.indexOf(target);
    if (index >= 0) {
      this.waiters.splice(index, 1);
    }
  }

  private startReader(stream: ReadableStream<Uint8Array> | number | null | undefined, isStderr = false): void {
    if (!stream || typeof stream === "number") {
      return;
    }
    void (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            this.handleLine(line, isStderr);
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }
      const remaining = buffer.trim();
      if (remaining.length > 0) {
        this.handleLine(remaining, isStderr);
      }
    })();
  }

  private handleLine(line: string, isStderr: boolean): void {
    if (isStderr) {
      this.stderrLines.push(line);
      return;
    }
    const message = JSON.parse(line) as JsonRpcMessage;
    const waiter = this.waiters.find((candidate) => candidate.predicate(message));
    if (waiter) {
      waiter.resolve(message);
      return;
    }
    this.bufferedMessages.push(message);
  }
}

describe("mock ACP server", () => {
  let harness: MockAcpHarness;

  beforeEach(() => {
    harness = new MockAcpHarness();
  });

  afterEach(async () => {
    await harness.shutdown();
  });

  test("supports initialization, authentication, session lifecycle, and load replay", async () => {
    const initialize = await harness.initialize();
    expect(isRecord(initialize.result)).toBe(true);
    expect(initialize.result).toMatchObject({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          list: {},
          delete: {},
        },
      },
    });

    const auth = await harness.request("authenticate", { methodId: "mock-agent-auth" });
    expect(auth.error).toBeUndefined();

    const created = await harness.request("session/new", {
      cwd: "/tmp/mock-acp-lifecycle",
      mcpServers: [],
    });
    expect(isRecord(created.result)).toBe(true);
    const createdResult = created.result as Record<string, unknown>;
    const sessionId = getString(createdResult["sessionId"]);
    expect(sessionId).toBeTruthy();
    expect(Array.isArray(createdResult["configOptions"])).toBe(true);

    const promptResponsePromise = harness.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "remember this response for load replay" }],
    });
    await harness.waitFor((message) => message.method === "session/update" && isRecord(message.params)
      && isRecord(message.params["update"]) && getString((message.params["update"] as Record<string, unknown>)["sessionUpdate"]) === "agent_message_chunk");
    const promptResponse = await promptResponsePromise;
    expect(promptResponse.result).toEqual({ stopReason: "end_turn" });

    const listed = await harness.request("session/list", { cwd: "/tmp/mock-acp-lifecycle" });
    expect(listed.result).toMatchObject({
      sessions: [
        {
          sessionId,
          cwd: "/tmp/mock-acp-lifecycle",
        },
      ],
    });

    const loadPromise = harness.request("session/load", {
      sessionId,
      cwd: "/tmp/mock-acp-lifecycle",
      mcpServers: [],
    });
    const replayedUser = await harness.waitFor((message) => message.method === "session/update" && isRecord(message.params)
      && isRecord(message.params["update"]) && getString((message.params["update"] as Record<string, unknown>)["sessionUpdate"]) === "user_message_chunk");
    const replayedAssistant = await harness.waitFor((message) => message.method === "session/update" && isRecord(message.params)
      && isRecord(message.params["update"]) && getString((message.params["update"] as Record<string, unknown>)["sessionUpdate"]) === "agent_message_chunk");
    expect(replayedUser.params?.["sessionId"]).toBe(sessionId);
    expect(replayedAssistant.params?.["sessionId"]).toBe(sessionId);
    const loaded = await loadPromise;
    expect(isRecord(loaded.result)).toBe(true);
    expect((loaded.result as Record<string, unknown>)["sessionId"]).toBe(sessionId);

    const deleted = await harness.request("session/delete", { sessionId });
    expect(deleted.result).toEqual({});
    const deletedAgain = await harness.request("session/delete", { sessionId });
    expect(deletedAgain.result).toEqual({});

    const listedAfterDelete = await harness.request("session/list", { cwd: "/tmp/mock-acp-lifecycle" });
    expect(listedAfterDelete.result).toEqual({ sessions: [] });
  });

  test("streams prompt turns and exercises permission, question, config update, fs, and terminal flows", async () => {
    await harness.initialize({
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      terminal: true,
    });

    const created = await harness.request("session/new", {
      cwd: "/tmp/mock-acp-protocol",
      mcpServers: [],
    });
    const sessionId = getString((created.result as Record<string, unknown>)["sessionId"]);
    expect(sessionId).toBeTruthy();

    const promptResponsePromise = harness.request("session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "exercise [permission] [question] [client-fs-read] [client-terminal] [config-update]",
        },
      ],
    });

    const sessionInfoUpdate = await harness.waitFor((message) => message.method === "session/update" && isRecord(message.params)
      && isRecord(message.params["update"]) && getString((message.params["update"] as Record<string, unknown>)["sessionUpdate"]) === "session_info_update");
    expect(sessionInfoUpdate.params?.["sessionId"]).toBe(sessionId);

    const availableCommandsUpdate = await harness.waitFor((message) => message.method === "session/update" && isRecord(message.params)
      && isRecord(message.params["update"]) && getString((message.params["update"] as Record<string, unknown>)["sessionUpdate"]) === "available_commands_update");
    expect(availableCommandsUpdate.params?.["sessionId"]).toBe(sessionId);

    const permissionRequest = await harness.waitFor((message) => message.method === "session/request_permission");
    expect(permissionRequest.id).toBeDefined();
    harness.respond(permissionRequest.id!, {
      outcome: {
        outcome: "selected",
        optionId: "allow-once",
      },
    });

    const questionNotification = await harness.waitFor((message) => message.method === "session/question");
    expect(questionNotification.params?.["sessionId"]).toBe(sessionId);
    await harness.request("session/reply_question", {
      requestId: questionNotification.params?.["requestId"],
      answers: [["Detailed"]],
    });

    const fsReadRequest = await harness.waitFor((message) => message.method === "fs/read_text_file");
    harness.respond(fsReadRequest.id!, {
      content: "mock file contents from client",
    });

    const terminalCreate = await harness.waitFor((message) => message.method === "terminal/create");
    harness.respond(terminalCreate.id!, { terminalId: "terminal-1" });

    const terminalOutput = await harness.waitFor((message) => message.method === "terminal/output");
    harness.respond(terminalOutput.id!, {
      output: "terminal output from client\n",
      truncated: false,
      exitStatus: {
        exitCode: 0,
        signal: null,
      },
    });

    const terminalWait = await harness.waitFor((message) => message.method === "terminal/wait_for_exit");
    harness.respond(terminalWait.id!, {
      exitCode: 0,
      signal: null,
    });

    const terminalRelease = await harness.waitFor((message) => message.method === "terminal/release");
    harness.respond(terminalRelease.id!, {});

    const statusBusy = await harness.waitFor((message) => message.method === "session/status" && isRecord(message.params)
      && getString(message.params["status"]) === "busy");
    expect(statusBusy.params?.["sessionId"]).toBe(sessionId);

    const toolCall = await harness.waitFor((message) => message.method === "session/update" && isRecord(message.params)
      && isRecord(message.params["update"]) && getString((message.params["update"] as Record<string, unknown>)["sessionUpdate"]) === "tool_call");
    expect(toolCall.params?.["sessionId"]).toBe(sessionId);

    const reasoningChunk = await harness.waitFor((message) => message.method === "session/update" && isRecord(message.params)
      && isRecord(message.params["update"]) && getString((message.params["update"] as Record<string, unknown>)["sessionUpdate"]) === "agent_thought_chunk");
    expect(reasoningChunk.params?.["sessionId"]).toBe(sessionId);

    const messageChunk = await harness.waitFor((message) => message.method === "session/update" && isRecord(message.params)
      && isRecord(message.params["update"]) && getString((message.params["update"] as Record<string, unknown>)["sessionUpdate"]) === "agent_message_chunk");
    expect(messageChunk.params?.["sessionId"]).toBe(sessionId);

    const configUpdate = await harness.waitFor((message) => message.method === "session/update" && isRecord(message.params)
      && isRecord(message.params["update"]) && getString((message.params["update"] as Record<string, unknown>)["sessionUpdate"]) === "config_option_update");
    expect(configUpdate.params?.["sessionId"]).toBe(sessionId);

    const statusIdle = await harness.waitFor((message) => message.method === "session/status" && isRecord(message.params)
      && getString(message.params["status"]) === "idle");
    expect(statusIdle.params?.["sessionId"]).toBe(sessionId);

    const promptResponse = await promptResponsePromise;
    expect(promptResponse.result).toEqual({ stopReason: "end_turn" });
  });

  test("supports prompt cancellation via session/cancel and $/cancel_request", async () => {
    await harness.initialize();
    const created = await harness.request("session/new", {
      cwd: "/tmp/mock-acp-cancel",
      mcpServers: [],
    });
    const sessionId = getString((created.result as Record<string, unknown>)["sessionId"]);
    expect(sessionId).toBeTruthy();

    const slowPromptPromise = harness.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "this is slow [slow]" }],
    });
    await harness.waitFor((message) => message.method === "session/status" && isRecord(message.params)
      && getString(message.params["status"]) === "busy");
    harness.notify("session/cancel", { sessionId });
    const cancelledBySession = await slowPromptPromise;
    expect(cancelledBySession.result).toEqual({ stopReason: "cancelled" });

    const directPromptId = 99;
    const cancelledByRequestPromise = harness.requestWithId(directPromptId, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "cancel by id [slow]" }],
    });
    await harness.waitFor((message) => message.method === "session/status" && isRecord(message.params)
      && getString(message.params["status"]) === "busy");
    harness.notify("$/cancel_request", { requestId: directPromptId });
    const cancelledByRequest = await cancelledByRequestPromise;
    expect(cancelledByRequest.result).toEqual({ stopReason: "cancelled" });
  });
});
