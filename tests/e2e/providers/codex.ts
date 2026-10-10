/**
 * Deterministic external Codex app-server fixture for black-box E2E journeys.
 *
 * It persists dynamic-tool definitions with each thread and restores them on
 * `thread/resume`, matching the app-server contract without in-process hooks.
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { join } from "node:path";

type JsonRpcId = number | string;

interface JsonRpcMessage {
  error?: { code: number; message: string };
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
}

interface PersistedTurn {
  completedAt: number | null;
  error: { message: string } | null;
  id: string;
  items: unknown[];
  startedAt: number;
  status: "completed" | "failed" | "inProgress" | "interrupted";
}

interface PersistedThread {
  createdAt: number;
  cwd: string;
  dynamicTools: unknown[];
  id: string;
  model: string;
  status: "active" | "idle";
  turns: PersistedTurn[];
  updatedAt: number;
}

interface PersistedState {
  threads: Record<string, PersistedThread>;
}

interface ActiveTurn {
  thread: PersistedThread;
  turn: PersistedTurn;
}

interface PendingClientRequest {
  reject: (error: Error) => void;
  resolve: (message: JsonRpcMessage) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MODEL_ID = "e2e-codex-model";
const TOOL_NAME = "clanky_list_workspaces";
const TOOL_CALL_TIMEOUT_MS = 5_000;
const homeDirectory = process.env["HOME"];

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\n");
} else if (!homeDirectory) {
  throw new Error("The E2E Codex fixture requires an isolated HOME directory.");
} else {
  await serve(join(homeDirectory, ".codex", "e2e-control-threads.json"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`The persisted Codex fixture ${name} is invalid.`);
  }
  return value;
}

function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
  if (!isRecord(value)) {
    throw new Error("The Codex fixture received a non-object JSON-RPC frame.");
  }
  const id = value["id"];
  if (id !== undefined && typeof id !== "string" && typeof id !== "number") {
    throw new Error("The Codex fixture received an invalid JSON-RPC id.");
  }
  const method = value["method"];
  if (method !== undefined && typeof method !== "string") {
    throw new Error("The Codex fixture received an invalid JSON-RPC method.");
  }
  const rawError = value["error"];
  if (
    rawError !== undefined
    && (
      !isRecord(rawError)
      || typeof rawError["code"] !== "number"
      || typeof rawError["message"] !== "string"
    )
  ) {
    throw new Error("The Codex fixture received an invalid JSON-RPC error.");
  }
  return {
    ...(id === undefined ? {} : { id }),
    ...(method === undefined ? {} : { method }),
    ...(Object.hasOwn(value, "params") ? { params: value["params"] } : {}),
    ...(Object.hasOwn(value, "result") ? { result: value["result"] } : {}),
    ...(isRecord(rawError) && typeof rawError["code"] === "number" && typeof rawError["message"] === "string"
      ? { error: { code: rawError["code"], message: rawError["message"] } }
      : {}),
  };
}

function parseTurn(value: unknown): PersistedTurn {
  if (!isRecord(value)) {
    throw new Error("The persisted Codex fixture turn is invalid.");
  }
  const status = value["status"];
  if (
    status !== "completed"
    && status !== "failed"
    && status !== "inProgress"
    && status !== "interrupted"
  ) {
    throw new Error("The persisted Codex fixture turn status is invalid.");
  }
  return {
    id: requireString(value["id"], "turn id"),
    status,
    items: Array.isArray(value["items"]) ? value["items"] : [],
    startedAt: typeof value["startedAt"] === "number" ? value["startedAt"] : 0,
    completedAt: typeof value["completedAt"] === "number" ? value["completedAt"] : null,
    error: isRecord(value["error"]) && typeof value["error"]["message"] === "string"
      ? { message: value["error"]["message"] }
      : null,
  };
}

function parseThread(value: unknown): PersistedThread {
  if (!isRecord(value)) {
    throw new Error("The persisted Codex fixture thread is invalid.");
  }
  const status = value["status"];
  if (status !== "active" && status !== "idle") {
    throw new Error("The persisted Codex fixture thread status is invalid.");
  }
  return {
    id: requireString(value["id"], "thread id"),
    cwd: requireString(value["cwd"], "thread cwd"),
    model: requireString(value["model"], "thread model"),
    createdAt: typeof value["createdAt"] === "number" ? value["createdAt"] : 0,
    updatedAt: typeof value["updatedAt"] === "number" ? value["updatedAt"] : 0,
    status,
    dynamicTools: Array.isArray(value["dynamicTools"]) ? value["dynamicTools"] : [],
    turns: Array.isArray(value["turns"]) ? value["turns"].map(parseTurn) : [],
  };
}

async function loadState(path: string): Promise<PersistedState> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { threads: {} };
  }
  const value: unknown = JSON.parse(await file.text());
  if (!isRecord(value) || !isRecord(value["threads"])) {
    throw new Error("The persisted Codex fixture state is invalid.");
  }
  const threads: Record<string, PersistedThread> = {};
  for (const [id, thread] of Object.entries(value["threads"])) {
    threads[id] = parseThread(thread);
  }
  return { threads };
}

async function serve(statePath: string): Promise<void> {
  const state = await loadState(statePath);
  const pendingRequests = new Map<JsonRpcId, PendingClientRequest>();
  let nextRequestId = 0;

  async function persist(): Promise<void> {
    await Bun.write(statePath, JSON.stringify(state));
  }

  function writeMessage(message: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  function notify(method: string, params: Record<string, unknown>): void {
    writeMessage({ method, params });
  }

  function buildThread(thread: PersistedThread, includeTurns = false): Record<string, unknown> {
    return {
      id: thread.id,
      environments: null,
      extra: null,
      sessionId: thread.id,
      forkedFromId: null,
      parentThreadId: null,
      preview: "",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "legacy",
      modelProvider: "openai",
      model: thread.model,
      reasoningEffort: null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      recencyAt: thread.updatedAt,
      status: thread.status === "idle" ? { type: "idle" } : { type: "active", activeFlags: [] },
      path: null,
      cwd: thread.cwd,
      cliVersion: "0.160.1",
      originator: "codex",
      source: { type: "appServer" },
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      daybreakEnabled: null,
      turns: includeTurns ? thread.turns : [],
    };
  }

  function buildTurn(turn: PersistedTurn): Record<string, unknown> {
    return {
      id: turn.id,
      items: turn.items,
      itemsView: "all",
      status: turn.status,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.completedAt === null ? null : Math.max(0, (turn.completedAt - turn.startedAt) * 1000),
    };
  }

  function findThread(params: Record<string, unknown>): PersistedThread {
    const threadId = requireString(params["threadId"], "request thread id");
    const thread = state.threads[threadId];
    if (!thread) {
      throw new Error(`The Codex fixture thread ${threadId} does not exist.`);
    }
    return thread;
  }

  function requestClient(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    const id = `clanky-tool-${String(++nextRequestId)}`;
    return new Promise<JsonRpcMessage>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        rejectPromise(new Error(`Clanky did not answer ${method} within ${TOOL_CALL_TIMEOUT_MS}ms.`));
      }, TOOL_CALL_TIMEOUT_MS);
      pendingRequests.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });
      writeMessage({ id, method, params });
    });
  }

  async function beginTurn(params: Record<string, unknown>): Promise<ActiveTurn> {
    const thread = findThread(params);
    if (thread.status !== "idle") {
      throw new Error("The Codex fixture thread already has an active turn.");
    }
    const now = Date.now() / 1000;
    const turn: PersistedTurn = {
      id: randomUUID(),
      status: "inProgress",
      items: [],
      startedAt: now,
      completedAt: null,
      error: null,
    };
    thread.status = "active";
    thread.updatedAt = now;
    thread.turns.push(turn);
    await persist();
    return { thread, turn };
  }

  function readToolText(value: unknown): { contentItems: unknown[]; success: boolean; text: string } {
    const result = isRecord(value) ? value : {};
    const contentItems = Array.isArray(result["contentItems"]) ? result["contentItems"] : [];
    const text = contentItems
      .map((item) => isRecord(item) && typeof item["text"] === "string" ? item["text"] : "")
      .filter((entry) => entry.length > 0)
      .join("\n");
    return {
      contentItems,
      success: result["success"] === true,
      text: text || JSON.stringify(result),
    };
  }

  async function completeTurn(active: ActiveTurn): Promise<void> {
    const { thread, turn } = active;
    notify("turn/started", {
      threadId: thread.id,
      turn: buildTurn(turn),
    });
    const hasTool = thread.dynamicTools.some(
      (definition) => isRecord(definition) && definition["name"] === TOOL_NAME,
    );
    const callId = randomUUID();
    const argumentsValue = {};
    const startedAtMs = Date.now();
    const toolItem = {
      type: "dynamicToolCall",
      id: callId,
      namespace: null,
      tool: TOOL_NAME,
      arguments: argumentsValue,
      status: "inProgress",
      contentItems: null,
      success: null,
      durationMs: null,
    };
    let assistantText = "The persisted control tool definition was unavailable after resume.";
    let completedToolItem: Record<string, unknown> | undefined;

    if (hasTool) {
      notify("item/started", {
        item: toolItem,
        threadId: thread.id,
        turnId: turn.id,
        startedAtMs,
      });
      const response = await requestClient("item/tool/call", {
        threadId: thread.id,
        turnId: turn.id,
        callId,
        namespace: null,
        tool: TOOL_NAME,
        arguments: argumentsValue,
      });
      const toolResult = readToolText(response.result);
      completedToolItem = {
        ...toolItem,
        status: toolResult.success ? "completed" : "failed",
        contentItems: toolResult.contentItems,
        success: toolResult.success,
        durationMs: Date.now() - startedAtMs,
      };
      assistantText = `Clanky workspace list: ${toolResult.text}`;
      turn.items.push(completedToolItem);
      notify("item/completed", {
        item: completedToolItem,
        threadId: thread.id,
        turnId: turn.id,
        completedAtMs: Date.now(),
      });
    }

    const messageItem = {
      type: "agentMessage",
      id: randomUUID(),
      text: assistantText,
      phase: null,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    turn.items.push(messageItem);
    notify("item/started", {
      item: messageItem,
      threadId: thread.id,
      turnId: turn.id,
      startedAtMs: Date.now(),
    });
    notify("item/completed", {
      item: messageItem,
      threadId: thread.id,
      turnId: turn.id,
      completedAtMs: Date.now(),
    });

    const completedAt = Date.now() / 1000;
    turn.status = "completed";
    turn.completedAt = completedAt;
    thread.status = "idle";
    thread.updatedAt = completedAt;
    await persist();
    notify("thread/status/changed", {
      threadId: thread.id,
      status: { type: "idle" },
    });
    notify("turn/completed", {
      threadId: thread.id,
      turn: buildTurn(turn),
    });
  }

  async function dispatch(method: string, rawParams: unknown): Promise<unknown> {
    const params = isRecord(rawParams) ? rawParams : {};
    switch (method) {
      case "initialize":
        return { userAgent: "codex-cli 0.160.1" };
      case "model/list":
        return {
          data: [{
            id: MODEL_ID,
            model: MODEL_ID,
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "E2E Codex model",
            description: "Deterministic external Codex app-server fixture",
            modelSpecialty: null,
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Default" }],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            supportsPersonality: false,
            multiAgentVersion: null,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            availableAccessPrograms: null,
            isDefault: true,
          }],
          nextCursor: null,
        };
      case "config/read":
        return {
          config: { features: { hooks: { enabled: true } } },
          origins: {},
          layers: null,
        };
      case "configRequirements/read":
        return { requirements: null };
      case "thread/start": {
        const now = Date.now() / 1000;
        const thread: PersistedThread = {
          id: randomUUID(),
          cwd: typeof params["cwd"] === "string" ? params["cwd"] : process.cwd(),
          model: typeof params["model"] === "string" ? params["model"] : MODEL_ID,
          createdAt: now,
          updatedAt: now,
          status: "idle",
          dynamicTools: Array.isArray(params["dynamicTools"]) ? params["dynamicTools"] : [],
          turns: [],
        };
        state.threads[thread.id] = thread;
        await persist();
        return { thread: buildThread(thread) };
      }
      case "thread/resume": {
        const thread = findThread(params);
        thread.status = "idle";
        return {
          thread: buildThread(thread, params["excludeTurns"] !== true),
          model: thread.model,
          modelProvider: "openai",
          serviceTier: null,
        };
      }
      case "thread/read": {
        const thread = findThread(params);
        return { thread: buildThread(thread, params["includeTurns"] === true) };
      }
      case "thread/list":
        return { data: [], nextCursor: null, backwardsCursor: null };
      case "thread/turns/list": {
        const thread = findThread(params);
        return { data: [...thread.turns].reverse(), nextCursor: null, backwardsCursor: null };
      }
      case "thread/items/list":
        return { data: [], nextCursor: null, backwardsCursor: null };
      case "thread/backgroundTerminals/list":
        return { data: [] };
      case "thread/backgroundTerminals/terminate":
        return { terminated: true };
      case "thread/delete": {
        const threadId = requireString(params["threadId"], "delete thread id");
        delete state.threads[threadId];
        await persist();
        return {};
      }
      default:
        throw Object.assign(new Error(`Unsupported Codex fixture method: ${method}`), { code: -32601 });
    }
  }

  async function handleFrame(frame: JsonRpcMessage): Promise<void> {
    if (!frame.method) {
      if (frame.id !== undefined) {
        const pending = pendingRequests.get(frame.id);
        if (pending) {
          pendingRequests.delete(frame.id);
          clearTimeout(pending.timer);
          if (frame.error) {
            pending.reject(new Error(frame.error.message));
          } else {
            pending.resolve(frame);
          }
        }
      }
      return;
    }
    if (frame.method === "initialized" || frame.id === undefined) {
      return;
    }

    try {
      if (frame.method === "turn/start") {
        const active = await beginTurn(isRecord(frame.params) ? frame.params : {});
        writeMessage({ id: frame.id, result: { turn: buildTurn(active.turn) } });
        void completeTurn(active).catch(async (error: unknown) => {
          active.thread.status = "idle";
          active.thread.updatedAt = Date.now() / 1000;
          active.turn.status = "failed";
          active.turn.completedAt = active.thread.updatedAt;
          active.turn.error = { message: String(error) };
          await persist();
          notify("turn/completed", {
            threadId: active.thread.id,
            turn: buildTurn(active.turn),
          });
        });
        return;
      }
      const result = await dispatch(frame.method, frame.params);
      writeMessage({ id: frame.id, result });
    } catch (error) {
      const code = isRecord(error) && typeof error["code"] === "number" ? error["code"] : -32000;
      writeMessage({
        id: frame.id,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    let frame: JsonRpcMessage;
    try {
      frame = parseJsonRpcMessage(JSON.parse(line) as unknown);
    } catch (error) {
      process.stderr.write(`codex-e2e: invalid JSON-RPC frame: ${String(error)}\n`);
      process.exitCode = 1;
      break;
    }
    await handleFrame(frame);
  }

  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("The Codex fixture closed before the request completed."));
  }
  pendingRequests.clear();
}
