/**
 * Mock ACP runtime used for testing.
 *
 * This process speaks ACP-style JSON-RPC over stdio so Ralpher can exercise
 * the real ACP transport path without requiring a real coding agent.
 */

import { createInterface } from "node:readline";

const SUPPORTED_PROTOCOL_VERSION = 1;
const OUTBOUND_REQUEST_TIMEOUT_MS = 10_000;
const STREAM_DELAY_MS = 35;
const SLOW_STREAM_DELAY_MS = 120;
const REQUEST_CANCELLED_ERROR_CODE = -32800;
const METHOD_NOT_FOUND_ERROR_CODE = -32601;
const INVALID_PARAMS_ERROR_CODE = -32602;
const INVALID_REQUEST_ERROR_CODE = -32600;
const INTERNAL_ERROR_CODE = -32603;

type JsonRpcId = number | string;

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: JsonRpcError;
};

type ClientCapabilities = {
  fs: {
    readTextFile: boolean;
    writeTextFile: boolean;
  };
  terminal: boolean;
};

type ConfigOptionValue = {
  value: string;
  name: string;
  description?: string;
};

type ConfigOption = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: "select";
  currentValue: string;
  options: ConfigOptionValue[];
};

type SessionMode = {
  id: string;
  name: string;
  description?: string;
};

type SessionHistoryEntry = {
  role: "user" | "assistant" | "reasoning";
  text: string;
};

type MockSession = {
  id: string;
  cwd: string;
  title: string | null;
  updatedAt: string;
  configOptions: ConfigOption[];
  modes: SessionMode[];
  currentModeId: string;
  history: SessionHistoryEntry[];
  deleted: boolean;
  promptCount: number;
  metadata: Record<string, unknown>;
  activePromptRequestId?: JsonRpcId;
  activePromptAbort?: AbortController;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

type PendingOutboundRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: Error) => void;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nowIso(): string {
  return new Date().toISOString();
}

function cloneConfigOption(option: ConfigOption): ConfigOption {
  return {
    ...option,
    options: option.options.map((entry) => ({ ...entry })),
  };
}

function buildDefaultConfigOptions(): ConfigOption[] {
  return [
    {
      id: "mode",
      name: "Session Mode",
      description: "Controls how the mock agent behaves.",
      category: "mode",
      type: "select",
      currentValue: "ask",
      options: [
        { value: "ask", name: "Ask", description: "Request approval before risky steps." },
        { value: "architect", name: "Architect", description: "Focus on planning and design." },
        { value: "code", name: "Code", description: "Implement changes with full tool access." },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "mock-model",
      options: [
        { value: "mock-model", name: "Mock Model", description: "Balanced fake model." },
        { value: "mock-model-thinking", name: "Mock Model Thinking", description: "More reasoning output." },
        { value: "mock-model-extended", name: "Mock Model Extended", description: "Longer fake answers." },
      ],
    },
    {
      id: "thought_level",
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low", description: "Minimal reasoning output." },
        { value: "medium", name: "Medium", description: "Default reasoning detail." },
        { value: "high", name: "High", description: "Verbose reasoning output." },
      ],
    },
  ];
}

function buildDefaultModes(): SessionMode[] {
  return [
    { id: "ask", name: "Ask", description: "Ask before actions." },
    { id: "architect", name: "Architect", description: "Plan before implementation." },
    { id: "code", name: "Code", description: "Implement directly." },
  ];
}

function createSeed(text: string): number {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createPseudoRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 10_000) / 10_000;
  };
}

function splitIntoChunks(text: string, chunkCount: number): string[] {
  if (text.length === 0 || chunkCount <= 1) {
    return [text];
  }
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length <= 1) {
    return [text];
  }
  const chunks: string[] = [];
  const size = Math.max(1, Math.ceil(words.length / chunkCount));
  for (let index = 0; index < words.length; index += size) {
    const value = words.slice(index, index + size).join(" ");
    if (value.length > 0) {
      chunks.push(`${value}${index + size < words.length ? " " : ""}`);
    }
  }
  return chunks;
}

function firstPromptText(prompt: unknown[]): string {
  return prompt
    .map((entry) => {
      if (!isRecord(entry)) {
        return "";
      }
      return getString(entry["text"]) ?? "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function makeQuestionPayload(): Array<Record<string, unknown>> {
  return [
    {
      question: "Which implementation style should I mimic in the response?",
      header: "Mock ACP preference",
      options: [
        { label: "Concise", description: "Keep the answer short." },
        { label: "Detailed", description: "Use more detailed wording." },
      ],
      multiple: false,
      custom: false,
    },
  ];
}

class MockAcpServer {
  private initialized = false;
  private clientCapabilities: ClientCapabilities = {
    fs: {
      readTextFile: false,
      writeTextFile: false,
    },
    terminal: false,
  };
  private readonly sessions = new Map<string, MockSession>();
  private readonly pendingOutboundRequests = new Map<JsonRpcId, PendingOutboundRequest>();
  private readonly pendingQuestionReplies = new Map<string, Deferred<string[][]>>();
  private readonly requestAbortControllers = new Map<JsonRpcId, AbortController>();
  private readonly outboundRequestMethods = new Map<JsonRpcId, string>();
  private nextSessionId = 1;
  private nextOutboundRequestId = 10_000;
  private nextToolCallId = 1;
  private nextQuestionId = 1;

  async start(): Promise<void> {
    const lineReader = createInterface({ input: process.stdin, crlfDelay: Infinity });

    for await (const line of lineReader) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      this.handleLine(trimmed);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      process.stderr.write(`mock-acp-server: invalid JSON line: ${String(error)}\n`);
      return;
    }

    if (!isRecord(parsed) || parsed["jsonrpc"] !== "2.0") {
      return;
    }

    const message = parsed as JsonRpcMessage;

    if (message.method) {
      const params = isRecord(message.params) ? message.params : {};
      if (message.method === "$/cancel_request") {
        this.handleCancelRequestNotification(params);
        return;
      }
      if (message.method === "session/cancel" && message.id === undefined) {
        this.handleSessionCancelNotification(params);
        return;
      }
      void this.handleRequest(message, params);
      return;
    }

    if (message.id === undefined) {
      return;
    }

    const pending = this.pendingOutboundRequests.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingOutboundRequests.delete(message.id);
    this.outboundRequestMethods.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  }

  private async handleRequest(message: JsonRpcMessage, params: Record<string, unknown>): Promise<void> {
    const method = message.method;
    if (!method) {
      return;
    }

    if (message.id === undefined) {
      await this.handleNotification(method, params);
      return;
    }

    try {
      const result = await this.dispatch(method, params, message.id);
      this.writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result,
      });
    } catch (error) {
      const rpcError = this.normalizeError(error);
      this.writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: rpcError,
      });
    }
  }

  private async handleNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (method === "session/cancel") {
      this.handleSessionCancelNotification(params);
      return;
    }
    if (method === "$/cancel_request") {
      this.handleCancelRequestNotification(params);
      return;
    }
    await this.dispatch(method, params, undefined);
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    requestId: JsonRpcId | undefined,
  ): Promise<unknown> {
    if (method !== "initialize" && !this.initialized) {
      throw this.rpcError(INVALID_REQUEST_ERROR_CODE, "Server not initialized");
    }

    switch (method) {
      case "initialize":
        return this.handleInitialize(params);
      case "authenticate":
        return this.handleAuthenticate(params);
      case "session/new":
        return this.handleSessionNew(params);
      case "session/list":
        return this.handleSessionList(params);
      case "session/load":
        return await this.handleSessionLoad(params, requestId);
      case "session/delete":
        return this.handleSessionDelete(params);
      case "session/set_config_option":
        return this.handleSetConfigOption(params);
      case "session/set_mode":
        return await this.handleSetMode(params);
      case "session/prompt":
        return await this.handlePrompt(params, requestId);
      case "session/cancel":
      case "session/abort":
      case "session/stop":
        this.handleSessionCancelNotification(params);
        return {};
      case "session/reply_question":
      case "session/question_reply":
        return this.handleQuestionReply(params);
      case "session/reply_permission":
      case "session/permission_reply":
        return {};
      default:
        throw this.rpcError(METHOD_NOT_FOUND_ERROR_CODE, `Method not found: ${method}`);
    }
  }

  private handleInitialize(params: Record<string, unknown>): Record<string, unknown> {
    const requestedVersion = getNumber(params["protocolVersion"]) ?? SUPPORTED_PROTOCOL_VERSION;
    const fsCapabilities = isRecord(params["clientCapabilities"])
      && isRecord((params["clientCapabilities"] as Record<string, unknown>)["fs"])
      ? (params["clientCapabilities"] as Record<string, unknown>)["fs"] as Record<string, unknown>
      : {};
    const terminalCap = isRecord(params["clientCapabilities"])
      ? getBoolean((params["clientCapabilities"] as Record<string, unknown>)["terminal"])
      : null;

    this.clientCapabilities = {
      fs: {
        readTextFile: getBoolean(fsCapabilities["readTextFile"]) ?? false,
        writeTextFile: getBoolean(fsCapabilities["writeTextFile"]) ?? false,
      },
      terminal: terminalCap ?? false,
    };
    this.initialized = true;

    return {
      protocolVersion: requestedVersion === SUPPORTED_PROTOCOL_VERSION ? requestedVersion : SUPPORTED_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        sessionCapabilities: {
          list: {},
          delete: {},
        },
      },
      agentInfo: {
        name: "ralpher-mock-acp",
        title: "Ralpher Mock ACP",
        version: "0.0.0-test",
      },
      authMethods: [
        {
          id: "mock-agent-auth",
          name: "Mock Agent Auth",
          description: "No-op auth method used for ACP protocol coverage tests.",
        },
      ],
    };
  }

  private handleAuthenticate(params: Record<string, unknown>): Record<string, unknown> {
    const methodId = getString(params["methodId"]);
    if (!methodId) {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, "authenticate requires methodId");
    }
    if (methodId !== "mock-agent-auth") {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, `Unknown auth method: ${methodId}`);
    }
    return {};
  }

  private handleSessionNew(params: Record<string, unknown>): Record<string, unknown> {
    const cwd = getString(params["cwd"]);
    if (!cwd || !cwd.startsWith("/")) {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, "session/new requires an absolute cwd");
    }
    if (!Array.isArray(params["mcpServers"])) {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, "session/new requires mcpServers array");
    }
    const sessionId = `mock-session-${this.nextSessionId}`;
    this.nextSessionId += 1;
    const session: MockSession = {
      id: sessionId,
      cwd,
      title: getString(params["title"]),
      updatedAt: nowIso(),
      configOptions: buildDefaultConfigOptions(),
      modes: buildDefaultModes(),
      currentModeId: "ask",
      history: [],
      deleted: false,
      promptCount: 0,
      metadata: {},
    };
    this.sessions.set(sessionId, session);
    return this.buildSessionResponse(session);
  }

  private handleSessionList(params: Record<string, unknown>): Record<string, unknown> {
    const cwd = getString(params["cwd"]);
    const cursor = getString(params["cursor"]);
    let offset = 0;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as unknown;
        if (!isRecord(decoded)) {
          throw new Error("cursor payload must be object");
        }
        offset = getNumber(decoded["offset"]) ?? 0;
      } catch {
        throw this.rpcError(INVALID_PARAMS_ERROR_CODE, "Invalid session/list cursor");
      }
    }

    const visibleSessions = Array.from(this.sessions.values())
      .filter((session) => !session.deleted)
      .filter((session) => !cwd || session.cwd === cwd)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const pageSize = 20;
    const page = visibleSessions.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;

    return {
      sessions: page.map((session) => ({
        sessionId: session.id,
        cwd: session.cwd,
        ...(session.title ? { title: session.title } : {}),
        updatedAt: session.updatedAt,
        _meta: { ...session.metadata },
      })),
      ...(nextOffset < visibleSessions.length
        ? { nextCursor: Buffer.from(JSON.stringify({ offset: nextOffset }), "utf8").toString("base64") }
        : {}),
    };
  }

  private async handleSessionLoad(
    params: Record<string, unknown>,
    requestId: JsonRpcId | undefined,
  ): Promise<Record<string, unknown>> {
    const session = this.getExistingSession(params["sessionId"]);
    const cwd = getString(params["cwd"]);
    if (!cwd || !cwd.startsWith("/")) {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, "session/load requires an absolute cwd");
    }
    if (!Array.isArray(params["mcpServers"])) {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, "session/load requires mcpServers array");
    }
    const abortController = this.trackRequestAbortController(requestId);
    try {
      for (const entry of session.history) {
        if (abortController?.signal.aborted) {
          throw this.rpcError(REQUEST_CANCELLED_ERROR_CODE, "Request cancelled");
        }
        await this.delay(STREAM_DELAY_MS);
        this.sendNotification("session/update", {
          sessionId: session.id,
          update: {
            sessionUpdate: entry.role === "user" ? "user_message_chunk" : entry.role === "reasoning" ? "agent_thought_chunk" : "agent_message_chunk",
            content: {
              type: "text",
              text: entry.text,
            },
          },
        });
      }
      return this.buildSessionResponse(session);
    } finally {
      if (requestId !== undefined) {
        this.requestAbortControllers.delete(requestId);
      }
    }
  }

  private handleSessionDelete(params: Record<string, unknown>): Record<string, unknown> {
    const sessionId = getString(params["sessionId"]);
    if (!sessionId) {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, "session/delete requires sessionId");
    }
    const session = this.sessions.get(sessionId);
    if (session) {
      session.deleted = true;
      session.updatedAt = nowIso();
    }
    return {};
  }

  private handleSetConfigOption(params: Record<string, unknown>): Record<string, unknown> {
    const session = this.getExistingSession(params["sessionId"]);
    const configId = getString(params["configId"]);
    const value = getString(params["value"]);
    if (!configId || !value) {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, "session/set_config_option requires configId and value");
    }
    const option = session.configOptions.find((entry) => entry.id === configId);
    if (!option) {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, `Unknown config option: ${configId}`);
    }
    if (!option.options.some((candidate) => candidate.value === value)) {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, `Invalid value '${value}' for config option '${configId}'`);
    }
    option.currentValue = value;
    if (configId === "mode") {
      session.currentModeId = value;
    }
    session.updatedAt = nowIso();
    return {
      configOptions: session.configOptions.map(cloneConfigOption),
    };
  }

  private async handleSetMode(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = this.getExistingSession(params["sessionId"]);
    const modeId = getString(params["modeId"]);
    if (!modeId) {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, "session/set_mode requires modeId");
    }
    if (!session.modes.some((mode) => mode.id === modeId)) {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, `Unknown mode: ${modeId}`);
    }
    session.currentModeId = modeId;
    const modeOption = session.configOptions.find((option) => option.id === "mode");
    if (modeOption) {
      modeOption.currentValue = modeId;
    }
    session.updatedAt = nowIso();
    this.sendNotification("session/update", {
      sessionId: session.id,
      update: {
        sessionUpdate: "current_mode_update",
        modeId,
      },
    });
    return {};
  }

  private async handlePrompt(
    params: Record<string, unknown>,
    requestId: JsonRpcId | undefined,
  ): Promise<Record<string, unknown>> {
    const session = this.getExistingSession(params["sessionId"]);
    if (requestId === undefined) {
      throw this.rpcError(INVALID_REQUEST_ERROR_CODE, "session/prompt must be a request");
    }
    const prompt = asArray(params["prompt"]);
    if (prompt.length === 0) {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, "session/prompt requires prompt content");
    }

    session.promptCount += 1;
    session.updatedAt = nowIso();
    const abortController = new AbortController();
    session.activePromptRequestId = requestId;
    session.activePromptAbort = abortController;
    this.requestAbortControllers.set(requestId, abortController);

    try {
      const stopReason = await this.runPromptTurn(session, prompt, abortController.signal);
      return { stopReason };
    } finally {
      if (session.activePromptRequestId === requestId) {
        delete session.activePromptRequestId;
        delete session.activePromptAbort;
      }
      this.requestAbortControllers.delete(requestId);
    }
  }

  private handleQuestionReply(params: Record<string, unknown>): Record<string, unknown> {
    const requestId = getString(params["requestId"]);
    const rawAnswers = asArray(params["answers"]);
    if (!requestId) {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, "question reply requires requestId");
    }
    const pending = this.pendingQuestionReplies.get(requestId);
    if (!pending) {
      return {};
    }
    const answers = rawAnswers.map((answer) => asArray(answer).map((item) => String(item)));
    this.pendingQuestionReplies.delete(requestId);
    pending.resolve(answers);
    return {};
  }

  private async runPromptTurn(
    session: MockSession,
    prompt: unknown[],
    signal: AbortSignal,
  ): Promise<string> {
    const promptText = firstPromptText(prompt);
    session.history.push({ role: "user", text: promptText });

    this.sendStatus(session, "busy");
    await this.delay(STREAM_DELAY_MS);

    if (!session.title) {
      session.title = this.generateSessionTitle(promptText);
      this.sendNotification("session/update", {
        sessionId: session.id,
        update: {
          sessionUpdate: "session_info_update",
          title: session.title,
          updatedAt: session.updatedAt,
          _meta: { source: "mock-acp" },
        },
      });
    }

    this.sendNotification("session/update", {
      sessionId: session.id,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "plan", description: "Create a plan", input: { hint: "what to plan" } },
          { name: "test", description: "Run tests" },
          { name: "review", description: "Review current work" },
        ],
      },
    });

    this.sendNotification("session/update", {
      sessionId: session.id,
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Inspect prompt context", priority: "high", status: "completed" },
          { content: "Simulate agent tool usage", priority: "medium", status: "completed" },
          { content: "Stream agent response", priority: "medium", status: "completed" },
        ],
      },
    });

    if (promptText.includes("[retry]")) {
      this.sendStatus(session, "retry", 1, "Mock agent retrying after transient issue");
      await this.delay(STREAM_DELAY_MS);
      this.sendStatus(session, "busy");
    }

    const toolCallId = `tool-call-${this.nextToolCallId}`;
    this.nextToolCallId += 1;

    this.sendNotification("session/update", {
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Mock ACP tool invocation",
        kind: promptText.includes("[client-terminal]") ? "execute" : "other",
        status: "pending",
        rawInput: {
          promptLength: promptText.length,
        },
      },
    });

    if (promptText.includes("[permission]")) {
      const permissionResult = await this.requestPermission(session.id, toolCallId, signal);
      if (permissionResult.outcome === "cancelled") {
        this.sendNotification("session/update", {
          sessionId: session.id,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
            rawOutput: {
              message: "Permission request cancelled",
            },
          },
        });
        this.sendStatus(session, "idle");
        return "cancelled";
      }
    }

    this.sendNotification("session/update", {
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Mock ACP runtime is simulating tool work...",
            },
          },
        ],
      },
    });

    if (promptText.includes("[question]")) {
      await this.askQuestion(session.id, signal);
    }

    let fsReadSummary = "";
    if (promptText.includes("[client-fs-read]") && this.clientCapabilities.fs.readTextFile) {
      const fileContent = await this.readClientFile(session.id, session.cwd, signal);
      fsReadSummary = ` Read ${fileContent.length} characters from the client file system.`;
    }

    let terminalSummary = "";
    if (promptText.includes("[client-terminal]") && this.clientCapabilities.terminal) {
      terminalSummary = await this.runClientTerminalTool(session.id, toolCallId, session.cwd, signal);
    }

    if (signal.aborted) {
      this.sendNotification("session/update", {
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          rawOutput: {
            message: "Prompt cancelled before completion",
          },
        },
      });
      this.sendStatus(session, "idle");
      return "cancelled";
    }

    const reasoningText = this.buildReasoningText(promptText, session.promptCount);
    for (const chunk of splitIntoChunks(reasoningText, 3)) {
      await this.delay(promptText.includes("[slow]") ? SLOW_STREAM_DELAY_MS : STREAM_DELAY_MS);
      if (signal.aborted) {
        this.sendStatus(session, "idle");
        return "cancelled";
      }
      this.sendNotification("session/update", {
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: {
            partId: `reasoning-${session.promptCount}`,
            type: "text",
            text: chunk,
          },
        },
      });
      session.history.push({ role: "reasoning", text: chunk });
    }

    const responseText = this.buildResponseText(promptText, session.promptCount, fsReadSummary, terminalSummary);
    for (const chunk of splitIntoChunks(responseText, 4)) {
      await this.delay(promptText.includes("[slow]") ? SLOW_STREAM_DELAY_MS : STREAM_DELAY_MS);
      if (signal.aborted) {
        this.sendStatus(session, "idle");
        return "cancelled";
      }
      this.sendNotification("session/update", {
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: chunk,
          },
        },
      });
      session.history.push({ role: "assistant", text: chunk });
    }

    this.sendNotification("session/update", {
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: {
          summary: "Mock ACP tool finished successfully",
          responseLength: responseText.length,
        },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Mock tool execution complete.",
            },
          },
        ],
      },
    });

    if (promptText.includes("[config-update]")) {
      const thoughtLevel = session.configOptions.find((option) => option.id === "thought_level");
      if (thoughtLevel) {
        thoughtLevel.currentValue = thoughtLevel.currentValue === "high" ? "medium" : "high";
      }
      this.sendNotification("session/update", {
        sessionId: session.id,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: session.configOptions.map(cloneConfigOption),
        },
      });
    }

    this.sendStatus(session, "idle");
    session.updatedAt = nowIso();
    return signal.aborted ? "cancelled" : "end_turn";
  }

  private async requestPermission(
    sessionId: string,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<{ outcome: "selected" | "cancelled"; optionId?: string }> {
    const result = await this.sendClientRequest<Record<string, unknown>>(
      "session/request_permission",
      {
        sessionId,
        toolCall: {
          toolCallId,
          title: "Mock approval gate",
          kind: "execute",
          status: "pending",
          rawInput: {
            command: "echo mock-run",
            commands: ["echo mock-run"],
          },
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
      signal,
    );

    const outcome = isRecord(result["outcome"]) ? result["outcome"] : {};
    const outcomeType = getString(outcome["outcome"]);
    const optionId = getString(outcome["optionId"]);
    if (outcomeType === "cancelled") {
      return { outcome: "cancelled" };
    }
    return {
      outcome: "selected",
      ...(optionId ? { optionId } : {}),
    };
  }

  private async askQuestion(sessionId: string, signal: AbortSignal): Promise<void> {
    const requestId = `question-${this.nextQuestionId}`;
    this.nextQuestionId += 1;
    const deferred = createDeferred<string[][]>();
    this.pendingQuestionReplies.set(requestId, deferred);
    this.sendNotification("session/question", {
      sessionId,
      requestId,
      questions: makeQuestionPayload(),
    });

    signal.addEventListener("abort", () => {
      const pending = this.pendingQuestionReplies.get(requestId);
      if (pending) {
        this.pendingQuestionReplies.delete(requestId);
        pending.reject(new Error("Question cancelled"));
      }
    }, { once: true });

    try {
      await deferred.promise;
    } catch {
      // Question replies are optional for the mock runtime.
    }
  }

  private async readClientFile(sessionId: string, cwd: string, signal: AbortSignal): Promise<string> {
    const result = await this.sendClientRequest<Record<string, unknown>>(
      "fs/read_text_file",
      {
        sessionId,
        path: `${cwd.replace(/\/$/, "")}/mock-context.txt`,
      },
      signal,
    );
    return getString(result["content"]) ?? "";
  }

  private async runClientTerminalTool(
    sessionId: string,
    toolCallId: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<string> {
    const created = await this.sendClientRequest<Record<string, unknown>>(
      "terminal/create",
      {
        sessionId,
        command: "echo",
        args: ["mock terminal"],
        cwd,
        env: [],
        outputByteLimit: 8_192,
      },
      signal,
    );
    const terminalId = getString(created["terminalId"]);
    if (!terminalId) {
      throw this.rpcError(INTERNAL_ERROR_CODE, "terminal/create did not return terminalId");
    }

    this.sendNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
        content: [
          {
            type: "terminal",
            terminalId,
          },
        ],
      },
    });

    const outputResult = await this.sendClientRequest<Record<string, unknown>>(
      "terminal/output",
      {
        sessionId,
        terminalId,
      },
      signal,
    );
    const output = getString(outputResult["output"]) ?? "";
    await this.sendClientRequest<Record<string, unknown>>(
      "terminal/wait_for_exit",
      {
        sessionId,
        terminalId,
      },
      signal,
    );
    await this.sendClientRequest<Record<string, unknown>>(
      "terminal/release",
      {
        sessionId,
        terminalId,
      },
      signal,
    );
    return output.length > 0 ? ` Terminal output: ${output.trim()}.` : "";
  }

  private async sendClientRequest<T extends Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) {
      throw this.rpcError(REQUEST_CANCELLED_ERROR_CODE, "Request cancelled");
    }
    const requestId = this.nextOutboundRequestId;
    this.nextOutboundRequestId += 1;

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingOutboundRequests.delete(requestId);
        this.outboundRequestMethods.delete(requestId);
        reject(this.rpcError(REQUEST_CANCELLED_ERROR_CODE, `Timed out waiting for client method ${method}`));
      }, OUTBOUND_REQUEST_TIMEOUT_MS);

      const abortListener = () => {
        clearTimeout(timeout);
        this.pendingOutboundRequests.delete(requestId);
        this.outboundRequestMethods.delete(requestId);
        reject(this.rpcError(REQUEST_CANCELLED_ERROR_CODE, "Request cancelled"));
      };
      signal.addEventListener("abort", abortListener, { once: true });

      this.pendingOutboundRequests.set(requestId, {
        resolve: (value: unknown) => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", abortListener);
          resolve((isRecord(value) ? value : {}) as T);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", abortListener);
          reject(error);
        },
        timeout,
      });
      this.outboundRequestMethods.set(requestId, method);
      this.writeMessage({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params,
      });
    });
  }

  private handleCancelRequestNotification(params: Record<string, unknown>): void {
    const requestId = params["requestId"];
    if (typeof requestId !== "number" && typeof requestId !== "string") {
      return;
    }
    const controller = this.requestAbortControllers.get(requestId);
    if (controller) {
      controller.abort();
      return;
    }
    const pendingClientRequest = this.pendingOutboundRequests.get(requestId);
    if (pendingClientRequest) {
      clearTimeout(pendingClientRequest.timeout);
      this.pendingOutboundRequests.delete(requestId);
      this.outboundRequestMethods.delete(requestId);
      pendingClientRequest.reject(this.rpcError(REQUEST_CANCELLED_ERROR_CODE, "Request cancelled"));
    }
  }

  private handleSessionCancelNotification(params: Record<string, unknown>): void {
    const sessionId = getString(params["sessionId"]);
    if (!sessionId) {
      return;
    }
    const session = this.sessions.get(sessionId);
    session?.activePromptAbort?.abort();
  }

  private getExistingSession(rawSessionId: unknown): MockSession {
    const sessionId = getString(rawSessionId);
    if (!sessionId) {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, "sessionId is required");
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.deleted) {
      throw this.rpcError(INVALID_PARAMS_ERROR_CODE, `Unknown session: ${sessionId}`);
    }
    return session;
  }

  private buildSessionResponse(session: MockSession): Record<string, unknown> {
    return {
      sessionId: session.id,
      configOptions: session.configOptions.map(cloneConfigOption),
      modes: {
        currentModeId: session.currentModeId,
        availableModes: session.modes.map((mode) => ({ ...mode })),
      },
    };
  }

  private buildReasoningText(promptText: string, promptCount: number): string {
    const words = [
      "Inspecting",
      "workspace",
      "context",
      "mapping",
      "dependencies",
      "drafting",
      "response",
      "ordering",
      "steps",
      "safely",
    ];
    const nextRandom = createPseudoRandom(createSeed(`${promptText}:reasoning:${promptCount}`));
    const sample = Array.from({ length: 8 }, () => words[Math.floor(nextRandom() * words.length)] ?? "reasoning");
    return `${sample.join(" ")}.`;
  }

  private buildResponseText(
    promptText: string,
    promptCount: number,
    fsReadSummary: string,
    terminalSummary: string,
  ): string {
    const fragments = [
      "Mock ACP is streaming a realistic looking response.",
      "It is deterministic per prompt so tests stay stable while the text still feels agent-like.",
      "Protocol notifications, tool updates, and session state transitions are all exercised in-process.",
      `${fsReadSummary}${terminalSummary}`.trim(),
    ].filter((fragment) => fragment.length > 0);

    const seed = createSeed(`${promptText}:response:${promptCount}`);
    const nextRandom = createPseudoRandom(seed);
    const extras = [
      "The response is chunked to mimic live model streaming.",
      "This fake runtime is designed for end-to-end ACP testing.",
      "It deliberately preserves protocol realism while avoiding external dependencies.",
      "Session state remains isolated so concurrent tests can reason about outputs safely.",
    ];
    while (fragments.length < 5) {
      const choice = extras[Math.floor(nextRandom() * extras.length)] ?? extras[0]!;
      if (!fragments.includes(choice)) {
        fragments.push(choice);
      }
    }

    if (promptText.includes("<promise>COMPLETE</promise>") || /original goal:/i.test(promptText)) {
      fragments.push("The requested work is complete. <promise>COMPLETE</promise>");
    } else if (/create a detailed plan/i.test(promptText) || promptText.includes("<promise>PLAN_READY</promise>")) {
      fragments.push("The plan is ready for review. <promise>PLAN_READY</promise>");
    }

    return fragments.join(" ");
  }

  private generateSessionTitle(promptText: string): string {
    const words = promptText
      .replace(/<[^>]+>/g, " ")
      .split(/\s+/)
      .map((word) => word.replace(/[^a-zA-Z0-9_-]/g, ""))
      .filter((word) => word.length > 0)
      .slice(0, 6);
    return words.length > 0 ? words.join(" ") : "Mock ACP Session";
  }

  private sendStatus(session: MockSession, status: "idle" | "busy" | "retry", attempt?: number, message?: string): void {
    this.sendNotification("session/status", {
      sessionId: session.id,
      status,
      ...(attempt !== undefined ? { attempt } : {}),
      ...(message ? { message } : {}),
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.writeMessage({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  private writeMessage(message: JsonRpcMessage): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private trackRequestAbortController(requestId: JsonRpcId | undefined): AbortController | null {
    if (requestId === undefined) {
      return null;
    }
    const controller = new AbortController();
    this.requestAbortControllers.set(requestId, controller);
    return controller;
  }

  private delay(ms: number): Promise<void> {
    return Bun.sleep(ms).then(() => undefined);
  }

  private rpcError(code: number, message: string, data?: unknown): Error & { code: number; data?: unknown } {
    const error = new Error(message) as Error & { code: number; data?: unknown };
    error.code = code;
    error.data = data;
    return error;
  }

  private normalizeError(error: unknown): JsonRpcError {
    if (isRecord(error) && typeof error["code"] === "number" && typeof error["message"] === "string") {
      return {
        code: error["code"] as number,
        message: error["message"] as string,
        ...(error["data"] !== undefined ? { data: error["data"] } : {}),
      };
    }
    if (error instanceof Error && "code" in error && typeof (error as Error & { code?: unknown }).code === "number") {
      const typedError = error as Error & { code: number; data?: unknown };
      return {
        code: typedError.code,
        message: typedError.message,
        ...(typedError.data !== undefined ? { data: typedError.data } : {}),
      };
    }
    return {
      code: INTERNAL_ERROR_CODE,
      message: String(error),
    };
  }
}

const server = new MockAcpServer();
void server.start();
