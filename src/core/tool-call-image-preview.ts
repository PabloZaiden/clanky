import { basename } from "node:path";
import { backendManager } from "./backend/backend-manager";
import { quoteShell } from "./remote-executor/utils";
import type { ToolCallExtra } from "../types/tool-call";
import {
  MESSAGE_IMAGE_ALLOWED_MIME_TYPES,
  MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES,
  type MessageImageAttachment,
} from "../types/message-attachments";

const TOOL_CALL_IMAGE_PREVIEW_MAX_BYTES = Math.min(
  MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES,
  2 * 1024 * 1024,
);

const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>(MESSAGE_IMAGE_ALLOWED_MIME_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isViewRange(value: unknown): value is [number, number] {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === "number"
    && typeof value[1] === "number";
}

function hasOnlyViewKeys(input: Record<string, unknown>): boolean {
  return Object.keys(input).every((key) => (
    key === "path" || key === "view_range" || key === "forceReadLargeFiles"
  ));
}

export function getImageViewToolPath(toolName: string, input: unknown): string | null {
  const normalizedToolName = toolName.trim().toLowerCase();
  if (normalizedToolName !== "view" && normalizedToolName !== "read") {
    return null;
  }
  if (!isRecord(input) || !hasOnlyViewKeys(input)) {
    return null;
  }
  const path = input["path"];
  if (typeof path !== "string" || path.length === 0) {
    return null;
  }
  const range = input["view_range"];
  if (range !== undefined && !isViewRange(range)) {
    return null;
  }
  const forceReadLargeFiles = input["forceReadLargeFiles"];
  if (forceReadLargeFiles !== undefined && typeof forceReadLargeFiles !== "boolean") {
    return null;
  }
  return path;
}

function createImagePreviewExtra(path: string, mimeType: string, data: string, size: number): ToolCallExtra {
  const attachment: MessageImageAttachment = {
    id: `tool-image-${crypto.randomUUID()}`,
    filename: basename(path) || "image",
    mimeType,
    data,
    size,
  };

  return {
    id: `tool-extra-${crypto.randomUUID()}`,
    type: "image_preview",
    image: attachment,
    sourcePath: path,
  };
}

function detectImageMimeType(data: string): string | null {
  const bytes = Buffer.from(data, "base64");
  if (bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const header = bytes.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") {
      return "image/gif";
    }
  }
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

interface ResolveToolCallImagePreviewOptions {
  workspaceId: string;
  directory: string;
  path: string;
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
      `if [ \"$size\" -gt ${TOOL_CALL_IMAGE_PREVIEW_MAX_BYTES} ]; then`,
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
  if (!Number.isFinite(size) || size <= 0 || size > TOOL_CALL_IMAGE_PREVIEW_MAX_BYTES) {
    return null;
  }

  const data = base64Lines.join("");
  if (!data) {
    return null;
  }

  const mimeType = detectImageMimeType(data);
  if (!mimeType || !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    return null;
  }

  return createImagePreviewExtra(options.path, mimeType, data, size);
}
