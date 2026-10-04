/**
 * Native HTTP registry with real shell processes at the OpenCode CLI seam.
 */

if (process.env["CLANKY_OPENCODE_SHELL_FIXTURE"] !== "1") {
  throw new Error("The OpenCode shell fixture requires an isolated environment.");
}

const directory = process.cwd();
const session = {
  id: "owned-root", projectID: "fixture-project", location: { directory },
  time: { created: Date.now(), updated: Date.now() }, metadata: {},
};
const shells = ["owned", "foreign", "unattributed"].map((id) => ({
  id,
  process: Bun.spawn([process.execPath, "-e", "for await (const _ of Bun.stdin.stream()) {}"], {
    stdin: "pipe", stdout: "ignore", stderr: "ignore",
  }),
}));
await Bun.write("shell-pids.json", JSON.stringify(Object.fromEntries(shells.map((shell) => [shell.id, shell.process.pid]))));

async function stop(id: string): Promise<void> {
  const shell = shells.find((entry) => entry.id === id);
  if (!shell) throw new Error("Unknown fixture shell.");
  if (shell.process.exitCode === null) shell.process.stdin.end();
  await shell.process.exited;
}

const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.headers.get("authorization") !== `Basic ${Buffer.from(`opencode:${process.env["OPENCODE_SERVER_PASSWORD"]}`).toString("base64")}`) {
      return new Response(null, { status: 401 });
    }
    if (path === "/api/info") return Response.json({ version: "2.0.20" });
    if (path === "/api/event") return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", created: Date.now(), data: {} })}\n\n`));
      },
    }), { headers: { "content-type": "text/event-stream" } });
    if (path === "/api/session/active") return Response.json({ data: {} });
    if (path === "/api/session") return Response.json(request.method === "POST" ? { data: session } : { data: [], cursor: {} });
    if (path === "/api/session/owned-root" && request.method === "PATCH") {
      Object.assign(session, await request.json());
      return new Response(null, { status: 204 });
    }
    if (path === "/api/session/owned-root" && request.method === "DELETE") return new Response(null, { status: 204 });
    if (path === "/api/session/owned-root/interrupt") return Response.json({});
    if (path === "/api/model" || path === "/api/integration") return Response.json({ data: [], cursor: {} });
    if (path === "/api/shell") {
      if (await Bun.file("settle-external").exists()) await Promise.all([stop("foreign"), stop("unattributed")]);
      return Response.json({ data: shells.map((shell) => ({
        id: shell.id, command: "native workspace writer", cwd: directory, shell: "fixture", file: "",
        status: shell.process.exitCode === null ? "running" : "killed",
        metadata: shell.id === "unattributed" ? {} : { sessionID: shell.id === "owned" ? session.id : "foreign-root" },
        time: { started: session.time.created },
      })) });
    }
    if (path.startsWith("/api/shell/") && request.method === "DELETE") {
      await stop(path.slice("/api/shell/".length));
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "Unsupported fixture route" }, { status: 404 });
  },
});
console.log(JSON.stringify({ url: server.url.toString() }));
try {
  for await (const _chunk of Bun.stdin.stream()) {}
} finally {
  await Promise.all(shells.map((shell) => stop(shell.id)));
  await server.stop(true);
}
