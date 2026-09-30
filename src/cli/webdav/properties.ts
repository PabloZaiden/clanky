/**
 * DAV live properties and honest failures for unsupported property mutations.
 */

import type { FileSystemEntry, FileSystemInfo, FileSystemLock } from "../../contracts/schemas/file-system";
import { davHref } from "./paths";
import { DAV_NAMESPACE, DavError, isDav, xml, xmlResponse, type DavXmlNode } from "./protocol";

const LIVE_PROPERTIES = [
  "displayname", "resourcetype", "getcontentlength", "getlastmodified",
  "getcontenttype", "getetag", "supportedlock", "lockdiscovery",
];

function* propertyTag(
  namespace: string, name: string, content?: string | Iterable<string>,
): Generator<string, void, unknown> {
  const qualified = namespace === "" ? name : `${namespace === DAV_NAMESPACE ? "D" : "P"}:${name}`;
  const attributes = namespace === "" ? ' xmlns=""'
    : namespace === DAV_NAMESPACE ? "" : ` xmlns:P="${xml(namespace)}"`;
  if (content === undefined) {
    yield `<${qualified}${attributes}/>`;
    return;
  }
  yield `<${qualified}${attributes}>`;
  if (typeof content === "string") yield content;
  else yield* content;
  yield `</${qualified}>`;
}

export function activeLockXml(lock: FileSystemLock, style: FileSystemInfo["pathStyle"]): string {
  const seconds = Math.max(0, Math.ceil((lock.expiresAt - Date.now()) / 1_000));
  return `<D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:${lock.scope}/></D:lockscope>`
    + `<D:depth>${lock.depth}</D:depth><D:owner>${xml(lock.owner)}</D:owner>`
    + `<D:timeout>Second-${String(seconds)}</D:timeout><D:locktoken><D:href>${xml(lock.token)}</D:href></D:locktoken>`
    + `<D:lockroot><D:href>${xml(davHref(lock.path, "file", style))}</D:href></D:lockroot></D:activelock>`;
}

function locksFor(entry: FileSystemEntry, locks: FileSystemLock[], style: FileSystemInfo["pathStyle"]): FileSystemLock[] {
  const normalize = (path: string) => style === "windows" ? path.replaceAll("\\", "/").toLowerCase() : path;
  const path = normalize(entry.path);
  return locks.filter((lock) => {
    const root = normalize(lock.path);
    return root === path || (lock.depth === "infinity" && path.startsWith(root.endsWith("/") ? root : `${root}/`));
  });
}

function* lockDiscoveryXml(
  entry: FileSystemEntry, locks: FileSystemLock[], style: FileSystemInfo["pathStyle"],
): Generator<string, void, unknown> {
  for (const lock of locksFor(entry, locks, style)) yield activeLockXml(lock, style);
}

function liveProperty(
  name: string, entry: FileSystemEntry,
  { locks, style, readOnly }: { locks: FileSystemLock[]; style: FileSystemInfo["pathStyle"]; readOnly: boolean },
): string | Iterable<string> | undefined {
  switch (name) {
    case "displayname": return xml(entry.name || "/");
    case "resourcetype": return entry.kind === "directory" ? "<D:collection/>" : "";
    case "getcontentlength": return String(entry.kind === "file" ? entry.size : 0);
    case "getlastmodified": return new Date(entry.modifiedAtMs).toUTCString();
    case "getcontenttype": return entry.kind === "directory" ? "httpd/unix-directory" : "application/octet-stream";
    case "getetag": return xml(entry.etag);
    case "supportedlock": return readOnly ? "" : ["exclusive", "shared"].map((scope) => (
      `<D:lockentry><D:lockscope><D:${scope}/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>`
    )).join("");
    case "lockdiscovery": return lockDiscoveryXml(entry, locks, style);
    default: return undefined;
  }
}

interface PropertyRequest {
  namesOnly: boolean;
  properties: Array<{ namespace: string; name: string }>;
}

function requestedProperties(root: DavXmlNode | null): PropertyRequest {
  const defaults = LIVE_PROPERTIES.map((name) => ({ namespace: DAV_NAMESPACE, name }));
  if (!root) return { namesOnly: false, properties: defaults };
  if (!isDav(root, "propfind")) throw new DavError(400, "Expected DAV propfind.");
  const selectors = root.children.filter((node) => ["allprop", "propname", "prop"].some((name) => isDav(node, name)));
  if (selectors.length !== 1) throw new DavError(400, "Expected one DAV property selector.");
  const selected = selectors[0]!;
  const properties = isDav(selected, "prop")
    ? selected.children.map(({ namespace, name }) => ({ namespace, name })) : defaults;
  const included = root.children.find((node) => isDav(node, "include"));
  if (included && isDav(selected, "allprop")) {
    properties.push(...included.children.map(({ namespace, name }) => ({ namespace, name })));
  }
  return { namesOnly: isDav(selected, "propname"), properties };
}

function* propertyStatus(properties: Array<Iterable<string>>, status: string): Generator<string, void, unknown> {
  if (!properties.length) return;
  yield "<D:propstat><D:prop>";
  for (const property of properties) yield* property;
  yield `</D:prop><D:status>HTTP/1.1 ${status}</D:status></D:propstat>`;
}

export function propfindResponse(
  root: DavXmlNode | null,
  { entries, locks, style, readOnly }: {
    entries: FileSystemEntry[]; locks: FileSystemLock[]; style: FileSystemInfo["pathStyle"]; readOnly: boolean;
  },
): Response {
  const requested = requestedProperties(root);
  function* responses(): Generator<string, void, unknown> {
    yield '<D:multistatus xmlns:D="DAV:">';
    for (const entry of entries) {
      const found: Array<Iterable<string>> = [];
      const missing: Array<Iterable<string>> = [];
      for (const property of requested.properties) {
        const content = property.namespace === DAV_NAMESPACE ? liveProperty(property.name, entry, { locks, style, readOnly }) : undefined;
        if (content === undefined) missing.push(propertyTag(property.namespace, property.name));
        else found.push(propertyTag(property.namespace, property.name, requested.namesOnly ? undefined : content));
      }
      yield `<D:response><D:href>${xml(davHref(entry.path, entry.kind, style))}</D:href>`;
      yield* propertyStatus(found, "200 OK");
      yield* propertyStatus(missing, "404 Not Found");
      yield "</D:response>";
    }
    yield "</D:multistatus>";
  }
  return xmlResponse(responses());
}

export function proppatchResponse(root: DavXmlNode | null, href: string): Response {
  if (!root || !isDav(root, "propertyupdate")) throw new DavError(400, "Expected DAV propertyupdate.");
  const properties: Array<Iterable<string>> = [];
  for (const change of root.children) {
    if (!isDav(change, "set") && !isDav(change, "remove")) throw new DavError(400, "Invalid property update.");
    for (const prop of change.children) {
      if (!isDav(prop, "prop")) throw new DavError(400, "Expected DAV prop.");
      properties.push(...prop.children.map((node) => propertyTag(node.namespace, node.name)));
    }
  }
  if (!properties.length) throw new DavError(400, "No DAV properties supplied.");
  function* response(): Generator<string, void, unknown> {
    yield `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${xml(href)}</D:href>`;
    yield* propertyStatus(properties, "403 Forbidden");
    yield "</D:response></D:multistatus>";
  }
  return xmlResponse(response());
}
