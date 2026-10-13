/**
 * Runs one deterministic turn and emits its public Codex event sequence.
 */

import type { ActiveTurn, CodexFixtureStore } from "./codex-state";
import type { CodexJsonRpcSession } from "./codex-json-rpc";
import { buildTurn, buildTurnSummary } from "./codex-protocol";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readCodexImageReceipts } from "./image-input";
import { createPng } from "../support/png-fixtures";

const TOOL_NAME = "clanky_list_workspaces";
const GENERATED_IMAGE_PROMPT = "Generate a PNG larger than two MiB.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistedTool(thread: ActiveTurn["thread"]): boolean {
  return thread.dynamicTools.some(
    (definition) => isRecord(definition) && definition["name"] === TOOL_NAME,
  );
}

function imageReceipts(turn: ActiveTurn["turn"]): string[] {
  return turn.items.flatMap((item) => {
    if (!isRecord(item) || item["type"] !== "userMessage") return [];
    return readCodexImageReceipts(item["content"]);
  });
}

function requestsGeneratedImage(turn: ActiveTurn["turn"]): boolean {
  return JSON.stringify(turn.items).includes(GENERATED_IMAGE_PROMPT);
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

async function emitGeneratedImage(active: ActiveTurn, rpc: CodexJsonRpcSession): Promise<void> {
  const { thread, turn } = active;
  const image = createPng(768, 700);
  const savedPath = join(thread.cwd, ".clanky-e2e-generated-image.png");
  const id = randomUUID();
  await Bun.write(savedPath, image);
  rpc.notify("item/started", {
    item: {
      type: "imageGeneration",
      id,
      status: "inProgress",
      revisedPrompt: null,
      result: "",
      failure: null,
    },
    threadId: thread.id,
    turnId: turn.id,
    startedAtMs: Date.now(),
  });
  const item = {
    type: "imageGeneration",
    id,
    status: "completed",
    revisedPrompt: null,
    result: image.toString("base64"),
    failure: null,
    savedPath,
  };
  turn.items.push(item);
  rpc.notify("item/completed", {
    item,
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
  const steering = await store.waitForSteering(active);
  let answer = "";
  if (JSON.stringify(turn.items).includes("Ask one Live question")) {
    const response = await rpc.requestClient("item/tool/requestUserInput", {
      threadId: thread.id, turnId: turn.id, itemId: randomUUID(), isBlocking: true,
      questions: [{ id: "format", header: "Result format", question: "Which format should I use?",
        isOther: false, isSecret: false, options: [{ label: "Names only", description: "Workspace names" }] }],
    });
    const value = isRecord(response.result) ? response.result["answers"] : undefined;
    const format = isRecord(value) ? value["format"] : undefined;
    answer = isRecord(format) && Array.isArray(format["answers"]) ? format["answers"].join(", ") : "No answer confirmed";
  }
  const assistantText = persistedTool(thread)
    ? await runWorkspaceListTool(active, rpc)
    : "The persisted control tool definition was unavailable after resume.";
  const responseText = steering
    ? `${assistantText}\nSteered instruction: ${steering}`
    : answer
      ? `${assistantText}\nQuestion answer: ${answer}`
      : assistantText;
  const imageReceiptText = imageReceipts(turn).join("\n");
  emitAssistantMessage(active, imageReceiptText ? `${responseText}\n${imageReceiptText}` : responseText, rpc);
  if (requestsGeneratedImage(turn)) await emitGeneratedImage(active, rpc);
  await store.completeTurn(active);
  rpc.notify("thread/status/changed", {
    threadId: thread.id,
    status: { type: "idle" },
  });
  rpc.notify("turn/completed", {
    threadId: thread.id,
    turn: buildTurnSummary(turn),
  });
}
