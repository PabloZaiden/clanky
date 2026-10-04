/**
 * Local JSON-RPC runtime that persists a steered message before an ambiguous reply.
 */

import { z } from "zod";

if (process.env["CLANKY_CODEX_RECOVERY_FIXTURE"] !== "1") {
  throw new Error("The Codex admission fixture requires an isolated environment.");
}
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.159.2");
} else {
  const HistorySchema = z.object({
    threadId: z.string(),
    turnId: z.string(),
    active: z.boolean(),
    messages: z.array(z.object({
      turnId: z.string(),
      item: z.object({
        type: z.literal("userMessage"), id: z.string(), clientId: z.string(),
        content: z.array(z.unknown()),
      }),
      startedAtMs: z.number().nullable(),
      completedAtMs: z.number().nullable(),
    })),
  });
  const file = Bun.file("native-history.json");
  const history: z.infer<typeof HistorySchema> = await file.exists()
    ? HistorySchema.parse(await file.json())
    : { threadId: crypto.randomUUID(), turnId: crypto.randomUUID(), active: false, messages: [] };
  const thread = () => ({
    id: history.threadId, sessionId: history.threadId, cwd: process.cwd(),
    parentThreadId: null, createdAt: 0, status: history.active
      ? { type: "active", activeFlags: [] } : { type: "idle" },
    model: null, reasoningEffort: null, turns: [],
  });
  const turn = () => ({
    id: history.turnId, status: history.active ? "inProgress" : "interrupted",
    items: [], itemsView: "full", error: null,
    startedAt: null, completedAt: null, durationMs: null,
  });
  const save = () => Bun.write(file, JSON.stringify(history));
  const FrameSchema = z.object({
    id: z.number().optional(), method: z.string(),
    params: z.record(z.string(), z.unknown()).default({}),
  });
  let pending = "";
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = pending.indexOf("\n")) >= 0) {
      const frame = FrameSchema.parse(JSON.parse(pending.slice(0, index)));
      pending = pending.slice(index + 1);
      if (frame.id === undefined) continue;
      let result: unknown;
      switch (frame.method) {
        case "initialize": result = {}; break;
        case "model/list":
        case "thread/list":
        case "thread/backgroundTerminals/list":
          result = { data: [], nextCursor: null }; break;
        case "thread/start":
        case "thread/resume":
        case "thread/read":
          await save();
          result = { thread: thread() }; break;
        case "turn/start":
          history.active = true;
          await save();
          result = { turn: turn() }; break;
        case "turn/steer":
          history.messages.push({
            turnId: history.turnId,
            item: {
              type: "userMessage", id: crypto.randomUUID(),
              clientId: z.string().parse(frame.params["clientUserMessageId"]),
              content: z.array(z.unknown()).parse(frame.params["input"]),
            },
            startedAtMs: null, completedAtMs: null,
          });
          await save();
          console.log(JSON.stringify({ id: frame.id, error: { code: -32000, message: "Admission reply unavailable." } }));
          continue;
        case "thread/items/list":
          result = frame.params["cursor"] === "admitted-message"
            ? { data: history.messages, nextCursor: null }
            : {
                data: [{
                  turnId: history.turnId,
                  item: { type: "userMessage", id: "unrelated-message", clientId: "unrelated-input", content: [] },
                  startedAtMs: null, completedAtMs: null,
                }],
                nextCursor: history.messages.length ? "admitted-message" : null,
              };
          break;
        case "thread/turns/list":
          result = { data: history.active ? [turn()] : [], nextCursor: null }; break;
        case "turn/interrupt":
          history.active = false;
          await save();
          result = {}; break;
        default:
          console.log(JSON.stringify({ id: frame.id, error: { code: -32601, message: "Unsupported fixture method." } }));
          continue;
      }
      console.log(JSON.stringify({ id: frame.id, result }));
    }
  }
}
