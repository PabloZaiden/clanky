/**
 * Deterministic external app-server executable, not a Backend fake. Real
 * native adapters, Mesh leases and public servers consume this protocol.
 */
import { createInterface } from "node:readline";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.159.2");
  process.exit(0);
}

const directory = process.cwd();
const stateFile = join(directory, ".fixture-native-threads.json");
interface Thread {
  id: string; parentThreadId: string | null; cwd: string;
  createdAt: number; model: string; status: { type: "active"; activeFlags: string[] } | { type: "idle" };
}
let threads: Thread[] = await Bun.file(stateFile).exists() ? JSON.parse(await Bun.file(stateFile).text()) as Thread[] : [];
const processes = new Map<string, Bun.Subprocess<"pipe", "ignore", "ignore">>();
const turns = new Map<string, { id: string; status: string; items: unknown[]; error: null }>();
const receipts: Array<{ item: { type: string; id: string; clientId: string; content: unknown[] } }> = [];
const notify = (method: string, params: unknown): void => console.log(JSON.stringify({ method, params }));
const save = async (): Promise<void> => { await Bun.write(stateFile, JSON.stringify(threads)); };
const thread = (id: string): Thread => {
  const value = threads.find((entry) => entry.id === id);
  if (!value) throw new Error("Unknown fixture native thread");
  return value;
};
async function stop(id: string): Promise<void> {
  const child = processes.get(id);
  if (child) { child.stdin.end(); await child.exited; processes.delete(id); }
  thread(id).status = { type: "idle" };
  const turn = turns.get(id);
  if (turn) {
    turn.status = "interrupted";
    notify("turn/completed", { threadId: id, turn });
  }
  await Bun.write(join(directory, `.fixture-stopped-${id}`), "settled");
  await save();
}

async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = params["threadId"] as string;
  switch (method) {
    case "initialize": return { userAgent: "fixture", platformFamily: "unix", platformOs: "linux" };
    case "model/list": return { data: [{ id: "fixture-model", model: "fixture-model", displayName: "Fixture native", supportedReasoningEfforts: [] }], nextCursor: null };
    case "thread/start": {
      const root: Thread = { id: crypto.randomUUID(), parentThreadId: null, cwd: directory, createdAt: Math.floor(Date.now() / 1000), model: "fixture-model", status: { type: "idle" } };
      threads.push(root); await save(); return { thread: root };
    }
    case "thread/resume":
    case "thread/read": return { thread: thread(id) };
    case "thread/list":
      if (await Bun.file(join(directory, ".fixture-observation-failure")).exists()) throw new Error("Observation deliberately unavailable");
      return { data: threads.filter((entry) => entry.parentThreadId === params["ancestorThreadId"]), nextCursor: null };
    case "thread/backgroundTerminals/list": return { data: [] };
    case "thread/turns/list": return { data: turns.has(id) ? [turns.get(id)] : [], nextCursor: null };
    case "thread/items/list": return { data: receipts, nextCursor: null };
    case "turn/start": {
      const root = thread(id);
      root.status = { type: "active", activeFlags: [] };
      const turn = { id: crypto.randomUUID(), status: "inProgress", items: [], error: null };
      turns.set(id, turn);
      notify("turn/started", { threadId: id, turn });
      for (const suffix of ["one", "two"]) {
        const child: Thread = { ...root, id: `${id}-${suffix}`, parentThreadId: id };
        threads.push(child);
        const childProcess = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
        processes.set(child.id, childProcess);
        turns.set(child.id, { ...turn, id: `${turn.id}-${suffix}` });
        notify("thread/started", { thread: child });
      }
      await Bun.write(join(directory, "native-host-effect.txt"), `selected-host:${directory}`);
      notify("item/completed", { threadId: id, turnId: turn.id, item: { type: "agentMessage", id: "assistant-not-terminal", text: "COMPLETE" } });
      await save(); return { turn };
    }
    case "turn/steer": {
      const turn = turns.get(id);
      if (!turn || turn.id !== params["expectedTurnId"]) throw new Error("Turn changed");
      const clientId = params["clientUserMessageId"] as string;
      const messageId = `admitted-${clientId}`;
      receipts.push({ item: { type: "userMessage", id: messageId, clientId, content: params["input"] as unknown[] } });
      if (await Bun.file(join(directory, ".fixture-steer-response-loss")).exists()) throw new Error("Native input admitted without a usable response");
      notify("item/completed", { threadId: id, turnId: turn.id, item: receipts.at(-1)!.item });
      if (JSON.stringify(params["input"]).includes("finish principal")) {
        turn.status = "completed"; thread(id).status = { type: "idle" };
        notify("turn/completed", { threadId: id, turn });
      }
      await save(); return { turnId: turn.id };
    }
    case "turn/interrupt": await stop(id); return {};
    case "thread/delete": threads = threads.filter((entry) => entry.id !== id && entry.parentThreadId !== id); await save(); return {};
    default: throw new Error(`Unsupported fixture method ${method}`);
  }
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const frame = JSON.parse(line) as { id?: string; method?: string; params?: Record<string, unknown> };
  if (frame.id === undefined) continue;
  try { console.log(JSON.stringify({ id: frame.id, result: await request(frame.method!, frame.params ?? {}) })); }
  catch { console.log(JSON.stringify({ id: frame.id, error: { code: -32603, message: "Fixture external request failed" } })); }
}
for (const [id, process] of processes) {
  process.stdin.end(); await process.exited;
  await Bun.write(join(directory, `.fixture-stopped-${id}`), "settled");
}
await Bun.write(join(directory, ".fixture-runtime-closed"), "owned subprocesses settled");
