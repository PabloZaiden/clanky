/**
 * External Copilot SDK stdio peer with durable sessions and immediate steering.
 */

import { join } from "node:path";
import { parseJsonRpcMessage, type JsonRpcId, type JsonRpcMessage } from "./codex-json-rpc";
import { readCopilotImageReceipts } from "./image-input";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;

interface Session {
  id: string;
  model: string;
  tools: Array<{ name: string }>;
  metadata: Record<string, string>;
  processing: boolean;
  prompt: string;
  events: Array<Record<string, unknown>>;
  result?: string;
}

const sessions = new Map<string, Session>();
const pending = new Map<string, { session: Session; name: string; timer: ReturnType<typeof setTimeout> }>();
const statePath = join(process.env["HOME"]!, "copilot-native-sessions.json");
if (await Bun.file(statePath).exists()) {
  const stored: Session[] = JSON.parse(await Bun.file(statePath).text());
  for (const session of stored) sessions.set(session.id, { ...session, processing: false });
}

async function save(): Promise<void> {
  await Bun.write(statePath, JSON.stringify([...sessions.values()]));
}

function write(message: Record<string, unknown>): void {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function event(session: Session, type: string, data: Record<string, unknown>): void {
  const value = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), parentId: null, type, data };
  session.events.push(value);
  session.events = session.events.slice(-500);
  write({ method: "session.event", params: { sessionId: session.id, event: value } });
}

function finish(session: Session, content: string): void {
  event(session, "assistant.message", { messageId: crypto.randomUUID(), content });
  session.processing = false;
  event(session, "session.idle", {});
}

function requestTool(session: Session, name: string, args: Record<string, unknown>): void {
  const id = crypto.randomUUID();
  const timer = setTimeout(() => {
    pending.delete(id);
    event(session, "session.error", { errorType: "protocol", message: `Timed out waiting for ${name}.` });
    session.processing = false;
    event(session, "session.idle", {});
  }, 5_000);
  pending.set(id, { session, name, timer });
  event(session, "tool.execution_start", { toolCallId: id, toolName: name, arguments: args });
  event(session, "external_tool.requested", { requestId: id, toolCallId: id, toolName: name, arguments: args });
}

function execute(session: Session): void {
  if (!session.tools.some((tool) => tool.name === "clanky_list_workspaces")) {
    finish(session, `Agent received: ${session.prompt}\nClanky tools unavailable.`);
    return;
  }
  requestTool(session, "clanky_list_workspaces", {});
}

function toolResult(params: Record<string, unknown>): void {
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
  if (name === "clanky_list_workspaces") {
    session.result = `Agent received: ${session.prompt}\nClanky workspace list: ${JSON.stringify(result)}`;
    const workspace = result?.data?.data?.[0] ?? result?.data?.[0];
    if (session.prompt.includes("open the workspace") && workspace?.id) {
      requestTool(session, "clanky_open_workspace", { workspaceId: workspace.id });
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
  const promptWithImages = [prompt, ...readCopilotImageReceipts(params["attachments"])].join("\n");
  if (session.processing && params["mode"] !== "immediate") throw new Error("Active input requires immediate mode.");
  write({ id, result: { messageId } });
  event(session, "user.message", { messageId, content: prompt });
  if (session.processing) {
    session.prompt += `\nSteered instruction: ${promptWithImages}`;
    if (!prompt.includes("keep waiting")) execute(session);
  } else {
    session.processing = true;
    session.prompt = promptWithImages;
    event(session, "assistant.turn_start", { turnId: crypto.randomUUID() });
    if (!prompt.startsWith("Wait for a steering instruction")) execute(session);
  }
  await save();
}

async function dispatch(frame: JsonRpcMessage): Promise<void> {
  if (frame.id === undefined || !frame.method) return;
  const params = frame.params && typeof frame.params === "object" ? frame.params as Record<string, unknown> : {};
  const session = sessions.get(String(params["sessionId"]));
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
        id, model: String(params["model"] ?? "e2e-copilot-model"),
        tools: Array.isArray(params["tools"]) ? params["tools"] : [],
        metadata: {}, processing: false, prompt: "", events: [],
      });
      await save();
      result = { sessionId: id, capabilities: {} };
      break;
    }
    case "session.resume":
      if (!session) throw new Error("Copilot session unavailable.");
      session.tools = Array.isArray(params["tools"]) ? params["tools"] : session.tools;
      result = { sessionId: session.id, capabilities: {} };
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
    case "session.tasks.list":
      result = { tasks: [] };
      break;
    case "session.tasks.refresh":
    case "session.eventLog.registerInterest":
    case "session.options.update":
      result = {};
      break;
    case "session.eventLog.read":
      result = { events: session!.events };
      break;
    case "session.send":
      await sendInput(session, params, frame.id);
      return;
    case "session.tools.handlePendingToolCall":
      toolResult(params);
      await save();
      result = { success: true };
      break;
    case "session.abort":
      session!.processing = false;
      event(session!, "session.idle", { aborted: true });
      result = {};
      break;
    case "session.detach":
      await save();
      result = { success: true };
      break;
    case "session.list":
      result = { sessions: [] };
      break;
    case "runtime.shutdown":
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
  for (const request of pending.values()) clearTimeout(request.timer);
  pending.clear();
});
