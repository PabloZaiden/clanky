/**
 * Native HTTP seam with durable forms, legacy descendants and a lost reply
 * acknowledgement. Real adapters and application routes own the workflows.
 */
import type { SessionInfo, PermissionRuleset } from "@opencode/client";
import { pollUntil } from "../helpers/polling";

if (process.argv.includes("--version")) {
  console.log("2.0.20");
  process.exit(0);
}

type Session = Pick<SessionInfo, "id" | "parentID" | "location" | "time" | "metadata" | "permissions" | "outcome">;
const directory = process.cwd();
const stateFile = `${directory}/native-question-state.json`;
const allow: PermissionRuleset = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "bash", resource: "unrelated-restricted-command", effect: "deny" },
];
const initial = (id: string, parentID?: string): Session => ({
  id, parentID, location: { directory }, permissions: allow,
  time: { created: Date.now(), updated: Date.now() }, metadata: {},
});
const sessions: Session[] = await Bun.file(stateFile).exists() ? await Bun.file(stateFile).json()
  : [initial("owned-root"), initial("legacy-child", "owned-root"), initial("foreign-root")];
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
let active = false;
const save = async (): Promise<void> => { await Bun.write(stateFile, JSON.stringify(sessions)); };
let overlappingRequests: Promise<boolean> | undefined;
const waitForOverlap = async (marker: string): Promise<void> => {
  if (!await Bun.file(`${directory}/gate-question-reconnect`).exists()) return;
  await Bun.write(`${directory}/${marker}`, "");
  overlappingRequests ??= pollUntil(
    async () => await Bun.file(`${directory}/release-question-reconnect`).exists(),
    (released) => released,
    { description: "release overlapping native reconnect and lost answer receipt", timeoutMs: 10_000 },
  );
  await overlappingRequests;
};
const emit = (type: string, data: unknown): void => {
  const frame = new TextEncoder().encode(`data: ${JSON.stringify({ id: crypto.randomUUID(), type, created: Date.now(), data })}\n\n`);
  for (const stream of streams) stream.enqueue(frame);
};
const form = {
  id: "native-question", sessionID: "owned-root", status: "pending",
  fields: [{ key: "color", type: "string", title: "Color", custom: true, options: [{ value: "Blue", label: "Blue" }] }],
};
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (request.headers.get("authorization") !== `Basic ${Buffer.from(`opencode:${process.env["OPENCODE_SERVER_PASSWORD"]}`).toString("base64")}`) {
      return new Response(null, { status: 401 });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/info") return Response.json({ version: "2.0.20" });
    if (path === "/api/event") {
      let connection: ReadableStreamDefaultController<Uint8Array>;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          if (streams.size >= 8) throw new Error("Native fixture stream capacity reached.");
          connection = controller;
          streams.add(controller);
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", created: Date.now(), data: {} })}\n\n`));
        },
        cancel() { streams.delete(connection); },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (path === "/api/model") return Response.json({ data: [{ id: "fixture-model", providerID: "opencode", name: "Fixture", enabled: true, variants: [] }], cursor: {} });
    if (path === "/api/integration" || path === "/api/shell") return Response.json({ data: [], cursor: {} });
    if (path === "/api/session/active") return Response.json({ data: active ? { "owned-root": {} } : {} });
    if (path === "/api/session") {
      if (request.method === "POST") {
        const input = await request.json() as Partial<Session>;
        Object.assign(sessions[0]!, input);
        await save();
        return Response.json({ data: sessions[0] });
      }
      return Response.json({ data: sessions.filter((session) => session.parentID === url.searchParams.get("parentID")), cursor: {} });
    }
    const match = /^\/api\/session\/([^/]+)(.*)$/.exec(path);
    const session = sessions.find((entry) => entry.id === match?.[1]);
    if (!match || !session) return new Response(null, { status: 404 });
    const suffix = match[2];
    if (suffix === "/model") {
      Object.assign(session, await request.json());
      await save();
      return new Response(null, { status: 204 });
    }
    if (!suffix) {
      if (request.method === "GET") return Response.json({ data: session });
      if (request.method === "PATCH") {
        Object.assign(session, await request.json());
        await save();
        await waitForOverlap("native-reconnect-ready");
      }
      return new Response(null, { status: 204 });
    }
    if (suffix === "/prompt") {
      if (session.parentID) {
        const questionRule = session.permissions?.findLast((rule) => (rule.action === "question" || rule.action === "*") && rule.resource === "*");
        if (questionRule?.effect !== "deny") return Response.json({ error: "Native child still permits human input" }, { status: 409 });
        await Bun.write(`${directory}/native-child-effect.txt`, "child continued without human input");
        session.outcome = "succeeded";
        await save();
        emit("session.execution.succeeded", { sessionID: session.id });
      } else {
        const input = await request.json() as { text?: string };
        active = true;
        emit("session.execution.started", { sessionID: session.id });
        const cycle = /^resolved-question-cycle:(\d+)$/.exec(input.text ?? "");
        if (cycle) {
          for (let index = 0; index < 16; index++) {
            const id = `cycle-${cycle[1]}-${index}`;
            emit("form.created", { form: { ...form, id } });
            emit("form.cancelled", { id, sessionID: session.id });
          }
          active = false;
          emit("session.execution.succeeded", { sessionID: session.id });
          return Response.json({ data: { id: crypto.randomUUID(), sessionID: session.id, type: "user" } });
        }
        form.status = "pending";
        emit("form.created", { form });
      }
      return Response.json({ data: { id: crypto.randomUUID(), sessionID: session.id, type: "user" } });
    }
    if (suffix === "/form/native-question/reply") {
      const input = await request.json() as { answer: unknown };
      const historyFile = `${directory}/native-answer-effects.json`;
      const history: unknown[] = await Bun.file(historyFile).exists() ? await Bun.file(historyFile).json() : [];
      if (history.length >= 32) throw new Error("Native fixture answer capacity reached.");
      await Bun.write(historyFile, JSON.stringify([...history, input.answer]));
      form.status = "answered";
      if (await Bun.file(`${directory}/confirm-native-answers`).exists()) {
        active = false;
        emit("form.replied", { id: form.id, sessionID: session.id });
        emit("session.execution.succeeded", { sessionID: session.id });
        return new Response(null, { status: 204 });
      }
      // The provider accepted the input, but both acknowledgement paths were
      // lost. No native receipt is available to justify a retry or success.
      await waitForOverlap("native-answer-ready");
      return Response.json({ error: "Reply acknowledgement lost" }, { status: 503 });
    }
    if (suffix === "/form/native-question" && request.method === "DELETE") {
      if (form.status === "pending") form.status = "cancelled";
      return new Response(null, { status: 204 });
    }
    if (suffix === "/interrupt") {
      active = false;
      session.outcome = "interrupted";
      emit("session.execution.interrupted", { sessionID: session.id });
      return Response.json({});
    }
    return new Response(null, { status: 404 });
  },
});
console.log(JSON.stringify({ url: server.url.toString() }));
try {
  for await (const _chunk of Bun.stdin.stream()) {}
} finally {
  await save();
  await server.stop(true);
}
