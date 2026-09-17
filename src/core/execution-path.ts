/**
 * Explicit path semantics for execution hosts.
 */

import { posix, win32 } from "node:path";

export type ExecutionPathStyle = "posix" | "windows";

export class ExecutionPathError extends Error {
  readonly code: "invalid_root" | "invalid_path" | "outside_root";

  constructor(
    code: ExecutionPathError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ExecutionPathError";
    this.code = code;
  }
}

function pathApi(style: ExecutionPathStyle): typeof posix {
  return style === "windows" ? win32 : posix;
}

function normalizePathValue(
  value: string,
  style: ExecutionPathStyle,
): string {
  const api = pathApi(style);
  const normalized = api.normalize(value);
  const trailingSeparators = style === "windows" ? /[\\/]+$/ : /\/+$/;
  return normalized === api.parse(normalized).root
    ? normalized
    : normalized.replace(trailingSeparators, "");
}

function isWindowsDevicePath(value: string): boolean {
  const normalized = value.replace(/\//g, "\\").toLowerCase();
  return normalized.startsWith("\\\\?\\") || normalized.startsWith("\\\\.\\");
}

function hasWindowsReservedPathComponent(value: string): boolean {
  const root = win32.parse(value).root;
  return value
    .slice(root.length)
    .split(/[\\/]+/)
    .some((component) => {
      const baseName = component.split(".", 1)[0]?.replace(/[ .]+$/g, "") ?? "";
      return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i
        .test(baseName);
    });
}

function hasUnstableWindowsPathComponent(value: string): boolean {
  const root = win32.parse(value).root;
  return value
    .slice(root.length)
    .split(/[\\/]+/)
    .some((component) => (
      component !== "."
      && component !== ".."
      && (component.endsWith(" ") || component.endsWith("."))
    ));
}

function assertSupportedWindowsPath(
  value: string,
  code: "invalid_root" | "invalid_path",
  label: string,
): void {
  if (
    isWindowsDevicePath(value)
    || /^[a-z]:(?![\\/])/i.test(value)
    || value.slice(win32.parse(value).root.length).includes(":")
    || hasWindowsReservedPathComponent(value)
    || hasUnstableWindowsPathComponent(value)
  ) {
    throw new ExecutionPathError(
      code,
      `${label} uses an unsupported Windows path form.`,
    );
  }
}

function assertPathValue(value: string, label: string): string {
  if (!value.trim() || value.includes("\0")) {
    throw new ExecutionPathError(
      "invalid_path",
      `${label} must not be empty or contain NUL bytes.`,
    );
  }
  return value;
}

export function executionPathStyleForPlatform(
  platform: string,
): ExecutionPathStyle | null {
  if (platform === "win32" || platform === "windows") {
    return "windows";
  }
  if (platform === "linux" || platform === "darwin") {
    return "posix";
  }
  return null;
}

export function normalizeExecutionRoot(
  root: string,
  style: ExecutionPathStyle,
): string {
  const value = assertPathValue(root, "Execution root");
  if (style === "windows") {
    assertSupportedWindowsPath(value, "invalid_root", "Execution root");
  }
  const api = pathApi(style);
  if (!api.isAbsolute(value)) {
    throw new ExecutionPathError(
      "invalid_root",
      "The execution root must be absolute.",
    );
  }
  return api.resolve(value);
}

export function isExecutionPathWithinRoot(
  root: string,
  candidate: string,
  style: ExecutionPathStyle,
): boolean {
  const api = pathApi(style);
  const relative = api.relative(root, candidate);
  return relative === ""
    || (relative !== ".."
      && !relative.startsWith(`..${api.sep}`)
      && !api.isAbsolute(relative));
}

export function resolveExecutionPath(
  root: string,
  requested: string,
  style: ExecutionPathStyle,
): string {
  const normalizedRoot = normalizeExecutionRoot(root, style);
  const value = assertPathValue(requested, "Requested path");
  if (style === "windows") {
    assertSupportedWindowsPath(value, "invalid_path", "Requested path");
  }
  const api = pathApi(style);
  const resolved = api.resolve(normalizedRoot, value);
  if (!isExecutionPathWithinRoot(normalizedRoot, resolved, style)) {
    throw new ExecutionPathError(
      "outside_root",
      "Requested path must stay within the execution root.",
    );
  }
  return resolved;
}

export function resolveExecutionPathUnscoped(
  root: string,
  requested: string,
  style: ExecutionPathStyle,
): string {
  const normalizedRoot = normalizeExecutionRoot(root, style);
  const value = assertPathValue(requested, "Requested path");
  if (style === "windows") {
    assertSupportedWindowsPath(value, "invalid_path", "Requested path");
  }
  return pathApi(style).resolve(normalizedRoot, value);
}

export function resolveExecutionPathFromDirectory(
  directory: string,
  requested: string,
  style: ExecutionPathStyle,
): string {
  const normalizedDirectory = normalizeExecutionPath(directory, style);
  const normalizedRequested = normalizeExecutionPath(requested, style);
  const api = pathApi(style);
  return api.isAbsolute(normalizedRequested)
    ? normalizedRequested
    : normalizePathValue(
        api.join(normalizedDirectory, normalizedRequested),
        style,
      );
}

export function resolveExecutionPathWithinDirectory(
  directory: string,
  requested: string,
  style: ExecutionPathStyle,
): string {
  const normalizedDirectory = normalizeExecutionPath(directory, style);
  const resolved = resolveExecutionPathFromDirectory(
    normalizedDirectory,
    requested,
    style,
  );
  if (!isExecutionPathWithinRoot(normalizedDirectory, resolved, style)) {
    throw new ExecutionPathError(
      "outside_root",
      "Requested path must stay within the execution directory.",
    );
  }
  return resolved;
}

export function executionPathsEqual(
  left: string,
  right: string,
  style: ExecutionPathStyle,
): boolean {
  const normalizedLeft = normalizePathValue(left, style);
  const normalizedRight = normalizePathValue(right, style);
  return style === "windows"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function normalizeExecutionPath(
  path: string,
  style: ExecutionPathStyle,
): string {
  const value = assertPathValue(path, "Path");
  if (style === "windows") {
    assertSupportedWindowsPath(value, "invalid_path", "Path");
  }
  return normalizePathValue(value, style);
}

export function joinExecutionPath(
  style: ExecutionPathStyle,
  ...parts: string[]
): string {
  return pathApi(style).join(...parts);
}

export function isAbsoluteExecutionPath(
  path: string,
  style: ExecutionPathStyle,
): boolean {
  return pathApi(style).isAbsolute(path);
}

export function dirnameExecutionPath(
  path: string,
  style: ExecutionPathStyle,
): string {
  return pathApi(style).dirname(path);
}

export function basenameExecutionPath(
  path: string,
  style: ExecutionPathStyle,
): string {
  return pathApi(style).basename(path);
}

export function relativeExecutionPath(
  from: string,
  to: string,
  style: ExecutionPathStyle,
): string {
  return pathApi(style).relative(from, to);
}
