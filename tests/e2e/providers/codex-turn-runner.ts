/**
 * Runs one deterministic turn and emits its public Codex event sequence.
 */

import type { ActiveTurn, CodexFixtureStore } from "./codex-state";
import type { CodexJsonRpcSession } from "./codex-json-rpc";
import { buildThread, buildTurn, buildTurnSummary } from "./codex-protocol";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readCodexImageReceipts } from "./image-input";
import { createPng } from "../support/png-fixtures";
import { inspectAttachedFiles } from "./file-input";
import {
  BACKGROUND_DELEGATED, backgroundFollowUp, backgroundWork, readBackgroundFile, type BackgroundWork,
} from "./background-work";

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
  turn.itemTimes[callId] = { startedAtMs, completedAtMs: Date.now() };
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
  turn.itemTimes[messageItem.id] = { startedAtMs: Date.now(), completedAtMs: Date.now() };
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
  if (turn.status !== "inProgress") return;
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
  turn.itemTimes[id] = { startedAtMs: Date.now(), completedAtMs: Date.now() };
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
  const prompt = turn.items.flatMap((item) =>
    isRecord(item) && item["type"] === "userMessage" && Array.isArray(item["content"])
      ? item["content"].flatMap((part: unknown) =>
          isRecord(part) && part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : [],
        )
      : [],
  ).join("\n");
  const delegated = backgroundWork(prompt);
  if (delegated) {
    const childThread = await store.createThread({ cwd: thread.cwd, parentThreadId: thread.id }, thread.model);
    rpc.notify("thread/started", { thread: buildThread(childThread) });
    const child = await store.beginTurn({ threadId: childThread.id,
      input: [{ type: "text", text: "Inspect the reusable modules and report the inventory.", text_elements: [] }] });
    rpc.notify("turn/started", { threadId: childThread.id, turn: buildTurn(child.turn) });
    rpc.notify("item/started", { threadId: childThread.id, turnId: child.turn.id, item: child.turn.items[0], startedAtMs: Date.now() });
    rpc.notify("item/completed", { threadId: childThread.id, turnId: child.turn.id, item: child.turn.items[0], completedAtMs: Date.now() });
    rpc.notify("item/agentMessage/delta", { threadId: childThread.id, turnId: child.turn.id,
      itemId: `${childThread.id}:response`, delta: "Inspecting reusable modules..." });
    rpc.notify("item/reasoning/textDelta", { threadId: childThread.id, turnId: child.turn.id,
      itemId: `${childThread.id}:reasoning`, contentIndex: 0, delta: "Checking the reusable modules." });
    emitAssistantMessage(active, BACKGROUND_DELEGATED, rpc);
    await store.completeTurn(active);
    notifyCodexTurnCompleted(active, rpc);
    await continueCodexBackground(thread.id, delegated, store, rpc, child);
    return;
  }
  if (thread.backgroundResult) {
    emitAssistantMessage(active, backgroundFollowUp(prompt, thread.backgroundResult), rpc);
    await store.completeTurn(active);
    notifyCodexTurnCompleted(active, rpc);
    return;
  }
  const steering = await store.waitForSteering(active);
  if (turn.status !== "inProgress") return;
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
  if (turn.status !== "inProgress") return;
  const assistantText = persistedTool(thread)
    ? await runWorkspaceListTool(active, rpc)
    : "The persisted control tool definition was unavailable after resume.";
  if (turn.status !== "inProgress") return;
  const responseText = steering
    ? `${assistantText}\nSteered instruction: ${steering}`
    : answer
      ? `${assistantText}\nQuestion answer: ${answer}`
      : assistantText;
  const imageReceiptText = imageReceipts(turn).join("\n");
  const fileReceipt = await inspectAttachedFiles(prompt, thread.cwd);
  emitAssistantMessage(active, [responseText, imageReceiptText, fileReceipt].filter(Boolean).join("\n"), rpc);
  if (requestsGeneratedImage(turn)) await emitGeneratedImage(active, rpc);
  if (turn.status !== "inProgress") return;
  await store.completeTurn(active);
  notifyCodexTurnCompleted(active, rpc);
}

async function continueCodexBackground(
  threadId: string,
  work: BackgroundWork,
  store: CodexFixtureStore,
  rpc: CodexJsonRpcSession,
  child: ActiveTurn,
): Promise<void> {
  const controller = store.ownBackground(threadId);
  let active: ActiveTurn | undefined;
  try {
    const report = await readBackgroundFile(work.resultPath, controller.signal);
    if (report === undefined) return;
    const childItem = { type: "dynamicToolCall", id: `${child.thread.id}:read`, namespace: null,
      tool: "read_file", arguments: { path: work.resultPath }, status: "completed", contentItems: [
        { type: "inputText", text: report }, { type: "inputImage", imageUrl: `data:image/png;base64,${createPng(2, 2).toString("base64")}` },
      ],
      success: true, durationMs: 0 };
    child.turn.items.push(childItem);
    child.turn.itemTimes[childItem.id] = { startedAtMs: Date.now(), completedAtMs: Date.now() };
    rpc.notify("item/started", { threadId: child.thread.id, turnId: child.turn.id, item: { ...childItem, status: "inProgress", contentItems: null }, startedAtMs: Date.now() });
    rpc.notify("item/completed", { threadId: child.thread.id, turnId: child.turn.id, item: childItem, completedAtMs: Date.now() });
    const reasoning = { type: "reasoning", id: `${child.thread.id}:reasoning`, summary: [], content: ["Checking the reusable modules. The inventory is ready."] };
    child.turn.items.push(reasoning);
    rpc.notify("item/completed", { threadId: child.thread.id, turnId: child.turn.id, item: reasoning, completedAtMs: Date.now() });
    const response = { type: "agentMessage", id: `${child.thread.id}:response`, text: `Subagent findings: ${report}`, phase: null, memoryCitation: null, delivery: null, questions: null };
    child.turn.items.push(response);
    rpc.notify("item/completed", { threadId: child.thread.id, turnId: child.turn.id, item: response, completedAtMs: Date.now() });
    await store.completeTurn(child);
    notifyCodexTurnCompleted(child, rpc);
    active = await store.beginTurn({ threadId, input: [] });
    active.thread.backgroundResult = report;
    rpc.notify("turn/started", { threadId, turn: buildTurn(active.turn) });
    const item = {
      type: "dynamicToolCall", id: randomUUID(), namespace: null,
      tool: "read_file", arguments: { path: work.resultPath },
      status: "inProgress", contentItems: null, success: null, durationMs: null,
    };
    rpc.notify("item/started", { threadId, turnId: active.turn.id, item, startedAtMs: Date.now() });
    const completed = {
      ...item, status: "completed", success: true, durationMs: 0,
      contentItems: [{ type: "inputText", text: report }],
    };
    active.turn.items.push(completed);
    active.turn.itemTimes[item.id] = { startedAtMs: Date.now(), completedAtMs: Date.now() };
    rpc.notify("item/completed", {
      threadId, turnId: active.turn.id, item: completed, completedAtMs: Date.now(),
    });
    emitAssistantMessage(active, `Background report: ${report}`, rpc);
    await store.persist();
    if (await readBackgroundFile(work.releasePath, controller.signal) === undefined) return;
    if (active.turn.status !== "inProgress") return;
    await store.completeTurn(active);
    notifyCodexTurnCompleted(active, rpc);
  } catch (error) {
    if (!controller.signal.aborted && active) {
      await store.failTurn(active, error);
      notifyCodexTurnCompleted(active, rpc);
    } else if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    store.releaseBackground(threadId, controller);
  }
}

export function notifyCodexTurnCompleted({ thread, turn }: ActiveTurn, rpc: CodexJsonRpcSession): void {
  const calls = thread.turns.flatMap((entry) => entry.items)
    .filter((item) => isRecord(item) && item["type"] === "agentMessage").length;
  const usage = {
    totalTokens: calls * 150, inputTokens: calls * 100, outputTokens: calls * 50,
    cachedInputTokens: calls * 25, cacheWriteInputTokens: calls * 5, reasoningOutputTokens: calls * 10,
  };
  rpc.notify("thread/tokenUsage/updated", {
    threadId: thread.id, turnId: turn.id,
    tokenUsage: { total: usage, last: { totalTokens: 150, inputTokens: 100, outputTokens: 50,
      cachedInputTokens: 25, cacheWriteInputTokens: 5, reasoningOutputTokens: 10 }, modelContextWindow: 200_000 },
  });
  rpc.notify("thread/status/changed", {
    threadId: thread.id,
    status: { type: "idle" },
  });
  rpc.notify("turn/completed", {
    threadId: thread.id,
    turn: buildTurnSummary(turn),
  });
}
