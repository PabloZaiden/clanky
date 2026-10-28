/**
 * Workspace icon discovery, validation, and private persistence.
 */

// The CommonJS entry lets Bun embed the grammar JSON in standalone binaries.
import cssTree = require("css-tree");
import ipaddr = require("ipaddr.js");
import { SaxesParser, type SaxesTagPlain } from "saxes";
import { Buffer } from "node:buffer";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import pngToIco from "png-to-ico";
import { PNG, type PNGWithMetadata } from "pngjs";
import type {
  Workspace,
  WorkspaceIconMetadata,
  WorkspaceIconMimeType,
} from "@/shared/workspace";
import type { WorkspaceIconCandidate } from "@/contracts/schemas";
import { DomainError } from "../domain/domain-error";
import { deleteWorkspaceIcon, getWorkspaceIcon, saveWorkspaceIcon } from "../persistence/workspaces";
import { backendManager } from "./backend-manager";
import { joinExecutionPath } from "./execution-path";
import type { CommandExecutor, CommandResult } from "./command-executor";

export interface WorkspaceIconContent {
  content: Uint8Array;
  mimeType: WorkspaceIconMimeType;
}

export interface WorkspaceIconCandidateContent {
  content: Uint8Array;
  mimeType: WorkspaceIconCandidate["mimeType"];
}

export interface WorkspaceIconCandidateList {
  candidates: WorkspaceIconCandidate[];
  truncated: boolean;
}

export const WORKSPACE_ICON_MAX_BYTES = 1024 * 1024;

const MAX_CANDIDATES = 200;
const MAX_CANDIDATE_LIST_BYTES = 2 * 1024 * 1024;
const MAX_PNG_DIMENSION = 8192;
const MAX_PNG_PIXELS = 4_194_304;
const PNG_ICON_CANVAS_SIZE = 256;
const WORKSPACE_ICON_URL_TIMEOUT_MS = 5_000;
const WORKSPACE_ICON_URL_MAX_REDIRECTS = 3;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export const WORKSPACE_ICON_MULTIPART_BODY_LIMIT = WORKSPACE_ICON_MAX_BYTES + 32 * 1024;

const SAFE_SVG_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "pattern",
  "symbol",
  "use",
  "title",
  "desc",
]);

const OMITTED_SVG_ELEMENTS = new Set(["metadata", "sodipodi:namedview"]);

const SAFE_SVG_PRESENTATION_ATTRIBUTES = new Set([
  "color",
  "display",
  "visibility",
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "stop-color",
  "stop-opacity",
  "clip-rule",
]);

const SAFE_SVG_ATTRIBUTES = new Set([
  "id",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x1",
  "y1",
  "x2",
  "y2",
  "d",
  "points",
  ...SAFE_SVG_PRESENTATION_ATTRIBUTES,
  "transform",
  "preserveAspectRatio",
  "offset",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "href",
]);

const LOCAL_SVG_URL = /^url\s*\(\s*(["']?)#[A-Za-z_][\w.-]*\1\s*\)$/i;
const INVALID_ICON_MESSAGE = "The selected file is not a safe, valid SVG, PNG, or ICO image.";

function invalidIcon(cause?: unknown): DomainError {
  return new DomainError(
    "workspace_icon_invalid",
    INVALID_ICON_MESSAGE,
    cause === undefined ? {} : { cause },
  );
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function isSafeSvgStyleValue(value: string): boolean {
  return /^[a-z\d\s#.,%+-]+$/i.test(value)
    || /^(?:rgb|rgba|hsl|hsla)\([a-z\d\s.,%+/-]+\)$/i.test(value)
    || LOCAL_SVG_URL.test(value);
}

function svgStyleAttributes(style: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const importantAttributes = new Set<string>();
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    const name = declaration.slice(0, separator).trim().toLowerCase();
    if (separator < 0 || !SAFE_SVG_PRESENTATION_ATTRIBUTES.has(name)) {
      continue;
    }
    const rawValue = declaration.slice(separator + 1).trim();
    const important = /\s*!important$/i.test(rawValue);
    const value = rawValue.replace(/\s*!important$/i, "").trim();
    if (!value) {
      continue;
    }
    if (!isSafeSvgStyleValue(value)) {
      throw new Error("SVG contains an unsupported presentation style.");
    }
    if (!cssTree.lexer.matchProperty(name, value).matched) {
      continue;
    }
    if (important || !importantAttributes.has(name)) {
      attributes.set(name, value);
    }
    if (important) {
      importantAttributes.add(name);
    }
  }
  return attributes;
}

function svgAttributes(tag: SaxesTagPlain): string[] {
  const attributes = new Map<string, string>();
  for (const [name, value] of Object.entries(tag.attributes)) {
    if (name === "xmlns") {
      if (tag.name !== "svg" || value !== SVG_NAMESPACE) {
        throw new Error("SVG namespace is unsupported.");
      }
    } else if (SAFE_SVG_ATTRIBUTES.has(name)) {
      attributes.set(name, value);
    }
  }
  for (const [name, value] of svgStyleAttributes(tag.attributes["style"] ?? "")) {
    attributes.set(name, value);
  }

  const serialized: string[] = [];
  for (const [name, value] of attributes) {
    if (
      /(?:javascript|vbscript|data):/i.test(value)
      || [...value.matchAll(/url\s*\([^)]*\)?/gi)].some(
        ([reference]) => !LOCAL_SVG_URL.test(reference),
      )
    ) {
      throw new Error("SVG contains an external or active reference.");
    }
    if (name === "href" && !/^#[A-Za-z_][\w.-]*$/.test(value)) {
      throw new Error("SVG references must be local.");
    }
    if (name === "id" && !/^[A-Za-z_][\w.-]*$/.test(value)) {
      throw new Error("SVG id is invalid.");
    }
    serialized.push(`${name}="${escapeXmlAttribute(value)}"`);
  }
  if (tag.name === "svg") {
    serialized.unshift(`xmlns="${SVG_NAMESPACE}"`);
  }
  return serialized;
}

function sanitizeSvg(content: Uint8Array): Uint8Array {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw invalidIcon(error);
  }
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(source)) {
    throw invalidIcon();
  }

  const parser = new SaxesParser();
  const output: string[] = [];
  const stack: string[] = [];
  let omittedDepth = 0;
  let rootSeen = false;
  let nodeCount = 0;
  let parseError: unknown;

  parser.on("error", (error) => {
    parseError ??= error;
  });
  parser.on("doctype", () => {
    parseError ??= new Error("SVG documents must not declare a document type.");
  });
  parser.on("opentag", (tag) => {
    if (parseError) {
      return;
    }
    nodeCount++;
    if (nodeCount > 10_000 || stack.length >= 32) {
      parseError = new Error("SVG contains unsupported or excessive markup.");
      return;
    }
    if (stack.length === 0) {
      if (rootSeen || tag.name !== "svg") {
        parseError = new Error("SVG must have one root svg element.");
        return;
      }
      rootSeen = true;
    }

    // Omitted editor subtrees still count toward the depth and element limits.
    if (omittedDepth > 0 || OMITTED_SVG_ELEMENTS.has(tag.name)) {
      omittedDepth++;
      stack.push(tag.name);
      return;
    }
    if (!SAFE_SVG_ELEMENTS.has(tag.name) || tag.name.includes(":")) {
      parseError = new Error("SVG contains unsupported markup.");
      return;
    }
    const attributes = svgAttributes(tag);
    output.push(`<${tag.name}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`);
    stack.push(tag.name);
  });
  parser.on("text", (text) => {
    const parent = stack.at(-1);
    if (omittedDepth === 0 && (parent === "title" || parent === "desc")) {
      output.push(escapeXmlText(text));
    }
  });
  parser.on("cdata", (text) => {
    const parent = stack.at(-1);
    if (omittedDepth === 0 && (parent === "title" || parent === "desc")) {
      output.push(escapeXmlText(text));
    }
  });
  parser.on("closetag", (tag) => {
    if (parseError) {
      return;
    }
    if (stack.pop() !== tag.name) {
      parseError = new Error("SVG element nesting is invalid.");
      return;
    }
    if (omittedDepth > 0) {
      omittedDepth--;
      return;
    }
    output.push(`</${tag.name}>`);
  });

  try {
    parser.write(source).close();
  } catch (error) {
    parseError ??= error;
  }
  if (parseError || !rootSeen || stack.length !== 0) {
    throw invalidIcon(parseError ?? new Error("SVG document is incomplete."));
  }
  return new TextEncoder().encode(output.join(""));
}

function validateIco(content: Uint8Array): Uint8Array {
  if (content.byteLength < 22) {
    throw invalidIcon();
  }
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const reserved = view.getUint16(0, true);
  const type = view.getUint16(2, true);
  const count = view.getUint16(4, true);
  const directoryEnd = 6 + count * 16;
  if (reserved !== 0 || type !== 1 || count < 1 || count > 256 || directoryEnd > content.byteLength) {
    throw invalidIcon();
  }

  for (let index = 0; index < count; index++) {
    const entryOffset = 6 + index * 16;
    const imageLength = view.getUint32(entryOffset + 8, true);
    const imageOffset = view.getUint32(entryOffset + 12, true);
    const imageEnd = imageOffset + imageLength;
    if (
      imageLength < 8
      || imageOffset < directoryEnd
      || imageEnd > content.byteLength
    ) {
      throw invalidIcon();
    }
    const png = imageLength >= 8
      && content[imageOffset] === 0x89
      && content[imageOffset + 1] === 0x50
      && content[imageOffset + 2] === 0x4e
      && content[imageOffset + 3] === 0x47
      && content[imageOffset + 4] === 0x0d
      && content[imageOffset + 5] === 0x0a
      && content[imageOffset + 6] === 0x1a
      && content[imageOffset + 7] === 0x0a;
    if (png) {
      const ihdr = String.fromCharCode(
        content[imageOffset + 12] ?? 0,
        content[imageOffset + 13] ?? 0,
        content[imageOffset + 14] ?? 0,
        content[imageOffset + 15] ?? 0,
      );
      if (
        imageLength < 33
        || view.getUint32(imageOffset + 8, false) !== 13
        || ihdr !== "IHDR"
        || view.getUint32(imageOffset + 16, false) === 0
        || view.getUint32(imageOffset + 20, false) === 0
      ) {
        throw invalidIcon();
      }
      continue;
    }
    const bitmapHeaderSize = view.getUint32(imageOffset, true);
    if (
      bitmapHeaderSize === 12
        ? imageLength <= bitmapHeaderSize
        : bitmapHeaderSize < 40
          || bitmapHeaderSize >= imageLength
          || view.getUint32(imageOffset + 20, true) > imageLength - bitmapHeaderSize
    ) {
      throw invalidIcon();
    }
  }
  return new Uint8Array(content);
}

function validateIconContent(
  content: Uint8Array,
  mimeType: WorkspaceIconMimeType,
): Uint8Array {
  if (content.byteLength === 0 || content.byteLength > WORKSPACE_ICON_MAX_BYTES) {
    throw new DomainError(
      "workspace_icon_too_large",
      "Workspace icons must be 1 MB or smaller.",
    );
  }
  return mimeType === "image/svg+xml"
    ? sanitizeSvg(content)
    : validateIco(content);
}

function decodePng(content: Uint8Array): PNGWithMetadata {
  if (content.byteLength === 0 || content.byteLength > WORKSPACE_ICON_MAX_BYTES) {
    throw new DomainError(
      "workspace_icon_too_large",
      "Workspace icons must be 1 MB or smaller.",
    );
  }
  if (content.byteLength < 33) {
    throw invalidIcon();
  }
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    signature.some((byte, index) => content[index] !== byte)
    || view.getUint32(8, false) !== 13
    || String.fromCharCode(content[12]!, content[13]!, content[14]!, content[15]!) !== "IHDR"
    || view.getUint32(16, false) === 0
    || view.getUint32(20, false) === 0
  ) {
    throw invalidIcon();
  }
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (
    width > MAX_PNG_DIMENSION
    || height > MAX_PNG_DIMENSION
    || width * height > MAX_PNG_PIXELS
  ) {
    throw new DomainError(
      "workspace_icon_too_large",
      "PNG dimensions exceed the supported workspace icon limits.",
    );
  }
  try {
    const png = PNG.sync.read(Buffer.from(content), { checkCRC: true });
    if (png.width !== width || png.height !== height) {
      throw invalidIcon();
    }
    return png;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw invalidIcon(error);
  }
}

function fitPngToSquare(source: PNGWithMetadata): Buffer {
  const output = new PNG({
    width: PNG_ICON_CANVAS_SIZE,
    height: PNG_ICON_CANVAS_SIZE,
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true,
  });
  const scale = Math.min(
    PNG_ICON_CANVAS_SIZE / source.width,
    PNG_ICON_CANVAS_SIZE / source.height,
  );
  const drawWidth = Math.max(1, Math.round(source.width * scale));
  const drawHeight = Math.max(1, Math.round(source.height * scale));
  const offsetX = Math.floor((PNG_ICON_CANVAS_SIZE - drawWidth) / 2);
  const offsetY = Math.floor((PNG_ICON_CANVAS_SIZE - drawHeight) / 2);

  for (let y = 0; y < drawHeight; y++) {
    const sourceY = Math.max(
      0,
      Math.min(source.height - 1, (y + 0.5) * source.height / drawHeight - 0.5),
    );
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const weightY = sourceY - y0;
    for (let x = 0; x < drawWidth; x++) {
      const sourceX = Math.max(
        0,
        Math.min(source.width - 1, (x + 0.5) * source.width / drawWidth - 0.5),
      );
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const weightX = sourceX - x0;
      const weights = [
        (1 - weightX) * (1 - weightY),
        weightX * (1 - weightY),
        (1 - weightX) * weightY,
        weightX * weightY,
      ];
      const sourceOffsets = [
        (y0 * source.width + x0) * 4,
        (y0 * source.width + x1) * 4,
        (y1 * source.width + x0) * 4,
        (y1 * source.width + x1) * 4,
      ];
      const destinationOffset = (
        (offsetY + y) * PNG_ICON_CANVAS_SIZE + offsetX + x
      ) * 4;
      let alpha = 0;
      for (let index = 0; index < weights.length; index++) {
        alpha += weights[index]! * source.data[sourceOffsets[index]! + 3]! / 255;
      }
      for (let channel = 0; channel < 3; channel++) {
        let premultiplied = 0;
        for (let index = 0; index < weights.length; index++) {
          const pixelOffset = sourceOffsets[index]!;
          premultiplied += weights[index]!
            * source.data[pixelOffset + channel]!
            * source.data[pixelOffset + 3]!
            / 255;
        }
        output.data[destinationOffset + channel] = alpha === 0
          ? 0
          : Math.round(premultiplied / alpha);
      }
      output.data[destinationOffset + 3] = Math.round(alpha * 255);
    }
  }
  return PNG.sync.write(output);
}

async function normalizePngToIco(content: Uint8Array): Promise<Uint8Array> {
  const png = decodePng(content);
  try {
    const ico = await pngToIco(fitPngToSquare(png));
    return validateIco(new Uint8Array(ico));
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw invalidIcon(error);
  }
}

function validatePngCandidate(content: Uint8Array): Uint8Array {
  decodePng(content);
  return new Uint8Array(content);
}

function getCandidateMimeType(path: string): WorkspaceIconCandidate["mimeType"] | null {
  const filename = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (filename.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (filename.endsWith(".ico")) {
    return "image/x-icon";
  }
  if (filename.endsWith(".png")) {
    return "image/png";
  }
  return null;
}

function normalizeCandidatePath(path: string): string {
  const normalizedPath = tryNormalizeCandidatePath(path);
  if (normalizedPath === null) {
    throw invalidIcon();
  }
  return normalizedPath;
}

function tryNormalizeCandidatePath(path: string): string | null {
  const segments = path.split("/");
  const filename = segments[segments.length - 1] ?? "";
  if (
    path.length > 2048
    || filename.length > 255
    || path.startsWith("/")
    || path.includes("\\")
    || /^[A-Za-z]:/.test(path)
    || /[\u0000-\u001f]/.test(path)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
    || !getCandidateMimeType(path)
  ) {
    return null;
  }
  return path;
}

function isExpectedMeshExecutionAbort(error: unknown): boolean {
  return error instanceof DomainError
    && error.code === "mesh_execution_aborted"
    && error.cause === undefined;
}

async function getWorkspaceExecutor(workspace: Workspace): Promise<CommandExecutor> {
  return await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = (): void => {
    void reader.cancel().catch(() => {
      // Cancellation is best-effort; the request abort remains authoritative.
    });
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("The workspace icon read was aborted.", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > WORKSPACE_ICON_MAX_BYTES) {
        void reader.cancel().catch(() => {
          // Keep the size violation as the authoritative error.
        });
        throw new DomainError(
          "workspace_icon_too_large",
          "Workspace icons must be 1 MB or smaller.",
        );
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }

  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

async function readCandidate(
  workspace: Workspace,
  path: string,
  signal?: AbortSignal,
): Promise<WorkspaceIconCandidateContent> {
  const relativePath = normalizeCandidatePath(path);
  const mimeType = getCandidateMimeType(relativePath)!;
  const executor = await getWorkspaceExecutor(workspace);
  const sourcePath = joinExecutionPath(
    executor.pathStyle,
    workspace.directory,
    ...relativePath.split("/"),
  );
  const stream = await executor.streamFile(sourcePath, { signal });
  if (!stream) {
    throw new DomainError(
      "workspace_icon_candidate_not_found",
      "The selected workspace icon candidate is unavailable.",
    );
  }
  const content = await readBoundedStream(stream, signal);
  return {
    mimeType,
    content: mimeType === "image/png"
      ? validatePngCandidate(content)
      : validateIconContent(content, mimeType),
  };
}

function workspaceIconUrlError(
  code: string,
  message: string,
  cause?: unknown,
): DomainError {
  return new DomainError(code, message, { cause });
}

function parseWorkspaceIconUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw workspaceIconUrlError(
      "workspace_icon_url_invalid",
      "Enter a valid public HTTP(S) URL for an SVG, PNG, or ICO icon.",
      error,
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || url.href.length > 2_048
  ) {
    throw workspaceIconUrlError(
      "workspace_icon_url_invalid",
      "Enter a valid public HTTP(S) URL for an SVG, PNG, or ICO icon.",
    );
  }
  url.hash = "";
  return url;
}

function normalizeUrlHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isPublicIpAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) {
    return false;
  }
  const parsedAddress = ipaddr.process(address);
  if (
    parsedAddress.kind() === "ipv6"
    && parsedAddress.toByteArray().slice(0, 12).every((byte) => byte === 0)
  ) {
    return false;
  }
  return parsedAddress.range() === "unicast";
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return !normalized.includes(".")
    || normalized === "localhost"
    || [".localhost", ".local", ".internal", ".test", ".example", ".invalid"]
      .some((suffix) => normalized.endsWith(suffix));
}

function waitForAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted.", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function resolvePublicAddress(url: URL, signal: AbortSignal): Promise<LookupAddress> {
  const hostname = normalizeUrlHostname(url.hostname);
  if (ipaddr.isValid(hostname)) {
    const parsedAddress = ipaddr.process(hostname);
    if (!isPublicIpAddress(hostname)) {
      throw workspaceIconUrlError(
        "workspace_icon_url_blocked",
        "The icon URL must point to a public internet host.",
      );
    }
    return {
      address: parsedAddress.toString(),
      family: parsedAddress.kind() === "ipv4" ? 4 : 6,
    };
  }
  if (isBlockedHostname(hostname)) {
    throw workspaceIconUrlError(
      "workspace_icon_url_blocked",
      "The icon URL must point to a public internet host.",
    );
  }

  let addresses: LookupAddress[];
  try {
    addresses = await waitForAbortable(
      dnsLookup(hostname, { all: true, verbatim: true }),
      signal,
    );
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    throw workspaceIconUrlError(
      "workspace_icon_url_fetch_failed",
      "Unable to resolve the icon URL host.",
      error,
    );
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw workspaceIconUrlError(
      "workspace_icon_url_blocked",
      "The icon URL must point to a public internet host.",
    );
  }
  return addresses[0]!;
}

function requestWorkspaceIconUrl(
  url: URL,
  address: LookupAddress,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<IncomingMessage> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted.", "AbortError"));
  }

  const pinnedLookup: NonNullable<RequestOptions["lookup"]> = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [address]);
    } else {
      callback(null, address.address, address.family);
    }
  };
  const requestOptions: RequestOptions = {
    hostname: normalizeUrlHostname(url.hostname),
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: {
      accept: "image/svg+xml,image/png,image/x-icon,image/vnd.microsoft.icon,application/octet-stream",
      "accept-encoding": "identity",
    },
    agent: false,
    lookup: pinnedLookup,
  };

  return new Promise((resolve, reject) => {
    let response: IncomingMessage | undefined;
    const onResponse = (incomingResponse: IncomingMessage): void => {
      response = incomingResponse;
      incomingResponse.once("close", removeAbortListener);
      incomingResponse.once("end", removeAbortListener);
      resolve(incomingResponse);
    };
    const request = url.protocol === "https:"
      ? httpsRequest(requestOptions, onResponse)
      : httpRequest(requestOptions, onResponse);
    const onAbort = (): void => {
      const reason = signal.reason;
      const error = reason instanceof Error ? reason : new DOMException("Aborted.", "AbortError");
      request.destroy(error);
      response?.destroy(error);
    };
    const removeAbortListener = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    request.once("error", (error) => {
      removeAbortListener();
      reject(error);
    });
    if (signal.aborted) {
      onAbort();
    }
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Icon URL request timed out."));
    });
    request.end();
  });
}

function getResponseHeader(response: IncomingMessage, name: string): string | undefined {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(",") : value;
}

function getWorkspaceIconUrlMimeType(
  url: URL,
  contentType: string | undefined,
  content: Uint8Array,
): WorkspaceIconCandidate["mimeType"] {
  const declaredType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (declaredType === "image/svg+xml") {
    return "image/svg+xml";
  }
  if (declaredType === "image/png") {
    return "image/png";
  }
  if (declaredType === "image/x-icon" || declaredType === "image/vnd.microsoft.icon") {
    return "image/x-icon";
  }
  const genericTypes = new Set([
    "",
    "application/octet-stream",
    "binary/octet-stream",
    "application/xml",
    "text/plain",
    "text/xml",
  ]);
  if (declaredType && !genericTypes.has(declaredType)) {
    throw invalidIcon();
  }

  const extensionMimeType = getCandidateMimeType(url.pathname);
  if (extensionMimeType) {
    return extensionMimeType;
  }
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngSignature.every((byte, index) => content[index] === byte)) {
    return "image/png";
  }
  if (content[0] === 0 && content[1] === 0 && content[2] === 1 && content[3] === 0) {
    return "image/x-icon";
  }
  const prefix = new TextDecoder().decode(content.subarray(0, 4_096)).replace(/^\uFEFF/, "");
  if (
    /^(?:\s*<\?xml[^?]*\?>)?\s*(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(prefix)
  ) {
    return "image/svg+xml";
  }
  throw invalidIcon();
}

async function readWorkspaceIconUrlResponse(
  response: IncomingMessage,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentEncoding = getResponseHeader(response, "content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    response.destroy();
    throw invalidIcon();
  }
  const contentLength = getResponseHeader(response, "content-length");
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) {
      response.destroy();
      throw invalidIcon();
    }
    if (Number(contentLength) > WORKSPACE_ICON_MAX_BYTES) {
      response.destroy();
      throw new DomainError(
        "workspace_icon_too_large",
        "Workspace icons must be 1 MB or smaller.",
      );
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    if (signal.aborted) {
      response.destroy();
      throw signal.reason ?? new DOMException("Aborted.", "AbortError");
    }
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > WORKSPACE_ICON_MAX_BYTES) {
      response.destroy();
      throw new DomainError(
        "workspace_icon_too_large",
        "Workspace icons must be 1 MB or smaller.",
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

export async function fetchWorkspaceIconFromUrl(
  value: string,
  requestSignal?: AbortSignal,
): Promise<WorkspaceIconCandidateContent> {
  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  const abortForRequest = (): void => controller.abort(requestSignal?.reason);
  if (requestSignal?.aborted) {
    abortForRequest();
  } else {
    requestSignal?.addEventListener("abort", abortForRequest, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Timed out.", "TimeoutError"));
  }, WORKSPACE_ICON_URL_TIMEOUT_MS);

  try {
    let url = parseWorkspaceIconUrl(value);
    for (let redirectCount = 0; redirectCount <= WORKSPACE_ICON_URL_MAX_REDIRECTS; redirectCount++) {
      const address = await resolvePublicAddress(url, controller.signal);
      const remainingTimeout = Math.max(
        1,
        WORKSPACE_ICON_URL_TIMEOUT_MS - (Date.now() - startedAt),
      );
      const response = await requestWorkspaceIconUrl(
        url,
        address,
        controller.signal,
        remainingTimeout,
      );
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = getResponseHeader(response, "location");
        response.destroy();
        if (!location || redirectCount === WORKSPACE_ICON_URL_MAX_REDIRECTS) {
          throw workspaceIconUrlError(
            "workspace_icon_url_fetch_failed",
            "Unable to retrieve an icon from the supplied URL.",
          );
        }
        try {
          url = parseWorkspaceIconUrl(new URL(location, url).href);
        } catch (error) {
          if (error instanceof DomainError) {
            throw error;
          }
          throw workspaceIconUrlError(
            "workspace_icon_url_invalid",
            "The icon URL redirected to an invalid address.",
            error,
          );
        }
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        throw workspaceIconUrlError(
          "workspace_icon_url_fetch_failed",
          "Unable to retrieve an icon from the supplied URL.",
        );
      }

      const content = await readWorkspaceIconUrlResponse(response, controller.signal);
      const mimeType = getWorkspaceIconUrlMimeType(
        url,
        getResponseHeader(response, "content-type"),
        content,
      );
      return {
        mimeType,
        content: mimeType === "image/png"
          ? validatePngCandidate(content)
          : validateIconContent(content, mimeType),
      };
    }
    throw workspaceIconUrlError(
      "workspace_icon_url_fetch_failed",
      "Unable to retrieve an icon from the supplied URL.",
    );
  } catch (error) {
    if (requestSignal?.aborted) {
      throw requestSignal.reason ?? error;
    }
    if (timedOut) {
      throw workspaceIconUrlError(
        "workspace_icon_url_fetch_failed",
        "The icon URL request timed out.",
        error,
      );
    }
    if (error instanceof DomainError) {
      throw error;
    }
    throw workspaceIconUrlError(
      "workspace_icon_url_fetch_failed",
      "Unable to retrieve an icon from the supplied URL.",
      error,
    );
  } finally {
    clearTimeout(timeout);
    requestSignal?.removeEventListener("abort", abortForRequest);
  }
}

export async function listWorkspaceIconCandidates(
  workspace: Workspace,
  signal?: AbortSignal,
): Promise<WorkspaceIconCandidateList> {
  if (workspace.workspaceType !== "git") {
    throw new DomainError(
      "workspace_git_required",
      "Icon discovery requires a Git workspace.",
    );
  }

  const executor = await getWorkspaceExecutor(workspace);
  const repositoryCheck = await executor.exec(
    "git",
    ["-C", workspace.directory, "rev-parse", "--is-inside-work-tree"],
    { timeout: 5_000, signal, logFailures: false },
  );
  if (!repositoryCheck.success || repositoryCheck.stdout.trim() !== "true") {
    throw new DomainError("not_git_repo", "The workspace directory is not a Git repository.");
  }

  const paths: Array<{ path: string; mimeType: WorkspaceIconCandidate["mimeType"] }> = [];
  const seenPaths = new Set<string>();
  const executionController = new AbortController();
  const abortForRequest = (): void => {
    executionController.abort(signal?.reason);
  };
  if (signal?.aborted) {
    abortForRequest();
  } else {
    signal?.addEventListener("abort", abortForRequest, { once: true });
  }
  let pendingPath = "";
  let truncated = false;
  let result: CommandResult | undefined;

  const addCandidate = (path: string): void => {
    const normalizedPath = tryNormalizeCandidatePath(path);
    if (!normalizedPath || seenPaths.has(normalizedPath)) {
      return;
    }
    const mimeType = getCandidateMimeType(normalizedPath);
    if (!mimeType) {
      return;
    }
    seenPaths.add(normalizedPath);
    paths.push({ path: normalizedPath, mimeType });
    if (paths.length > MAX_CANDIDATES) {
      truncated = true;
      executionController.abort();
    }
  };

  try {
    result = await executor.exec(
      "git",
      [
        "-C",
        workspace.directory,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ":(icase,glob)**/*.svg",
        ":(icase,glob)**/*.ico",
        ":(icase,glob)**/*.png",
      ],
      {
        timeout: 5_000,
        signal: executionController.signal,
        maxOutputBytes: MAX_CANDIDATE_LIST_BYTES,
        longRunning: true,
        logFailures: false,
        onStdoutChunk: (chunk) => {
          if (truncated) {
            return;
          }
          let chunkOffset = 0;
          while (chunkOffset < chunk.length) {
            const delimiterOffset = chunk.indexOf("\0", chunkOffset);
            if (delimiterOffset < 0) {
              pendingPath += chunk.slice(chunkOffset);
              return;
            }
            addCandidate(pendingPath + chunk.slice(chunkOffset, delimiterOffset));
            pendingPath = "";
            if (truncated) {
              return;
            }
            chunkOffset = delimiterOffset + 1;
          }
        },
      },
    );
  } catch (error) {
    if (!truncated || signal?.aborted || !isExpectedMeshExecutionAbort(error)) {
      throw error;
    }
  } finally {
    signal?.removeEventListener("abort", abortForRequest);
  }

  const expectedLocalAbort = result?.exitCode === 130
    && !result.stderr.includes("Process-tree cleanup failed:");
  if (
    signal?.aborted
    || (!truncated && !result?.success)
    || (truncated && result && !result.success && !expectedLocalAbort)
  ) {
    throw new DomainError(
      "workspace_icon_discovery_failed",
      "Cannot discover workspace icons on the selected execution host.",
    );
  }

  const candidates = paths
    .slice(0, MAX_CANDIDATES)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path, mimeType }) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      mimeType,
    }));
  return { candidates, truncated };
}

export async function previewWorkspaceIconCandidate(
  workspace: Workspace,
  path: string,
  signal?: AbortSignal,
): Promise<WorkspaceIconCandidateContent> {
  return await readCandidate(workspace, path, signal);
}

export async function selectWorkspaceIconCandidate(
  workspace: Workspace,
  path: string,
  signal?: AbortSignal,
): Promise<WorkspaceIconMetadata> {
  const candidate = await readCandidate(workspace, path, signal);
  const content = candidate.mimeType === "image/png"
    ? await normalizePngToIco(candidate.content)
    : candidate.content;
  const mimeType = candidate.mimeType === "image/png" ? "image/x-icon" : candidate.mimeType;
  return await saveWorkspaceIcon(workspace.id, mimeType, content);
}

export async function uploadWorkspaceIcon(
  workspace: Workspace,
  filename: string,
  declaredMimeType: string,
  content: Uint8Array,
): Promise<WorkspaceIconMetadata> {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const mimeType: WorkspaceIconCandidate["mimeType"] | null = extension === ".svg"
    ? "image/svg+xml"
    : extension === ".ico"
      ? "image/x-icon"
      : extension === ".png"
        ? "image/png"
        : null;
  if (
    !mimeType
    || (
      declaredMimeType
      && declaredMimeType !== mimeType
      && !(mimeType === "image/x-icon" && declaredMimeType === "image/vnd.microsoft.icon")
    )
  ) {
    throw invalidIcon();
  }
  const safeContent = mimeType === "image/png"
    ? await normalizePngToIco(content)
    : validateIconContent(content, mimeType);
  const savedMimeType = mimeType === "image/png" ? "image/x-icon" : mimeType;
  return await saveWorkspaceIcon(workspace.id, savedMimeType, safeContent);
}

export async function getWorkspaceIconContent(
  workspaceId: string,
): Promise<WorkspaceIconContent | null> {
  const stored = await getWorkspaceIcon(workspaceId);
  if (!stored) {
    return null;
  }
  return {
    mimeType: stored.mimeType,
    content: validateIconContent(stored.content, stored.mimeType),
  };
}

export async function removeWorkspaceIcon(workspaceId: string): Promise<void> {
  await deleteWorkspaceIcon(workspaceId);
}
