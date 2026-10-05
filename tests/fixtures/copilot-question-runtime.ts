/**
 * Deterministic external Copilot JSON-RPC runtime for question lifecycle tests.
 */

import { join } from "node:path";

interface NativeSession {
  processing: boolean;
  metadata: Record<string, string>;
}

interface Frame {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: { answer: string; wasFreeform: boolean };
  error?: { code: number };
}

const sessions = new Map<string, NativeSession>();
const questions = new Map<string, string>();
const send = (frame: unknown): void => {
  const payload = JSON.stringify(frame);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
};
const event = (sessionId: string, type: string, data: Record<string, unknown>): void => {
  send({ jsonrpc: "2.0", method: "session.event", params: {
    sessionId, event: { id: crypto.randomUUID(), parentId: null, timestamp: new Date().toISOString(), type, data },
  } });
};

async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = params["sessionId"] as string;
  switch (method) {
    case "connect": return { protocolVersion: 3 };
    case "ping": return { protocolVersion: 3, timestamp: Date.now() };
    case "auth.getStatus": return { isAuthenticated: true };
    case "status.get": return { version: "1.0.91", protocolVersion: 3 };
    case "models.list": return { models: [{ id: "fixture-model", name: "Fixture Copilot" }] };
    case "session.create": {
      const sessionId = id ?? crypto.randomUUID();
      sessions.set(sessionId, { processing: false, metadata: {} });
      return { sessionId };
    }
    case "session.metadata.updateClientMetadata":
      Object.assign(sessions.get(id)!.metadata, params["set"]);
      return {};
    case "session.metadata.getClientMetadata": return sessions.get(id)!.metadata;
    case "session.metadata.isProcessing": return { processing: sessions.get(id)!.processing };
    case "session.model.getCurrent": return { modelId: "fixture-model" };
    case "session.model.switchTo": return {};
    case "session.tasks.refresh": return {};
    case "session.tasks.list": return { tasks: [] };
    case "session.send": {
      const requestId = crypto.randomUUID();
      sessions.get(id)!.processing = true;
      questions.set(requestId, id);
      event(id, "assistant.turn_start", {});
      send({ jsonrpc: "2.0", id: requestId, method: "userInput.request", params: {
        sessionId: id, question: "Choose a color", choices: ["Blue", "Red"], allowFreeform: true,
      } });
      return { messageId: crypto.randomUUID() };
    }
    case "session.abort":
      sessions.get(id)!.processing = false;
      event(id, "session.idle", { aborted: true });
      return {};
    case "session.disconnect": return {};
    case "session.delete":
      sessions.delete(id);
      return {};
    default: throw new Error(`Unsupported fixture method: ${method}`);
  }
}

async function receive(frame: Frame): Promise<void> {
  if (frame.id === undefined) return;
  if (frame.method) {
    try {
      send({ jsonrpc: "2.0", id: frame.id, result: await request(frame.method, frame.params ?? {}) });
    } catch (error) {
      console.error(String(error));
      send({ jsonrpc: "2.0", id: frame.id, error: { code: -32603, message: "Fixture native request failed" } });
    }
    return;
  }
  const id = questions.get(String(frame.id));
  if (!id) return;
  questions.delete(String(frame.id));
  if (frame.error) {
    await Bun.write(join(process.cwd(), `copilot-cancelled-${id}.json`), JSON.stringify(frame.error));
    return;
  }
  await Bun.write(join(process.cwd(), `copilot-answer-${id}.json`), JSON.stringify(frame.result));
  sessions.get(id)!.processing = false;
  event(id, "assistant.message", { messageId: crypto.randomUUID(), content: `Consumed answer: ${frame.result!.answer}` });
  event(id, "session.idle", {});
}

let buffer = Buffer.alloc(0);
for await (const chunk of Bun.stdin.stream()) {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length > 1024 * 1024) throw new Error("Fixture protocol frame exceeded capacity.");
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const length = Number(buffer.subarray(0, headerEnd).toString().match(/Content-Length: (\d+)/i)?.[1]);
    if (!Number.isInteger(length) || length < 0) throw new Error("Fixture received an invalid protocol header.");
    const end = headerEnd + 4 + length;
    if (buffer.length < end) break;
    const frame = JSON.parse(buffer.subarray(headerEnd + 4, end).toString()) as Frame;
    buffer = buffer.subarray(end);
    await receive(frame);
  }
}
