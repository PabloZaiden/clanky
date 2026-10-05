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
interface Turn { id: string; status: string; items: unknown[]; error: null }
const turns = new Map<string, Turn>();
const receipts: Array<{ item: { type: string; id: string; clientId: string; content: unknown[] } }> = [];
const questionPolicies = new Map<string, boolean>();
const nativeConfigs = new Map<string, Record<string, unknown>>();
const questions = new Map<string, { threadId: string; turnId: string }>();
const notify = (method: string, params: unknown): void => console.log(JSON.stringify({ method, params }));
const save = async (): Promise<void> => { await Bun.write(stateFile, JSON.stringify(threads)); };
const thread = (id: string): Thread => {
  const value = threads.find((entry) => entry.id === id);
  if (!value) throw new Error("Unknown fixture native thread");
  return value;
};
async function questionDenied(id: string, toolName: string): Promise<boolean> {
  const config = nativeConfigs.get(id);
  const hooks = config?.["hooks"];
  if (!hooks || typeof hooks !== "object") return false;
  const settings = hooks as { PreToolUse?: Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout: number; async: boolean }> }>; state?: Record<string, { trusted_hash: string }> };
  for (const [groupIndex, group] of (settings.PreToolUse ?? []).entries()) {
    if (!new RegExp(group.matcher).test(toolName)) continue;
    for (const [handlerIndex, handler] of group.hooks.entries()) {
      const identity = { event_name: "pre_tool_use", hooks: [{ async: handler.async, command: handler.command, timeout: handler.timeout, type: handler.type }], matcher: group.matcher };
      const hash = `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(identity)).digest("hex")}`;
      if (settings.state?.[`/<session-flags>/config.toml:pre_tool_use:${groupIndex}:${handlerIndex}`]?.trusted_hash !== hash) continue;
      const result = Bun.spawn(["/bin/sh", "-c", handler.command], { cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]);
      if (code !== 0) throw new Error(`Native hook failed: ${stderr}`);
      const output = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
      if (output.hookSpecificOutput?.permissionDecision === "deny") return true;
    }
  }
  return false;
}
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

async function consumeAsyncAnswer(id: string, input: unknown, turn: Turn): Promise<boolean> {
  if (!JSON.stringify(input).includes("Choose a strategy")) return false;
  const file = Bun.file(join(directory, `async-input-${id}.json`));
  const inputs: unknown[] = await file.exists() ? await file.json() : [];
  if (inputs.length >= 32) throw new Error("Async fixture input capacity reached");
  await Bun.write(file, JSON.stringify([...inputs, input]));
  turn.status = "completed"; thread(id).status = { type: "idle" };
  notify("item/completed", { threadId: id, turnId: turn.id, item: { type: "agentMessage", id: crypto.randomUUID(), text: "Async answer consumed" } });
  notify("turn/completed", { threadId: id, turn });
  await save();
  return true;
}

async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = params["threadId"] as string;
  switch (method) {
    case "initialize": return { userAgent: "fixture", platformFamily: "unix", platformOs: "linux" };
    case "model/list": return { data: [{ id: "fixture-model", model: "fixture-model", displayName: "Fixture native", supportedReasoningEfforts: [] }], nextCursor: null };
    case "config/read": return { config: { features: { hooks: true } }, origins: {} };
    case "configRequirements/read": return { requirements: null };
    case "thread/start": {
      const root: Thread = { id: crypto.randomUUID(), parentThreadId: null, cwd: directory, createdAt: Math.floor(Date.now() / 1000), model: "fixture-model", status: { type: "idle" } };
      questionPolicies.set(root.id, (params["config"] as Record<string, unknown> | undefined)?.["tools.experimental_request_user_input.enabled"] === true);
      nativeConfigs.set(root.id, (params["config"] as Record<string, unknown> | undefined) ?? {});
      threads.push(root); await save(); return { thread: root };
    }
    case "thread/resume":
      questionPolicies.set(id, (params["config"] as Record<string, unknown> | undefined)?.["tools.experimental_request_user_input.enabled"] === true);
      nativeConfigs.set(id, (params["config"] as Record<string, unknown> | undefined) ?? {});
      return { thread: thread(id) };
    case "thread/read": return { thread: thread(id) };
    case "thread/list":
      if (await Bun.file(join(directory, ".fixture-observation-failure")).exists()) throw new Error("Observation deliberately unavailable");
      return { data: threads.filter((entry) => entry.parentThreadId === params["ancestorThreadId"]), nextCursor: null };
    case "thread/backgroundTerminals/list": return { data: [] };
    case "thread/turns/list": return { data: turns.has(id) ? [turns.get(id)] : [], nextCursor: null };
    case "thread/items/list": return {
      data: await Bun.file(join(directory, ".fixture-steer-recovery-hidden")).exists() ? [] : receipts,
      nextCursor: null,
    };
    case "turn/start": {
      const root = thread(id);
      root.status = { type: "active", activeFlags: [] };
      const turn = { id: crypto.randomUUID(), status: "inProgress", items: [], error: null };
      turns.set(id, turn);
      notify("turn/started", { threadId: id, turn });
      if (await consumeAsyncAnswer(id, params["input"], turn)) return { turn };
      if (JSON.stringify(params["input"]).includes("question-fixture")) {
        const asyncQuestion = JSON.stringify(params["input"]).includes("async-question-fixture");
        if (asyncQuestion && !await questionDenied(id, "request_user_input_async")) {
          const messageId = crypto.randomUUID();
          if (JSON.stringify(params["input"]).includes("segmented-async-question-fixture")) {
            notify("item/agentMessage/delta", { threadId: id, turnId: turn.id, itemId: messageId, delta: "Strategy context" });
            notify("item/started", { threadId: id, turnId: turn.id, item: {
              type: "commandExecution", id: crypto.randomUUID(), command: "git status",
            } });
            notify("item/agentMessage/delta", { threadId: id, turnId: turn.id, itemId: messageId, delta: "Choose a strategy" });
          }
          notify("item/completed", { threadId: id, turnId: turn.id, item: {
            type: "agentMessage", id: messageId, text: "Choose a strategy", delivery: "async",
            questions: [{ title: "Choose a strategy", options: ["Merge"] }],
          } });
          if (!JSON.stringify(params["input"]).includes("queued-")) {
            turn.status = "completed"; root.status = { type: "idle" };
            notify("turn/completed", { threadId: id, turn });
          }
        } else if (questionPolicies.get(id)) {
          const requestId = crypto.randomUUID();
          questions.set(requestId, { threadId: id, turnId: turn.id });
          root.status = { type: "active", activeFlags: ["waitingOnUserInput"] };
          console.log(JSON.stringify({ id: requestId, method: "item/tool/requestUserInput", params: {
            threadId: id, turnId: turn.id, itemId: "question", isBlocking: false,
            questions: [{
              id: "strategy", header: "Strategy", question: "Choose a strategy", isOther: true,
              options: [{ label: "Merge", description: "Preserve both histories" }, { label: "Rebase", description: "Linear history" }],
            }],
          } }));
        } else {
          await Bun.write(join(directory, `autonomous-${id}.txt`), "completed without requesting human input");
          turn.status = "completed"; root.status = { type: "idle" };
          notify("item/completed", { threadId: id, turnId: turn.id, item: { type: "agentMessage", id: crypto.randomUUID(), text: "COMPLETE" } });
          notify("turn/completed", { threadId: id, turn });
        }
        await save();
        return { turn };
      }
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
      const asyncAnswer = await consumeAsyncAnswer(id, params["input"], turn);
      if (await Bun.file(join(directory, ".fixture-steer-response-loss")).exists()) throw new Error("Native input admitted without a usable response");
      notify("item/completed", { threadId: id, turnId: turn.id, item: receipts.at(-1)!.item });
      if (!asyncAnswer && JSON.stringify(params["input"]).includes("finish principal")) {
        turn.status = "completed"; thread(id).status = { type: "idle" };
        notify("turn/completed", { threadId: id, turn });
      }
      await save(); return { turnId: turn.id };
    }
    case "turn/interrupt": await stop(id); return {};
    case "thread/delete":
      nativeConfigs.delete(id); questionPolicies.delete(id);
      threads = threads.filter((entry) => entry.id !== id && entry.parentThreadId !== id); await save(); return {};
    default: throw new Error(`Unsupported fixture method ${method}`);
  }
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const frame = JSON.parse(line) as { id?: string; method?: string; params?: Record<string, unknown>; result?: unknown };
  if (frame.id === undefined) continue;
  if (!frame.method) {
    const question = questions.get(frame.id);
    if (!question) continue;
    if (frame.result === undefined) { questions.delete(frame.id); continue; }
    await Bun.write(join(directory, `answer-${question.threadId}-${question.turnId}.json`), JSON.stringify(frame.result));
    const turn = turns.get(question.threadId)!;
    turn.status = "completed"; thread(question.threadId).status = { type: "idle" };
    notify("item/completed", { threadId: question.threadId, turnId: turn.id,
      item: { type: "agentMessage", id: crypto.randomUUID(), text: `Consumed answer: ${JSON.stringify(frame.result)}` } });
    notify("turn/completed", { threadId: question.threadId, turn });
    questions.delete(frame.id); await save();
    continue;
  }
  if (frame.method === "turn/steer" && await Bun.file(join(directory, ".fixture-steer-reject")).exists()) {
    console.log(JSON.stringify({ id: frame.id, error: { code: -32600, message: "Expected turn changed before admission" } }));
    continue;
  }
  try { console.log(JSON.stringify({ id: frame.id, result: await request(frame.method!, frame.params ?? {}) })); }
  catch { console.log(JSON.stringify({ id: frame.id, error: { code: -32603, message: "Fixture external request failed" } })); }
}
for (const [id, process] of processes) {
  process.stdin.end(); await process.exited;
  await Bun.write(join(directory, `.fixture-stopped-${id}`), "settled");
}
await Bun.write(join(directory, ".fixture-runtime-closed"), "owned subprocesses settled");
