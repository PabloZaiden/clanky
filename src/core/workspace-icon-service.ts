/**
 * Workspace icon discovery, validation, and private persistence.
 */

import { SaxesParser, type SaxesTagPlain } from "saxes";
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

export interface WorkspaceIconCandidateList {
  candidates: WorkspaceIconCandidate[];
  truncated: boolean;
}

export const WORKSPACE_ICON_MAX_BYTES = 1024 * 1024;

const MAX_CANDIDATES = 200;
const MAX_CANDIDATE_LIST_BYTES = 2 * 1024 * 1024;
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
const INVALID_ICON_MESSAGE = "The selected file is not a safe, valid SVG or ICO image.";

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
    if (!isSafeSvgStyleValue(value)) {
      throw new Error("SVG contains an unsupported presentation style.");
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

function getCandidateMimeType(path: string): WorkspaceIconMimeType | null {
  const filename = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (filename.endsWith(".svg") && (filename.includes("icon") || filename.includes("logo"))) {
    return "image/svg+xml";
  }
  if (
    filename.endsWith(".ico")
    && (
      filename.includes("icon")
      || filename.includes("logo")
      || filename.startsWith("favicon")
    )
  ) {
    return "image/x-icon";
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
): Promise<WorkspaceIconContent> {
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
    content: validateIconContent(content, mimeType),
  };
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

  const paths: Array<{ path: string; mimeType: WorkspaceIconMimeType }> = [];
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
        ":(icase,glob)**/*icon*.svg",
        ":(icase,glob)**/*logo*.svg",
        ":(icase,glob)**/*icon*.ico",
        ":(icase,glob)**/*logo*.ico",
        ":(icase,glob)**/favicon*.ico",
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
): Promise<WorkspaceIconContent> {
  return await readCandidate(workspace, path, signal);
}

export async function selectWorkspaceIconCandidate(
  workspace: Workspace,
  path: string,
  signal?: AbortSignal,
): Promise<WorkspaceIconMetadata> {
  const candidate = await readCandidate(workspace, path, signal);
  return await saveWorkspaceIcon(workspace.id, candidate.mimeType, candidate.content);
}

export async function uploadWorkspaceIcon(
  workspace: Workspace,
  filename: string,
  declaredMimeType: string,
  content: Uint8Array,
): Promise<WorkspaceIconMetadata> {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const mimeType: WorkspaceIconMimeType | null = extension === ".svg"
    ? "image/svg+xml"
    : extension === ".ico"
      ? "image/x-icon"
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
  const safeContent = validateIconContent(content, mimeType);
  return await saveWorkspaceIcon(workspace.id, mimeType, safeContent);
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
