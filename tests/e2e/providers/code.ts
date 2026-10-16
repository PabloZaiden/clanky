/**
 * External deterministic VS Code CLI seam, invoked through the host PATH.
 */

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("serve-web --host --port --connection-token-file --default-folder --server-data-dir");
  process.exit(0);
}

if (!args.includes("--host-process")) {
  const child = Bun.spawn([process.execPath, import.meta.path, ...args, "--host-process"], {
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  process.exit(await child.exited);
}

function value(name: string): string {
  const index = args.indexOf(name);
  const result = args[index + 1];
  if (index < 0 || !result) throw new Error(`Missing ${name}`);
  return result;
}

const token = (await Bun.file(value("--connection-token-file")).text()).trim();
const directory = value("--default-folder");
const server: Bun.Server<undefined> = Bun.serve<undefined>({
  hostname: value("--host"),
  port: Number(value("--port")),
  fetch(request: Request): Response | undefined {
    const url = new URL(request.url);
    if (url.searchParams.get("tkn") !== token && !(request.headers.get("cookie") ?? "").split(";").some((cookie) => cookie.trim() === `vscode-tkn=${token}`)) {
      return new Response("Unauthorized", { status: 403 });
    }
    if (request.headers.get("upgrade") === "websocket") {
      return server.upgrade(request) ? undefined : new Response("Upgrade failed", { status: 400 });
    }
    if (url.pathname === "/") {
      return new Response(`<!doctype html><html><title>workbench</title><body>${directory}</body></html>`, {
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    message(socket, data) { socket.send(data); },
  },
});
console.log(`Web UI available at http://127.0.0.1:${String(server.port)}`);
