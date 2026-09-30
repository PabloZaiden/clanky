/**
 * Bounded, namespace-aware DAV XML and conditional-header parsing.
 */

import { SaxesParser } from "saxes";
import { FILE_SYSTEM_MAX_METADATA_BYTES, type FileSystemConditions } from "../../contracts/schemas/file-system";

export const DAV_NAMESPACE = "DAV:";
export const DAV_MAX_XML_BYTES = 64 * 1_024;
export const DAV_MAX_REQUESTS = 32;

export class DavError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DavError";
  }
}

export interface DavXmlNode {
  namespace: string;
  name: string;
  text: string;
  children: DavXmlNode[];
}

export function xml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value)) {
    throw new DavError(422, "The resource name cannot be represented in DAV XML.");
  }
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function isDav(node: DavXmlNode, name: string): boolean {
  return node.namespace === DAV_NAMESPACE && node.name === name;
}

export async function readDavXml(req: Request): Promise<DavXmlNode | null> {
  if (!req.body) return null;
  const reader = req.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "";
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > DAV_MAX_XML_BYTES) throw new DavError(413, "DAV XML body limit exceeded.");
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    try { await reader.cancel(); }
    catch {
      // Preserve the parse/limit failure when an already errored source rejects cancellation.
    }
    if (error instanceof DavError) throw error;
    throw new DavError(400, "Invalid DAV XML encoding.");
  } finally {
    reader.releaseLock();
  }
  if (!body.trim()) return null;
  const parser = new SaxesParser({ xmlns: true });
  const stack: DavXmlNode[] = [];
  let root: DavXmlNode | null = null;
  parser.on("doctype", () => { throw new DavError(400, "XML document types are not supported."); });
  parser.on("error", () => { throw new DavError(400, "Invalid DAV XML."); });
  parser.on("opentag", (tag) => {
    if (stack.length >= 32) throw new DavError(413, "DAV XML nesting limit exceeded.");
    const node: DavXmlNode = { namespace: tag.uri, name: tag.local, text: "", children: [] };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else root = node;
    stack.push(node);
  });
  parser.on("closetag", () => { stack.pop(); });
  const append = (text: string) => {
    const node = stack.at(-1);
    if (node) node.text += text;
  };
  parser.on("text", append);
  parser.on("cdata", append);
  parser.write(body).close();
  return root;
}

export function xmlResponse(body: string | Iterable<string>, status = 207, headers?: HeadersInit): Response {
  const parts = ['<?xml version="1.0" encoding="utf-8"?>'];
  let bytes = Buffer.byteLength(parts[0]!);
  for (const part of typeof body === "string" ? [body] : body) {
    bytes += Buffer.byteLength(part);
    if (bytes > FILE_SYSTEM_MAX_METADATA_BYTES) throw new DavError(507, "DAV XML response size limit exceeded.");
    parts.push(part);
  }
  return new Response(parts.join(""), {
    status,
    headers: { ...Object.fromEntries(new Headers(headers)), "content-type": "application/xml; charset=utf-8" },
  });
}

export function parseDavIf(value: string, pathForUrl: (url: string) => string): NonNullable<FileSystemConditions["davIf"]> {
  if (value.length > 8_192) throw new DavError(431, "DAV If header limit exceeded.");
  const result: NonNullable<FileSystemConditions["davIf"]> = [];
  let offset = 0;
  let path: string | undefined;
  const skip = () => { while (/\s/.test(value[offset] ?? "") && offset < value.length) offset += 1; };
  const delimited = (open: string, close: string): string => {
    if (value[offset] !== open) throw new DavError(400, "Invalid DAV If header.");
    const end = value.indexOf(close, offset + 1);
    if (end < 0) throw new DavError(400, "Invalid DAV If header.");
    const text = value.slice(offset + 1, end);
    offset = end + 1;
    return text;
  };
  while (offset < value.length) {
    skip();
    if (offset === value.length) break;
    if (value[offset] === "<") {
      if (result.some((list) => list.path === undefined)) throw new DavError(400, "Mixed DAV If header forms are not supported.");
      path = pathForUrl(delimited("<", ">"));
      skip();
    }
    if (value[offset++] !== "(") throw new DavError(400, "Invalid DAV If header.");
    const terms: NonNullable<FileSystemConditions["davIf"]>[number]["terms"] = [];
    while (offset < value.length) {
      skip();
      if (value[offset] === ")") { offset += 1; break; }
      let not = false;
      if (value.slice(offset, offset + 3) === "Not") { not = true; offset += 3; skip(); }
      if (value[offset] === "<") terms.push({ kind: "token", value: delimited("<", ">"), not });
      else if (value[offset] === "[") terms.push({ kind: "etag", value: delimited("[", "]"), not });
      else throw new DavError(400, "Invalid DAV If header.");
      if (terms.length > 32) throw new DavError(431, "DAV If header limit exceeded.");
    }
    if (!terms.length || value[offset - 1] !== ")") throw new DavError(400, "Invalid DAV If header.");
    result.push({ path, terms });
    if (result.length > 32) throw new DavError(431, "DAV If header limit exceeded.");
  }
  if (!result.length) throw new DavError(400, "Invalid DAV If header.");
  return result;
}
