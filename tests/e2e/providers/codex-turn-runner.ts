/**
 * Runs one deterministic turn and emits its public Codex event sequence.
 */

import type { ActiveTurn, CodexFixtureStore } from "./codex-state";
import type { CodexJsonRpcSession } from "./codex-json-rpc";
import { buildTurn } from "./codex-protocol";
import { randomUUID } from "node:crypto";

const TOOL_NAME = "clanky_list_workspaces";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistedTool(thread: ActiveTurn["thread"]): boolean {
  return thread.dynamicTools.some(
    (definition) => isRecord(definition) && definition["name"] === TOOL_NAME,
  );
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

async function runWorkspaceListTool(
  active: ActiveTurn,
  rpc: CodexJsonRpcSession,
): Promise<string> {
  const { thread, turn } = active;
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
  rpc.notify("item/started", {
    item: toolItem,
    threadId: thread.id,
    turnId: turn.id,
    startedAtMs,
  });
  const response = await rpc.requestClient("item/tool/call", {
    threadId: thread.id,
    turnId: turn.id,
    callId,
    namespace: null,
    tool: TOOL_NAME,
    arguments: argumentsValue,
  });
  const toolResult = readToolText(response.result);
  const completedToolItem = {
    ...toolItem,
    status: toolResult.success ? "completed" : "failed",
    contentItems: toolResult.contentItems,
    success: toolResult.success,
    durationMs: Date.now() - startedAtMs,
  };
  turn.items.push(completedToolItem);
  rpc.notify("item/completed", {
    item: completedToolItem,
    threadId: thread.id,
    turnId: turn.id,
    completedAtMs: Date.now(),
  });
  return `Clanky workspace list: ${toolResult.text}`;
}

function emitAssistantMessage(active: ActiveTurn, text: string, rpc: CodexJsonRpcSession): void {
  const { thread, turn } = active;
  const messageItem = {
    type: "agentMessage",
    id: randomUUID(),
    text,
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  turn.items.push(messageItem);
  rpc.notify("item/started", {
    item: messageItem,
    threadId: thread.id,
    turnId: turn.id,
    startedAtMs: Date.now(),
  });
  rpc.notify("item/completed", {
    item: messageItem,
    threadId: thread.id,
    turnId: turn.id,
    completedAtMs: Date.now(),
  });
}

export async function runCodexTurn(
  active: ActiveTurn,
  store: CodexFixtureStore,
  rpc: CodexJsonRpcSession,
): Promise<void> {
  const { thread, turn } = active;
  rpc.notify("turn/started", { threadId: thread.id, turn: buildTurn(turn) });
  const assistantText = persistedTool(thread)
    ? await runWorkspaceListTool(active, rpc)
    : "The persisted control tool definition was unavailable after resume.";
  emitAssistantMessage(active, assistantText, rpc);
  await store.completeTurn(active);
  rpc.notify("thread/status/changed", {
    threadId: thread.id,
    status: { type: "idle" },
  });
  rpc.notify("turn/completed", {
    threadId: thread.id,
    turn: buildTurn(turn),
  });
}
