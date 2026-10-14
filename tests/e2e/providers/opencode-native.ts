/**
 * External OpenCode 2 HTTP peer that loads native Promise plugins normally.
 */

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Session {
  id: string;
  projectID: string;
  location: { directory: string };
  model: { id: string; providerID: string };
  title: string;
  agent: string;
  metadata: Record<string, unknown>;
  permissions: Array<{ action: string; resource: string; effect: string }>;
  time: { created: number; updated: number };
  sequence: number;
  messages: Array<{ id: string; type: string }>;
}

interface Tool {
  name: string;
  description: string;
  input: unknown;
  execute(input: unknown, invocation: { sessionID: string; messageID: string; signal: AbortSignal }): Promise<{ output: unknown; content: string }>;
}

interface ContextEvent { sessionID: string; tools: Record<string, Tool> }
interface Plugin {
  id: string;
  setup(context: {
    tool: { transform(edit: (editor: { add(tool: Tool): void }) => void): Promise<{ dispose(): Promise<void> }> };
    session: { hook(name: string, handler: (event: ContextEvent) => Promise<void>): Promise<{ dispose(): Promise<void> }> };
  }): Promise<() => Promise<void>>;
}

const sessions = new Map<string, Session>();
const active = new Map<string, { prompt: string; abort: AbortController; running?: Promise<void> }>();
const tools = new Map<string, Tool>();
const contextHooks = new Set<(event: ContextEvent) => Promise<void>>();
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const pluginCleanups: Array<() => Promise<void>> = [];
const plugins: Array<{ id: string; source: { type: string; path: string }; state: { status: string } }> = [];
const operations = new Set<Promise<void>>();
const stateDirectory = join(process.env["XDG_DATA_HOME"]!, "e2e-opencode-sessions");
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
for (const file of await readdir(stateDirectory)) {
  if (!file.endsWith(".json")) continue;
  const session: Session = JSON.parse(await Bun.file(join(stateDirectory, file)).text());
  sessions.set(session.id, session);
}

const config = JSON.parse(process.env["OPENCODE_CONFIG_CONTENT"] ?? "{}");
for (const entry of config.plugins ?? []) {
  const directory = typeof entry === "string" ? entry : entry.package;
  const pluginPath = join(directory, "index.js");
  const plugin: Plugin = (await import(pathToFileURL(pluginPath).href)).default;
  pluginCleanups.push(await plugin.setup({
    tool: {
      async transform(edit) {
        const registered: string[] = [];
        edit({ add(tool) { tools.set(tool.name, tool); registered.push(tool.name); } });
        return { async dispose() { for (const name of registered) tools.delete(name); } };
      },
    },
    session: {
      async hook(name, handler) {
        if (name !== "context") throw new Error(`Unsupported fixture hook: ${name}`);
        contextHooks.add(handler);
        return { async dispose() { contextHooks.delete(handler); } };
      },
    },
  }));
  plugins.push({ id: plugin.id, source: { type: "local", path: pluginPath }, state: { status: "active" } });
}

async function save(session: Session): Promise<void> {
  await Bun.write(join(stateDirectory, `${session.id}.json`), JSON.stringify(session));
}

async function waitForVoiceEndRelease(directory: string, signal: AbortSignal): Promise<void> {
  const releasePath = join(directory, ".clanky-e2e-voice-end-release");
  while (!signal.aborted && !await Bun.file(releasePath).exists()) await Bun.sleep(20);
}

function broadcast(event: Record<string, unknown>): void {
  const data = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
  for (const stream of streams) stream.enqueue(data);
}

function emit(session: Session, type: string, data: Record<string, unknown> = {}): void {
  broadcast({
    id: crypto.randomUUID(), created: Date.now(), type,
    durable: { aggregateID: session.id, seq: ++session.sequence, version: 1 },
    data: { sessionID: session.id, ...data },
  });
}

async function execute(session: Session): Promise<void> {
  const execution = active.get(session.id);
  if (!execution) return;
  const messageID = crypto.randomUUID();
  emit(session, "session.step.started", { assistantMessageID: messageID });
  try {
    const event: ContextEvent = { sessionID: session.id, tools: Object.fromEntries(tools) };
    for (const hook of contextHooks) await hook(event);
    if (execution.prompt.includes("[voice-end-wait]")) {
      await waitForVoiceEndRelease(session.location.directory, execution.abort.signal);
      if (execution.abort.signal.aborted) return;
    }
    const requests: Array<{ name: string; input: unknown }> = execution.prompt.split("\n")
      .filter((line) => line.startsWith("Control request: "))
      .flatMap((line) => JSON.parse(line.slice("Control request: ".length)));
    if (execution.prompt.includes("then list workspaces for the Live caller.")) {
      requests.push({ name: "clanky_list_workspaces", input: {} });
    }
    const results: unknown[] = [];
    for (const request of requests) {
      const tool = event.tools[request.name];
      if (!tool) throw new Error("Clanky tools unavailable.");
      const id = crypto.randomUUID();
      emit(session, "session.tool.input.started", { id, name: request.name });
      emit(session, "session.tool.called", { id, input: request.input });
      const result = await tool.execute(request.input, { sessionID: session.id, messageID, signal: execution.abort.signal });
      results.push(result.output);
      emit(session, "session.tool.success", { id, content: [{ type: "text", text: result.content }] });
    }
    if (execution.abort.signal.aborted) return;
    const text = requests.length > 0 ? `Control results: ${JSON.stringify(results)}` : `Agent received: ${execution.prompt}`;
    emit(session, "session.text.ended", { assistantMessageID: messageID, ordinal: 0, text });
    emit(session, "session.step.ended", { assistantMessageID: messageID });
    active.delete(session.id);
    emit(session, "session.execution.succeeded");
  } catch (error) {
    if (!execution.abort.signal.aborted) {
      active.delete(session.id);
      emit(session, "session.execution.failed", { error: { message: String(error) } });
    }
  } finally {
    await save(session);
  }
}

function startExecution(session: Session): void {
  const execution = active.get(session.id)!;
  // Native turns outlive prompt admission and report failures through SSE.
  const operation = execute(session).finally(() => { operations.delete(operation); });
  execution.running = operation;
  operations.add(operation);
}

const password = process.env["OPENCODE_SERVER_PASSWORD"]!;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (request.headers.get("authorization") !== `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`) {
      return new Response(null, { status: 401 });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/info") return Response.json({ version: "2.0.22" });
    if (path === "/api/plugin") return Response.json({ data: plugins });
    if (path === "/api/integration") return Response.json({ data: [] });
    if (path === "/api/model") return Response.json({ data: [{
      id: "e2e-opencode-model", providerID: "e2e-openai", name: "E2E OpenCode", enabled: true, variants: [],
    }] });
    if (path === "/api/shell") return Response.json({ data: [] });
    if (path === "/api/event") {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      return new Response(new ReadableStream<Uint8Array>({
        start(stream) {
          controller = stream;
          streams.add(stream);
          stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
            id: crypto.randomUUID(), created: Date.now(), type: "server.connected", data: {},
          })}\n\n`));
        },
        cancel() { streams.delete(controller); },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (path === "/api/session/active") {
      return Response.json({ data: Object.fromEntries([...active.keys()].map((id) => [id, { status: "busy" }])) });
    }
    if (path === "/api/session" && request.method === "POST") {
      const input = await request.json();
      const session: Session = {
        id: crypto.randomUUID(), projectID: "e2e-project", agent: "build",
        title: input.title ?? "E2E session", location: input.location,
        model: input.model ?? { id: "e2e-opencode-model", providerID: "e2e-openai" },
        metadata: input.metadata ?? {}, permissions: input.permissions ?? [],
        time: { created: Date.now(), updated: Date.now() }, sequence: 0, messages: [],
      };
      sessions.set(session.id, session);
      await save(session);
      return Response.json({ data: session });
    }
    if (path === "/api/session") return Response.json({ data: [], cursor: {} });
    const match = /^\/api\/session\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    const session = match ? sessions.get(match[1]!) : undefined;
    if (!session) return new Response(null, { status: 404 });
    const operation = match![2];
    if (!operation && request.method === "GET") return Response.json({ data: session });
    if (!operation && request.method === "PATCH") {
      const input = await request.json();
      session.metadata = { ...session.metadata, ...input.metadata };
      if (input.permissions) session.permissions = input.permissions;
      await save(session);
      return new Response(null, { status: 204 });
    }
    if (!operation && request.method === "DELETE") {
      active.get(session.id)?.abort.abort();
      await active.get(session.id)?.running;
      active.delete(session.id);
      sessions.delete(session.id);
      await Bun.file(join(stateDirectory, `${session.id}.json`)).delete();
      return new Response(null, { status: 204 });
    }
    if (operation === "message") return Response.json({ data: session.messages, cursor: {} });
    if (operation === "model") {
      session.model = (await request.json()).model;
      await save(session);
      return new Response(null, { status: 204 });
    }
    if (operation === "interrupt") {
      const execution = active.get(session.id);
      execution?.abort.abort();
      await execution?.running;
      active.delete(session.id);
      if (execution) emit(session, "session.execution.interrupted", { reason: "user" });
      await save(session);
      return new Response(null, { status: 204 });
    }
    if (operation === "prompt") {
      const input = await request.json();
      const current = active.get(session.id);
      if (current && input.delivery !== "steer") return new Response(null, { status: 409 });
      const message = { id: crypto.randomUUID(), type: "user" };
      session.messages = [...session.messages.slice(-999), message];
      if (current) {
        current.prompt += `\n${input.text}`;
        if (input.text.includes("Continue.") || input.text.startsWith("Live steering request ")) startExecution(session);
      } else {
        active.set(session.id, { prompt: input.text, abort: new AbortController() });
        emit(session, "session.execution.started");
        if (!input.text.startsWith("Wait for steering.") && !input.text.startsWith("Wait for a steering instruction")) startExecution(session);
      }
      await save(session);
      return Response.json({ data: message });
    }
    return new Response(null, { status: 404 });
  },
});

process.stdout.write(`${JSON.stringify({ url: server.url.origin })}\n`);
let closing: Promise<void> | undefined;
function close(): Promise<void> {
  closing ??= (async () => {
    for (const execution of active.values()) execution.abort.abort();
    await Promise.allSettled(operations);
    for (const cleanup of pluginCleanups) await cleanup();
    for (const stream of streams) stream.close();
    streams.clear();
    await server.stop(true);
  })();
  return closing;
}
process.on("SIGTERM", async () => {
  try { await close(); process.exit(0); } catch (error) { console.error(String(error)); process.exit(1); }
});
for await (const _chunk of Bun.stdin.stream()) {}
await close();
