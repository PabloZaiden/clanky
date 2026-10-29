/**
 * External Copilot SDK stdio peer with durable sessions and immediate steering.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseJsonRpcMessage, type JsonRpcId, type JsonRpcMessage } from "./codex-json-rpc";
import { readCopilotImageReceipts } from "./image-input";
import { inspectAttachedFiles } from "./file-input";
import { createPng } from "../support/png-fixtures";
import {
  BACKGROUND_DELEGATED, backgroundFollowUp, backgroundWork, readBackgroundFile, type BackgroundWork,
} from "./background-work";

const MAX_FRAME_BYTES = 96 * 1024 * 1024;

interface Session {
  id: string;
  directory: string;
  model: string;
  tools: Array<{ name: string }>;
  metadata: Record<string, string>;
  processing: boolean;
  prompt: string;
  events: Array<Record<string, unknown>>;
  result?: string;
  control?: {
    requests: Array<{ name: string; input: Record<string, unknown> }>;
    results: unknown[];
  };
  backgroundResult?: string;
  usage: Record<string, { inputTokens: number; outputTokens: number; reasoningTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>;
  children?: Array<{
    id: string; toolCallId: string; description: string; prompt: string; status: string; startedAt: string; parentId?: string;
  }>;
}

const sessions = new Map<string, Session>();
const pending = new Map<string, { session: Session; name: string; timer: ReturnType<typeof setTimeout> }>();
const waiting = new Map<string, AbortController>();
const background = new Map<string, { controller: AbortController; operation: Promise<void> }>();
const stateDirectory = join(process.env["HOME"]!, "copilot-native-sessions");
await mkdir(stateDirectory, { recursive: true });

function sessionPath(id: string): string {
  return join(stateDirectory, `${encodeURIComponent(id)}.json`);
}

async function loadSession(id: string): Promise<Session | undefined> {
  const existing = sessions.get(id);
  if (existing) return existing;
  const file = Bun.file(sessionPath(id));
  if (!await file.exists()) return undefined;
  const session: Session = { ...await file.json(), processing: false };
  sessions.set(id, session);
  return session;
}

async function save(): Promise<void> {
  await Promise.all([...sessions.values()].map((session) =>
    Bun.write(sessionPath(session.id), JSON.stringify(session)),
  ));
}

function write(message: Record<string, unknown>): void {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function event(session: Session, type: string, data: Record<string, unknown>, agentId?: string): void {
  if (type === "assistant.message") {
    const usage = session.usage[session.model] ??= {
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    };
    usage.inputTokens += 100;
    usage.outputTokens += 50;
    usage.reasoningTokens += 10;
    usage.cacheReadTokens += 25;
    usage.cacheWriteTokens += 5;
  }
  const value = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), parentId: null, type, data, ...(agentId ? { agentId } : {}) };
  session.events.push(value);
  session.events = session.events.slice(-500);
  write({ method: "session.event", params: { sessionId: session.id, event: value } });
}

function idle(session: Session, data: { aborted?: boolean } = {}): void {
  session.processing = false;
  event(session, "assistant.idle", data);
  event(session, "session.idle", data);
}

function finish(session: Session, content: string): void {
  event(session, "assistant.message", { messageId: crypto.randomUUID(), content });
  idle(session);
}

function requestTool(session: Session, name: string, args: Record<string, unknown>): void {
  const id = crypto.randomUUID();
  const timer = setTimeout(() => {
    pending.delete(id);
    event(session, "session.error", { errorType: "protocol", message: `Timed out waiting for ${name}.` });
    idle(session);
  }, 5_000);
  pending.set(id, { session, name, timer });
  event(session, "tool.execution_start", { toolCallId: id, toolName: name, arguments: args });
  event(session, "external_tool.requested", { requestId: id, toolCallId: id, toolName: name, arguments: args });
}

function execute(session: Session): void {
  if (session.backgroundResult) {
    finish(session, backgroundFollowUp(session.prompt, session.backgroundResult));
    return;
  }
  const requests = session.prompt.split("\n")
    .filter((line) => line.startsWith("Control request: "))
    .flatMap((line) => JSON.parse(line.slice("Control request: ".length)));
  if (requests.length) {
    session.control = { requests, results: [] };
    requestTool(session, requests[0]!.name, requests[0]!.input);
    return;
  }
  if (!session.tools.some((tool) => tool.name === "clanky_list_workspaces")) {
    finish(session, `Agent received: ${session.prompt}\nClanky tools unavailable.`);
    return;
  }
  requestTool(session, "clanky_list_workspaces", {});
}

async function toolResult(params: Record<string, unknown>): Promise<void> {
  const id = String(params["requestId"]);
  const request = pending.get(id);
  if (!request) throw new Error("Unexpected Copilot tool result.");
  pending.delete(id);
  clearTimeout(request.timer);
  const { session, name } = request;
  const raw = params["result"];
  const result = typeof raw === "string" ? JSON.parse(raw) : raw;
  event(session, "tool.execution_complete", { toolCallId: id, result, success: !params["error"] });
  event(session, "external_tool.completed", { requestId: id });
  if (session.control) {
    const control = session.control;
    control.results.push(result);
    const next = control.requests[control.results.length];
    if (next) {
      requestTool(session, next.name, next.input);
      return;
    }
    session.control = undefined;
    let planningReceipt = "";
    if (session.prompt.includes("<promise>PLAN_READY</promise>")) {
      await mkdir(join(session.directory, ".clanky-planning"), { recursive: true });
      await Bun.write(join(session.directory, ".clanky-planning", "plan.md"), "# Project collaboration plan\nUse the inspected project reference.");
      await Bun.write(join(session.directory, ".clanky-planning", "status.md"), "Project reference inspected; awaiting plan approval.");
      planningReceipt = "\n<promise>PLAN_READY</promise>";
    }
    finish(session, `Control results: ${JSON.stringify(control.results)}${planningReceipt}`);
    return;
  }
  if (name === "clanky_list_workspaces") {
    session.result = `Agent received: ${session.prompt}\nClanky workspace list: ${JSON.stringify(result)}`;
    const workspace = result?.items?.[0];
    if (session.prompt.includes("open the workspace") && workspace?.id) {
      requestTool(session, "clanky_ui_action", {
        action: { type: "open_workspace", workspaceId: workspace.id },
      });
      return;
    }
  } else {
    session.result += `\nBrowser action: ${JSON.stringify(result)}`;
  }
  finish(session, session.result ?? `Tool failure: ${String(params["error"])}`);
}

async function sendInput(session: Session | undefined, params: Record<string, unknown>, id: JsonRpcId): Promise<void> {
  if (!session) throw new Error("Copilot session unavailable.");
  const messageId = crypto.randomUUID();
  const prompt = String(params["prompt"]);
  const fileReceipt = await inspectAttachedFiles(prompt, session.directory, [session.prompt]);
  const promptWithImages = [prompt, ...readCopilotImageReceipts(params["attachments"]), fileReceipt].filter(Boolean).join("\n");
  if (session.processing && params["mode"] !== "immediate") throw new Error("Active input requires immediate mode.");
  write({ id, result: { messageId } });
  event(session, "user.message", { messageId, content: prompt });
  if (session.processing) {
    session.prompt += `\nSteered instruction: ${promptWithImages}`;
    execute(session);
  } else {
    session.processing = true;
    session.prompt = promptWithImages;
    event(session, "assistant.turn_start", { turnId: crypto.randomUUID() });
    const delegated = backgroundWork(prompt);
    const releaseFile = /\[wait-for-file:([^\]\r\n]+)\]/.exec(prompt)?.[1];
    if (delegated) {
      if (prompt.includes("<promise>PLAN_READY</promise>")) {
        void startBackground(session, delegated);
      } else {
        finish(session, BACKGROUND_DELEGATED);
        await save();
        void startBackground(session, delegated);
      }
    } else if (releaseFile) {
      const controller = new AbortController();
      waiting.set(session.id, controller);
      event(session, "assistant.message", { messageId: crypto.randomUUID(), content: "Waiting for the integration input file." });
      void completeAfterInputFile(session, releaseFile, controller).catch((error: unknown) => {
        event(session, "session.error", { errorType: "protocol", message: String(error) });
        idle(session);
      });
    } else if (!prompt.startsWith("Wait for a steering instruction")) execute(session);
  }
  await save();
}

function startBackground(session: Session, work: BackgroundWork): Promise<void> {
  const child = {
    id: crypto.randomUUID(), toolCallId: crypto.randomUUID(), description: "Workspace inventory",
    prompt: "Inspect the reusable modules and report the inventory.", status: "running", startedAt: new Date().toISOString(),
  };
  const nested = {
    id: crypto.randomUUID(), toolCallId: crypto.randomUUID(), description: "Inventory verification",
    prompt: "Verify the inventory findings.", status: "completed", startedAt: new Date().toISOString(), parentId: child.id,
  };
  session.children = [child, nested];
  for (const agent of session.children) {
    event(session, "subagent.started", {
      agentName: "explore", agentDescription: agent.description, agentDisplayName: agent.description,
      toolCallId: agent.toolCallId, parentId: agent.parentId,
    }, agent.id);
    event(session, "user.message", { messageId: `${agent.id}:input`, content: agent.prompt }, agent.id);
  }
  event(session, "assistant.message", { messageId: `${nested.id}:response`, content: "Nested review complete." }, nested.id);
  event(session, "assistant.idle", {}, nested.id);
  event(session, "subagent.completed", { agentName: "explore", toolCallId: nested.toolCallId }, nested.id);
  event(session, "assistant.message_start", { messageId: `${child.id}:response` }, child.id);
  event(session, "assistant.message_delta", { messageId: `${child.id}:response`, deltaContent: "Inspecting reusable modules..." }, child.id);
  event(session, "assistant.reasoning_delta", { reasoningId: `${child.id}:reasoning`, deltaContent: "Checking the reusable modules." }, child.id);
  const controller = new AbortController();
  // This owned native child outlives the admitting principal turn, not its session.
  const operation = continueBackground(session, work, controller.signal)
    .catch((error: unknown) => {
      if (controller.signal.aborted) return;
      event(session, "session.error", { errorType: "protocol", message: String(error) });
      idle(session);
      return save();
    })
    .finally(() => { background.delete(session.id); });
  background.set(session.id, { controller, operation });
  return operation;
}

async function continueBackground(session: Session, work: BackgroundWork, signal: AbortSignal): Promise<void> {
  const report = await readBackgroundFile(work.resultPath, signal);
  if (report === undefined) return;
  const child = session.children?.find((entry) => !entry.parentId);
  if (child) {
    event(session, "tool.execution_start", { toolCallId: `${child.id}:read`, toolName: "read_file", arguments: { path: work.resultPath } }, child.id);
    event(session, "tool.execution_complete", { toolCallId: `${child.id}:read`, result: {
      contents: report, content: [{ type: "image", mimeType: "image/png", data: createPng(2, 2).toString("base64") }],
    }, success: true }, child.id);
    event(session, "assistant.reasoning", { reasoningId: `${child.id}:reasoning`, content: "Checking the reusable modules. The inventory is ready." }, child.id);
    event(session, "assistant.message", { messageId: `${child.id}:response`, content: `Subagent findings: ${report}` }, child.id);
    event(session, "assistant.idle", {}, child.id);
    child.status = "completed";
    event(session, "subagent.completed", { agentName: "explore", toolCallId: child.toolCallId }, child.id);
  }
  session.backgroundResult = report;
  session.processing = true;
  event(session, "assistant.turn_start", { turnId: crypto.randomUUID() });
  const toolCallId = crypto.randomUUID();
  event(session, "tool.execution_start", { toolCallId, toolName: "read_file", arguments: { path: work.resultPath } });
  event(session, "tool.execution_complete", { toolCallId, result: { contents: report }, success: true });
  event(session, "assistant.message", { messageId: crypto.randomUUID(), content: `Background report: ${report}` });
  await save();
  if (await readBackgroundFile(work.releasePath, signal) === undefined) return;
  if (session.prompt.includes("<promise>PLAN_READY</promise>")) {
    await mkdir(join(session.directory, ".clanky-planning"), { recursive: true });
    await Bun.write(join(session.directory, ".clanky-planning", "plan.md"), "Use the reviewed inventory to implement the requested changes.");
    await Bun.write(join(session.directory, ".clanky-planning", "status.md"), "Inventory reviewed; awaiting plan approval.");
    finish(session, "The delegated inventory is reviewed.\n<promise>PLAN_READY</promise>");
  } else idle(session);
  await save();
}

async function stopBackground(sessionId: string): Promise<void> {
  const task = background.get(sessionId);
  task?.controller.abort();
  await task?.operation;
}

async function completeAfterInputFile(session: Session, path: string, controller: AbortController): Promise<void> {
  try {
    // The owning journey bounds each lifecycle and aborts this wait on teardown.
    while (!controller.signal.aborted && !await Bun.file(path).exists()) {
      await Bun.sleep(25);
    }
    if (controller.signal.aborted) return;
    const input = await Bun.file(path).text();
    if (session.prompt.includes("<promise>PLAN_READY</promise>")) {
      await mkdir(join(session.directory, ".clanky-planning"), { recursive: true });
      await Bun.write(join(session.directory, ".clanky-planning", "plan.md"), input);
      await Bun.write(join(session.directory, ".clanky-planning", "status.md"), "Plan prepared for review.");
      finish(session, `${input}\n<promise>PLAN_READY</promise>`);
    } else {
      finish(session, `Integration input: ${input}`);
    }
    await save();
  } finally {
    if (waiting.get(session.id) === controller) waiting.delete(session.id);
  }
}

async function dispatch(frame: JsonRpcMessage): Promise<void> {
  if (frame.id === undefined || !frame.method) return;
  const params = frame.params && typeof frame.params === "object" ? frame.params as Record<string, unknown> : {};
  const session = typeof params["sessionId"] === "string" ? await loadSession(params["sessionId"]) : undefined;
  let result: unknown;
  switch (frame.method) {
    case "connect":
    case "ping":
      result = { protocolVersion: 3, version: "1.0.16", timestamp: Date.now() };
      break;
    case "status.get":
      result = { version: "1.0.16", protocolVersion: 3 };
      break;
    case "auth.getStatus":
      result = { isAuthenticated: true, authType: "user", login: "e2e" };
      break;
    case "models.list":
      result = { models: [{ id: "e2e-copilot-model", name: "E2E Copilot", capabilities: {
        supports: { vision: true, reasoningEffort: false }, limits: { max_prompt_tokens: 32_000 },
      } }] };
      break;
    case "session.create": {
      const id = String(params["sessionId"] ?? crypto.randomUUID());
      sessions.set(id, {
        id, directory: String(params["workingDirectory"] ?? process.cwd()),
        model: String(params["model"] ?? "e2e-copilot-model"),
        tools: Array.isArray(params["tools"]) ? params["tools"] : [],
        metadata: {}, processing: false, prompt: "", events: [], usage: {},
      });
      event(sessions.get(id)!, "session.start", {});
      await save();
      result = { sessionId: id, capabilities: {} };
      break;
    }
    case "session.resume":
      if (!session) throw new Error("Copilot session unavailable.");
      session.tools = Array.isArray(params["tools"]) ? params["tools"] : session.tools;
      result = { sessionId: session.id, capabilities: {} };
      break;
    case "session.getMetadata":
      result = {
        session: session ? {
          sessionId: session.id,
          startTime: session.events[0]!["timestamp"],
          modifiedTime: session.events.at(-1)!["timestamp"],
          isRemote: false,
          context: { cwd: session.directory },
        } : null,
      };
      break;
    case "session.metadata.getClientMetadata":
      result = session!.metadata;
      break;
    case "session.metadata.updateClientMetadata":
      Object.assign(session!.metadata, params["set"]);
      await save();
      result = {};
      break;
    case "session.model.getCurrent":
      result = { modelId: session!.model };
      break;
    case "session.model.switchTo":
      session!.model = String(params["modelId"]);
      await save();
      result = {};
      break;
    case "session.metadata.isProcessing":
      result = { processing: session!.processing };
      break;
    case "session.usage.getMetrics":
      result = {
        sessionStartTime: session!.events[0]!["timestamp"],
        modelMetrics: Object.fromEntries(Object.entries(session!.usage).map(([model, usage]) => [
          model, { usage, requests: { count: usage.outputTokens / 50, cost: 0 } },
        ])),
        totalApiDurationMs: 0, totalUserRequests: 0, totalPremiumRequestCost: 0,
        lastCallInputTokens: 100, lastCallOutputTokens: 50,
        codeChanges: { filesModified: [], filesModifiedCount: 0, linesAdded: 0, linesRemoved: 0 },
      };
      break;
    case "session.tasks.list":
      result = { tasks: (session!.children ?? []).map((child) => ({
        ...child, type: "agent", agentType: "explore", model: session!.model,
      })) };
      break;
    case "session.tasks.cancel": {
      const child = session!.children?.find((entry) => entry.id === params["id"]);
      if (child) child.status = "cancelled";
      result = {};
      break;
    }
    case "session.tasks.refresh":
    case "session.eventLog.registerInterest":
    case "session.options.update":
      result = {};
      break;
    case "session.eventLog.read": {
      const maximum = typeof params["max"] === "number" ? params["max"] : 200;
      const agentIds = Array.isArray(params["agentIds"]) ? params["agentIds"] : undefined;
      const types = Array.isArray(params["types"]) ? params["types"] : undefined;
      const events = session!.events.filter((entry) =>
        (!types || types.includes(entry["type"]))
        && (agentIds ? agentIds.includes(entry["agentId"]) : params["agentScope"] === "primary" ? !entry["agentId"] : true));
      const forward = params["direction"] !== "backward";
      const position = params["cursor"] === undefined ? (forward ? 0 : events.length) : Number(params["cursor"]);
      const start = forward ? position : Math.max(0, position - maximum);
      const end = forward ? Math.min(events.length, position + maximum) : position;
      result = {
        events: events.slice(start, end), cursor: String(forward ? end : start),
        hasMore: forward ? end < events.length : start > 0, cursorStatus: "ok",
      };
      break;
    }
    case "session.send":
      await sendInput(session, params, frame.id);
      return;
    case "session.tools.handlePendingToolCall":
      await toolResult(params);
      await save();
      result = { success: true };
      break;
    case "session.abort":
      await stopBackground(session!.id);
      waiting.get(session!.id)?.abort();
      idle(session!, { aborted: true });
      result = {};
      break;
    case "session.detach":
      await stopBackground(session!.id);
      await save();
      result = { success: true };
      break;
    case "session.delete":
      await stopBackground(session!.id);
      waiting.get(session!.id)?.abort();
      for (const [id, request] of pending) {
        if (request.session !== session) continue;
        clearTimeout(request.timer);
        pending.delete(id);
      }
      await Bun.file(sessionPath(session!.id)).delete();
      sessions.delete(session!.id);
      await save();
      result = { success: true };
      break;
    case "session.list":
      result = { sessions: [] };
      break;
    case "runtime.shutdown":
      await Promise.all([...background.keys()].map(stopBackground));
      await save();
      write({ id: frame.id, result: {} });
      process.stdin.destroy();
      return;
    default:
      write({ id: frame.id, error: { code: -32601, message: `Unsupported native fixture method ${frame.method}` } });
      return;
  }
  write({ id: frame.id, result });
}

let buffer = Buffer.alloc(0);
let processing = Promise.resolve();
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const boundary = buffer.indexOf("\r\n\r\n");
    if (boundary < 0) break;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, boundary).toString())?.[1]);
    if (!Number.isInteger(length) || length < 1 || length > MAX_FRAME_BYTES) throw new Error("Invalid Copilot frame length.");
    if (buffer.length < boundary + 4 + length) break;
    const frame = parseJsonRpcMessage(JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + length).toString()));
    buffer = buffer.subarray(boundary + 4 + length);
    processing = processing.then(() => dispatch(frame)).catch((error: unknown) => {
      console.error(String(error));
      if (frame.id !== undefined) write({ id: frame.id, error: { code: -32603, message: String(error) } });
    });
  }
});
process.stdin.on("close", () => {
  for (const task of background.values()) task.controller.abort();
  for (const controller of waiting.values()) controller.abort();
  waiting.clear();
  for (const request of pending.values()) clearTimeout(request.timer);
  pending.clear();
});
