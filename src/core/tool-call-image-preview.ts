import { createHash } from "node:crypto";
import { basename } from "node:path";
import { backendManager } from "./backend/backend-manager";
import { quoteShell } from "./remote-executor/utils";
import type { ToolCallExtra } from "@/shared/tool-call";
import { MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES, type MessageImageAttachment } from "@/shared/message-attachments";
import { detectBrowserImageMimeType } from "../utils/workspace-file-images";

const VIEW_ALLOWED_INPUT_KEYS = new Set(["path", "filePath", "view_range", "forceReadLargeFiles"]);
const READ_ALLOWED_INPUT_KEYS = new Set(["path", "filePath", "view_range", "forceReadLargeFiles", "offset", "limit", "encoding"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isViewRange(value: unknown): value is [number, number] {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === "number"
    && typeof value[1] === "number";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasOnlyAllowedKeys(input: Record<string, unknown>, allowedKeys: Set<string>): boolean {
  return Object.keys(input).every((key) => allowedKeys.has(key));
}

function getFileTargetPath(input: Record<string, unknown>): string | null {
  const path = input["path"];
  if (typeof path === "string" && path.length > 0) {
    return path;
  }

  const filePath = input["filePath"];
  if (typeof filePath === "string" && filePath.length > 0) {
    return filePath;
  }

  return null;
}

function hasValidImagePreviewInput(toolName: string, input: Record<string, unknown>): boolean {
  const allowedKeys = toolName === "view" ? VIEW_ALLOWED_INPUT_KEYS : READ_ALLOWED_INPUT_KEYS;
  if (!hasOnlyAllowedKeys(input, allowedKeys)) {
    return false;
  }

  if (getFileTargetPath(input) === null) {
    return false;
  }

  const range = input["view_range"];
  if (range !== undefined && !isViewRange(range)) {
    return false;
  }

  const forceReadLargeFiles = input["forceReadLargeFiles"];
  if (forceReadLargeFiles !== undefined && typeof forceReadLargeFiles !== "boolean") {
    return false;
  }

  if (toolName === "read") {
    const offset = input["offset"];
    if (offset !== undefined && !isFiniteNumber(offset)) {
      return false;
    }

    const limit = input["limit"];
    if (limit !== undefined && !isFiniteNumber(limit)) {
      return false;
    }

    const encoding = input["encoding"];
    if (encoding !== undefined && typeof encoding !== "string") {
      return false;
    }
  }

  return true;
}

function createStablePreviewToken(toolCallId: string, path: string): string {
  return createHash("sha256")
    .update(toolCallId)
    .update("\0")
    .update(path)
    .digest("hex")
    .slice(0, 24);
}

export function getImageViewToolPath(toolName: string, input: unknown): string | null {
  const normalizedToolName = toolName.trim().toLowerCase();
  if (normalizedToolName !== "view" && normalizedToolName !== "read") {
    return null;
  }
  if (!isRecord(input) || !hasValidImagePreviewInput(normalizedToolName, input)) {
    return null;
  }
  return getFileTargetPath(input);
}

function createImagePreviewExtra(
  toolCallId: string,
  path: string,
  mimeType: string,
  data: string,
  size: number,
): ToolCallExtra {
  const previewToken = createStablePreviewToken(toolCallId, path);
  const attachment: MessageImageAttachment = {
    id: `tool-image-${previewToken}`,
    filename: basename(path) || "image",
    mimeType,
    data,
    size,
  };

  return {
    id: `tool-extra-${previewToken}`,
    type: "image_preview",
    image: attachment,
    sourcePath: path,
  };
}

interface ResolveToolCallImagePreviewOptions {
  workspaceId: string;
  directory: string;
  path: string;
  toolCallId: string;
}

export async function resolveToolCallImagePreview(
  options: ResolveToolCallImagePreviewOptions,
): Promise<ToolCallExtra | null> {
  const executor = await backendManager.getCommandExecutorAsync(options.workspaceId, options.directory);
  const result = await executor.exec("bash", [
    "-lc",
    [
      `path=${quoteShell(options.path)}`,
      "if [ ! -f \"$path\" ]; then",
      "  printf '%s\\n' '__NOT_FILE__'",
      "  exit 0",
      "fi",
      "size=$(wc -c < \"$path\" | tr -d '[:space:]')",
      `if [ \"$size\" -gt ${MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES} ]; then`,
      "  printf '%s\\n' '__TOO_LARGE__'",
      "  printf '%s\\n' \"$size\"",
      "  exit 0",
      "fi",
      "printf '%s\\n' '__OK__'",
      "printf '%s\\n' \"$size\"",
      "base64 < \"$path\" | tr -d '\\n'",
    ].join("\n"),
  ], {
    cwd: options.directory,
    timeout: 15_000,
    logFailures: false,
  });

  if (!result.success || !result.stdout) {
    return null;
  }

  const [status, sizeLine, ...base64Lines] = result.stdout.split("\n");
  if (status !== "__OK__") {
    return null;
  }

  const size = Number.parseInt(sizeLine ?? "", 10);
  if (!Number.isFinite(size) || size <= 0 || size > MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES) {
    return null;
  }

  const data = base64Lines.join("");
  if (!data) {
    return null;
  }

  const mimeType = detectBrowserImageMimeType(Buffer.from(data, "base64"));
  if (!mimeType) {
    return null;
  }

  return createImagePreviewExtra(options.toolCallId, options.path, mimeType, data, size);
}
