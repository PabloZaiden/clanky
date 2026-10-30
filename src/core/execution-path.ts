/**
 * Explicit POSIX path semantics for execution hosts.
 */

import { posix } from "node:path";

export type ExecutionPathStyle = "posix";

export class ExecutionPathError extends Error {
  readonly code: "invalid_root" | "invalid_path" | "outside_root";

  constructor(code: ExecutionPathError["code"], message: string) {
    super(message);
    this.name = "ExecutionPathError";
    this.code = code;
  }
}

function normalizePathValue(value: string): string {
  const normalized = posix.normalize(value);
  return normalized === posix.parse(normalized).root
    ? normalized
    : normalized.replace(/\/+$/, "");
}

function assertPathValue(value: string, label: string): string {
  if (!value.trim() || value.includes("\0")) {
    throw new ExecutionPathError("invalid_path", `${label} must not be empty or contain NUL bytes.`);
  }
  return value;
}

export function executionPathStyleForPlatform(platform: string): ExecutionPathStyle | null {
  return platform === "linux" || platform === "darwin" ? "posix" : null;
}

export function inferExecutionPathStyle(path: string): ExecutionPathStyle | null {
  const value = path.trim();
  return value.startsWith("/") && !value.includes("\0") ? "posix" : null;
}

export function normalizeExecutionRoot(root: string, _style: ExecutionPathStyle): string {
  const value = assertPathValue(root, "Execution root");
  if (!posix.isAbsolute(value)) {
    throw new ExecutionPathError("invalid_root", "The execution root must be absolute.");
  }
  return posix.resolve(value);
}

export function isExecutionPathWithinRoot(root: string, candidate: string, _style: ExecutionPathStyle): boolean {
  const relative = posix.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative));
}

export function resolveExecutionPath(root: string, requested: string, style: ExecutionPathStyle): string {
  const resolved = resolveExecutionPathUnscoped(root, requested, style);
  if (!isExecutionPathWithinRoot(normalizeExecutionRoot(root, style), resolved, style)) {
    throw new ExecutionPathError("outside_root", "Requested path must stay within the execution root.");
  }
  return resolved;
}

export function resolveExecutionPathUnscoped(root: string, requested: string, style: ExecutionPathStyle): string {
  return posix.resolve(normalizeExecutionRoot(root, style), assertPathValue(requested, "Requested path"));
}

export function resolveExecutionPathFromDirectory(directory: string, requested: string, style: ExecutionPathStyle): string {
  const normalizedDirectory = normalizeExecutionPath(directory, style);
  const normalizedRequested = normalizeExecutionPath(requested, style);
  return posix.isAbsolute(normalizedRequested)
    ? normalizedRequested
    : normalizePathValue(posix.join(normalizedDirectory, normalizedRequested));
}

export function resolveExecutionPathWithinDirectory(directory: string, requested: string, style: ExecutionPathStyle): string {
  const normalizedDirectory = normalizeExecutionPath(directory, style);
  const resolved = resolveExecutionPathFromDirectory(normalizedDirectory, requested, style);
  if (!isExecutionPathWithinRoot(normalizedDirectory, resolved, style)) {
    throw new ExecutionPathError("outside_root", "Requested path must stay within the execution directory.");
  }
  return resolved;
}

export function executionPathsEqual(left: string, right: string, _style: ExecutionPathStyle): boolean {
  return normalizePathValue(left) === normalizePathValue(right);
}

export function normalizeExecutionPath(path: string, _style: ExecutionPathStyle): string {
  return normalizePathValue(assertPathValue(path, "Path"));
}

export function joinExecutionPath(_style: ExecutionPathStyle, ...parts: string[]): string {
  return posix.join(...parts);
}

export function isAbsoluteExecutionPath(path: string, _style: ExecutionPathStyle): boolean {
  return posix.isAbsolute(path);
}

export function dirnameExecutionPath(path: string, _style: ExecutionPathStyle): string {
  return posix.dirname(path);
}

export function basenameExecutionPath(path: string, _style: ExecutionPathStyle): string {
  return posix.basename(path);
}

export function relativeExecutionPath(from: string, to: string, _style: ExecutionPathStyle): string {
  return posix.relative(from, to);
}
