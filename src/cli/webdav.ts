/**
 * Foreground, loopback-only WebDAV workspace bridge.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { WebAppCliCommandContext, CliCommandResult } from "@pablozaiden/webapp/cli";
import type { ClankyCliContext } from "./mesh";
import type { CliApiContext } from "./remote-api";
import { handleDavRequest } from "./webdav/handler";
import { davHref } from "./webdav/paths";
import { DAV_MAX_REQUESTS, DavError } from "./webdav/protocol";
import { WebDavFileClient } from "./webdav/remote";

export interface WebDavCommand {
  operation: "webdav";
  workspace: string;
  readOnly: boolean;
  localPort?: number;
  tlsCert?: string;
  tlsKey?: string;
}

export function parseWebDavCommandArgs(args: readonly string[]): WebDavCommand {
  let workspace: string | undefined;
  let readOnly = false;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--read-only") {
      if (readOnly) throw new Error("--read-only may only be specified once");
      readOnly = true;
    } else if (arg.startsWith("--")) {
      const separator = arg.indexOf("=");
      const name = separator < 0 ? arg : arg.slice(0, separator);
      if (!["--local-port", "--tls-cert", "--tls-key"].includes(name)) throw new Error(`Unknown WebDAV option: ${name}`);
      if (values.has(name)) throw new Error(`${name} may only be specified once`);
      const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      values.set(name, value);
    } else {
      if (workspace) throw new Error("workspace webdav requires exactly one workspace ID or name");
      workspace = arg;
    }
  }
  if (!workspace) throw new Error("workspace webdav requires a workspace ID or name");
  const port = values.get("--local-port");
  const localPort = port === undefined ? undefined : Number(port);
  if (localPort !== undefined && (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535)) {
    throw new Error("--local-port must be an integer between 1 and 65535");
  }
  const tlsCert = values.get("--tls-cert");
  const tlsKey = values.get("--tls-key");
  if (Boolean(tlsCert) !== Boolean(tlsKey)) throw new Error("--tls-cert and --tls-key must be supplied together");
  return { operation: "webdav", workspace, readOnly, localPort, tlsCert, tlsKey };
}

export interface WebDavBridge {
  url: string;
  origin: string;
  username: string;
  password: string;
  close(): Promise<void>;
}

function authenticated(req: Request, expected: Buffer): boolean {
  const supplied = Buffer.from((req.headers.get("authorization") ?? "").replace(/^basic /i, "Basic "));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function ownedStream(stream: ReadableStream<Uint8Array>, release: () => void): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { release(); reader.releaseLock(); controller.close(); }
        else controller.enqueue(chunk.value);
      } catch (error) { release(); reader.releaseLock(); controller.error(error); }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { release(); reader.releaseLock(); }
    },
  });
}

export async function startWorkspaceWebDav(
  input: CliApiContext, command: WebDavCommand, signal?: AbortSignal,
): Promise<WebDavBridge> {
  signal?.throwIfAborted();
  const client = await WebDavFileClient.connect(input, command.workspace, signal);
  const initial = await client.command({ operation: "stat", path: client.info.directory }, signal);
  if (initial.entry?.kind !== "directory") throw new Error("The initial workspace directory is unavailable");
  if (!command.readOnly && !client.info.commandExecution) {
    throw new Error("Read/write WebDAV requires commandExecution for directory operations; use --read-only");
  }
  const username = "clanky";
  const password = randomBytes(32).toString("base64url");
  const authorization = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  const ownerId = randomUUID();
  const controllers = new Set<AbortController>();
  const requests = new Set<Promise<Response>>();
  let closed = false;
  const tls = command.tlsCert && command.tlsKey ? {
    cert: await Bun.file(command.tlsCert).text(), key: await Bun.file(command.tlsKey).text(),
  } : undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: command.localPort ?? 0, tls,
    idleTimeout: 255,
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    fetch(req): Promise<Response> | Response {
      const url = new URL(req.url);
      const protocol = tls ? "https:" : "http:";
      const port = url.port || (protocol === "https:" ? "443" : "80");
      if (closed || !["127.0.0.1", "localhost"].includes(url.hostname) || url.protocol !== protocol || port !== String(server.port)) {
        return new Response("Invalid local DAV authority.", { status: 403 });
      }
      const origin = req.headers.get("origin");
      if (origin !== null && origin !== url.origin) return new Response("Cross-origin DAV access denied.", { status: 403 });
      if (!authenticated(req, authorization)) return new Response("Local DAV authentication required.", {
        status: 401, headers: { "www-authenticate": `Basic realm="Clanky WebDAV ${ownerId}", charset="UTF-8"` },
      });
      if (controllers.size >= DAV_MAX_REQUESTS) return new Response("DAV request capacity reached.", { status: 503 });
      const controller = new AbortController();
      controllers.add(controller);
      const combined = AbortSignal.any([controller.signal, req.signal, ...(signal ? [signal] : [])]);
      const release = () => { controllers.delete(controller); };
      const request = handleDavRequest(req, client, { readOnly: command.readOnly, ownerId, signal: combined })
        .then((response) => {
          if (!response.body) { release(); return response; }
          return new Response(ownedStream(response.body, release), response);
        })
        .catch((error: unknown) => {
          release();
          if (combined.aborted) return new Response(null, { status: 499 });
          if (error instanceof DavError) return new Response(error.message, { status: error.status });
          console.error(`WebDAV request failed: ${String(error)}`);
          return new Response("WebDAV upstream operation failed.", { status: 502 });
        })
        .finally(() => { requests.delete(request); });
      requests.add(request);
      return request;
    },
  });
  const origin = `${tls ? "https" : "http"}://127.0.0.1:${String(server.port)}`;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      closed = true;
      signal?.removeEventListener("abort", onAbort);
      for (const controller of controllers) controller.abort();
      await server.stop(true);
      await Promise.allSettled(requests);
      await client.command({ operation: "releaseLocks", ownerId }, AbortSignal.timeout(5_000));
    })();
    return closing;
  };
  const onAbort = () => { void close().catch((error: unknown) => console.error(`WebDAV shutdown failed: ${String(error)}`)); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    await close();
    signal.throwIfAborted();
  }
  return { url: origin + davHref(client.info.directory, "directory", client.info.pathStyle), origin, username, password, close };
}

export async function runWorkspaceWebDav(
  context: WebAppCliCommandContext<ClankyCliContext>, command: WebDavCommand, signal: AbortSignal,
): Promise<CliCommandResult> {
  const bridge = await startWorkspaceWebDav({
    fetchFn: context.fetchFn, environment: context.environment, envPrefix: context.envPrefix,
    credentials: context.profiles.credentials(context.profile),
  }, command, signal);
  try {
    context.stdout.write(`WebDAV ready: ${bridge.url}\nMode: ${command.readOnly ? "read-only" : "read/write"}\n`);
    context.stdout.write(`Local username: ${bridge.username}\nLocal password: ${bridge.password}\n`);
    context.stdout.write("Keep this command running. Mount the URL with your OS WebDAV client; Ctrl+C stops it.\n");
    context.stdout.write(`Mount another absolute host path under the same endpoint: ${bridge.origin}\n`);
    if (process.platform === "darwin") {
      context.stdout.write("macOS: Finder > Go > Connect to Server (Cmd+K), then use the local credentials above.\n");
    }
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { exitCode: 0 };
  } finally {
    await bridge.close();
  }
}
