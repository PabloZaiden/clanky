/**
 * DAV method translation; credentials and host authorization stay at boundaries.
 */

import type { FileSystemConditions, FileSystemEntry } from "../../contracts/schemas/file-system";
import { davDestination, davHostPath, davHref } from "./paths";
import { activeLockXml, propfindResponse, proppatchResponse } from "./properties";
import { DavError, isDav, parseDavIf, readDavXml, xmlResponse, type DavXmlNode } from "./protocol";
import type { WebDavFileClient } from "./remote";
import { byteRange, rangeStream } from "./ranges";

function conditions(req: Request, client: WebDavFileClient): FileSystemConditions {
  const url = new URL(req.url);
  const header = req.headers.get("if");
  return {
    ...(req.headers.has("if-match") ? { ifMatch: req.headers.get("if-match")! } : {}),
    ...(req.headers.has("if-none-match") ? { ifNoneMatch: req.headers.get("if-none-match")! } : {}),
    ...(header === null ? {} : { davIf: parseDavIf(header, (value) => davDestination(value, url, client.info)) }),
  };
}

function depth(req: Request, allowed: string[], fallback: string): string {
  const value = req.headers.get("depth") ?? fallback;
  if (!allowed.includes(value)) throw new DavError(403, "This DAV depth is not supported.");
  return value;
}

function overwrite(req: Request): boolean {
  const value = req.headers.get("overwrite") ?? "T";
  if (value !== "T" && value !== "F") throw new DavError(400, "Invalid DAV Overwrite header.");
  return value === "T";
}

function timeout(req: Request): number {
  const header = req.headers.get("timeout") ?? "Second-600";
  for (const value of header.split(",").map((item) => item.trim())) {
    if (value === "Infinite") return 3_600;
    if (/^Second-[1-9][0-9]*$/.test(value)) return Math.min(Number(value.slice(7)), 3_600);
  }
  throw new DavError(400, "Invalid DAV Timeout header.");
}

function ownerText(node: DavXmlNode): string {
  return node.text + node.children.map(ownerText).join("");
}

async function lock(req: Request, path: string, client: WebDavFileClient, ownerId: string, signal: AbortSignal): Promise<Response> {
  const body = await readDavXml(req);
  let result;
  if (body) {
    if (!isDav(body, "lockinfo")) throw new DavError(400, "Expected DAV lockinfo.");
    const scope = body.children.find((node) => isDav(node, "lockscope"));
    const type = body.children.find((node) => isDav(node, "locktype"));
    if (scope?.children.length !== 1 || !type?.children.some((node) => isDav(node, "write"))) {
      throw new DavError(400, "Invalid DAV lock type or scope.");
    }
    const exclusive = isDav(scope.children[0]!, "exclusive");
    if (!exclusive && !isDav(scope.children[0]!, "shared")) throw new DavError(400, "Invalid DAV lock scope.");
    result = await client.command({
      operation: "lock", path, ownerId, scope: exclusive ? "exclusive" : "shared",
      depth: depth(req, ["0", "infinity"], "infinity") === "0" ? "0" : "infinity",
      owner: ownerText(body.children.find((node) => isDav(node, "owner")) ?? { text: "", children: [], namespace: "", name: "" }),
      timeoutSeconds: timeout(req), conditions: conditions(req, client),
    }, signal);
  } else {
    if (!req.headers.has("if")) throw new DavError(400, "Refreshing a DAV lock requires an If header.");
    result = await client.command({
      operation: "refreshLock", path, ownerId, timeoutSeconds: timeout(req), conditions: conditions(req, client),
    }, signal);
  }
  if (!result.lock) throw new DavError(502, "Clanky returned no DAV lock.");
  return xmlResponse(`<D:prop xmlns:D="DAV:"><D:lockdiscovery>${activeLockXml(result.lock, client.info.pathStyle)}</D:lockdiscovery></D:prop>`,
    result.created ? 201 : 200, { "lock-token": `<${result.lock.token}>` });
}

function validateReadConditions(req: Request, etag: string): number | null {
  const matches = (value: string, weak: boolean) => value.trim() === "*"
    || value.split(",").some((tag) => (
      weak ? tag.trim().replace(/^W\//, "") === etag.replace(/^W\//, "") : tag.trim() === etag && !etag.startsWith("W/")
    ));
  const match = req.headers.get("if-match");
  if (match !== null && !matches(match, false)) return 412;
  const none = req.headers.get("if-none-match");
  if (none !== null && matches(none, true)) return 304;
  return null;
}

async function read(req: Request, path: string, client: WebDavFileClient, signal: AbortSignal): Promise<Response> {
  const response = await client.read(path, req.method === "HEAD" ? "HEAD" : "GET", signal);
  const headers = new Headers({
    "content-type": "application/octet-stream", "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  for (const name of ["etag", "last-modified", "content-length"]) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const length = response.headers.get("content-length") ?? response.headers.get("x-clanky-download-size");
  const size = length === null ? NaN : Number(length);
  if (!Number.isSafeInteger(size) || size < 0) {
    await response.body?.cancel();
    throw new DavError(502, "Clanky returned an invalid file size.");
  }
  headers.set("content-length", String(size));
  headers.set("accept-ranges", "bytes");
  const conditional = validateReadConditions(req, response.headers.get("etag") ?? "");
  if (conditional) {
    await response.body?.cancel();
    headers.delete("content-length");
    return new Response(null, { status: conditional, headers });
  }
  const range = req.headers.get("range");
  const ifRange = req.headers.get("if-range");
  const matchesRange = ifRange === null || ifRange === headers.get("etag")
    || (!ifRange.startsWith('"') && !ifRange.startsWith("W/")
      && Date.parse(ifRange) === Date.parse(headers.get("last-modified") ?? ""));
  if (req.method === "GET" && range !== null && matchesRange) {
    try {
      const selected = byteRange(range, size);
      if (!response.body) throw new DavError(502, "Clanky returned no file stream.");
      headers.set("content-range", `bytes ${String(selected.start)}-${String(selected.end)}/${String(size)}`);
      headers.set("content-length", String(selected.end - selected.start + 1));
      return new Response(rangeStream(response.body, selected), { status: 206, headers });
    } catch (error) {
      await response.body?.cancel();
      if (!(error instanceof DavError) || error.status !== 416) throw error;
      headers.delete("content-length");
      headers.set("content-range", `bytes */${String(size)}`);
      return new Response(null, { status: 416, headers });
    }
  }
  return new Response(response.body, { headers });
}

function requireEntry(entry: FileSystemEntry | null | undefined): FileSystemEntry {
  if (!entry) throw new DavError(404, "Resource not found.");
  return entry;
}

export async function handleDavRequest(
  req: Request, client: WebDavFileClient,
  options: { readOnly: boolean; ownerId: string; signal: AbortSignal },
): Promise<Response> {
  const path = davHostPath(new URL(req.url).pathname, client.info);
  const signal = options.signal;
  const writableMethods = ["PUT", "MKCOL", "MOVE", "COPY", "DELETE", "PROPPATCH", "LOCK", "UNLOCK"];
  if (options.readOnly && writableMethods.includes(req.method)) throw new DavError(403, "This DAV endpoint is read-only.");
  switch (req.method) {
    case "OPTIONS": {
      const methods = ["OPTIONS", "PROPFIND", "GET", "HEAD", ...(options.readOnly ? [] : writableMethods)];
      return new Response(null, { status: 200, headers: { dav: options.readOnly ? "1" : "1, 2", allow: methods.join(", ") } });
    }
    case "GET":
    case "HEAD":
      return await read(req, path, client, signal);
    case "PROPFIND": {
      const requestedDepth = depth(req, ["0", "1"], "infinity");
      const body = await readDavXml(req);
      const result = await client.command({ operation: requestedDepth === "1" ? "list" : "stat", path }, signal);
      const entry = requireEntry(result.entry);
      return propfindResponse(body, {
        entries: [entry, ...(result.entries ?? [])], locks: result.locks ?? [],
        style: client.info.pathStyle, readOnly: options.readOnly,
      });
    }
    case "PROPPATCH": {
      const entry = requireEntry((await client.command({ operation: "stat", path }, signal)).entry);
      return proppatchResponse(await readDavXml(req), davHref(entry.path, entry.kind, client.info.pathStyle));
    }
    case "PUT": {
      const result = await client.write({ path, req, conditions: conditions(req, client), signal });
      return new Response(null, { status: result.created ? 201 : 204,
        headers: result.entry ? { etag: result.entry.etag } : undefined });
    }
    case "MKCOL": {
      if (req.body) {
        const reader = req.body.getReader();
        try {
          const first = await reader.read();
          if (!first.done) {
            await reader.cancel();
            throw new DavError(415, "MKCOL bodies are not supported.");
          }
        } finally { reader.releaseLock(); }
      }
      await client.command({ operation: "mkdir", path, conditions: conditions(req, client) }, signal);
      return new Response(null, { status: 201 });
    }
    case "DELETE":
      await client.command({ operation: "delete", path, conditions: conditions(req, client) }, signal);
      return new Response(null, { status: 204 });
    case "MOVE":
    case "COPY": {
      const destination = req.headers.get("destination");
      if (!destination) throw new DavError(400, "A DAV Destination is required.");
      const result = await client.command({
        operation: req.method === "MOVE" ? "move" : "copy", path,
        destination: davDestination(destination, new URL(req.url), client.info), overwrite: overwrite(req),
        depth: depth(req, req.method === "MOVE" ? ["infinity"] : ["0", "infinity"], "infinity") === "0" ? "0" : "infinity",
        conditions: conditions(req, client),
      }, signal);
      return new Response(null, { status: result.overwritten ? 204 : 201 });
    }
    case "LOCK":
      return await lock(req, path, client, options.ownerId, signal);
    case "UNLOCK": {
      const token = /^<([^<>]+)>$/.exec(req.headers.get("lock-token") ?? "")?.[1];
      if (!token) throw new DavError(400, "A valid DAV Lock-Token is required.");
      await client.command({ operation: "unlock", path, token, ownerId: options.ownerId }, signal);
      return new Response(null, { status: 204 });
    }
    default:
      throw new DavError(405, "DAV method not supported.");
  }
}
