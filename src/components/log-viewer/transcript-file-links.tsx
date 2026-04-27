import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getFileExplorerFileMetadataApi } from "../../hooks/workspaceFileActions";
import type { TranscriptFileLinkContext } from "./types";

const EXTENSIONLESS_FILE_NAME_SET = new Set([
  "Brewfile",
  "Dockerfile",
  "Gemfile",
  "Jenkinsfile",
  "LICENSE",
  "Makefile",
  "Procfile",
  "README",
  "Rakefile",
  "Vagrantfile",
]);

type FileLinkResolution =
  | { status: "plain" }
  | { status: "checking" }
  | { status: "resolved"; path: string }
  | { status: "missing" };

interface CacheEntry {
  result: FileLinkResolution;
  promise?: Promise<FileLinkResolution>;
}

const transcriptFileLinkCache = new Map<string, CacheEntry>();

function normalizeSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

function collapseSlashes(value: string): string {
  return value.replace(/\/{2,}/g, "/");
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value);
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

function normalizePath(value: string): string {
  const normalizedValue = collapseSlashes(normalizeSeparators(value.trim()));
  const windowsDrivePrefix = normalizedValue.match(/^[A-Za-z]:/)?.[0] ?? "";
  const hasWindowsDrivePrefix = windowsDrivePrefix.length > 0;
  const isAbsolute = normalizedValue.startsWith("/") || hasWindowsDrivePrefix;
  const pathWithoutPrefix = hasWindowsDrivePrefix ? normalizedValue.slice(windowsDrivePrefix.length) : normalizedValue;
  const segments = pathWithoutPrefix.split("/");
  const resolvedSegments: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      const previousSegment = resolvedSegments[resolvedSegments.length - 1];
      if (previousSegment && previousSegment !== "..") {
        resolvedSegments.pop();
        continue;
      }
      if (!isAbsolute) {
        resolvedSegments.push(segment);
      }
      continue;
    }
    resolvedSegments.push(segment);
  }

  const joinedSegments = resolvedSegments.join("/");
  if (hasWindowsDrivePrefix) {
    return joinedSegments ? `${windowsDrivePrefix}/${joinedSegments}` : `${windowsDrivePrefix}/`;
  }
  if (isAbsolute) {
    return joinedSegments ? `/${joinedSegments}` : "/";
  }
  return joinedSegments || ".";
}

function dirname(value: string): string {
  const normalizedValue = normalizePath(value);
  if (normalizedValue === "." || normalizedValue === "/") {
    return "";
  }
  const lastSlashIndex = normalizedValue.lastIndexOf("/");
  if (lastSlashIndex < 0) {
    return "";
  }
  return normalizedValue.slice(0, lastSlashIndex);
}

function basename(value: string): string {
  const normalizedValue = normalizePath(value);
  if (normalizedValue === "." || normalizedValue === "/") {
    return normalizedValue;
  }
  const lastSlashIndex = normalizedValue.lastIndexOf("/");
  return lastSlashIndex >= 0 ? normalizedValue.slice(lastSlashIndex + 1) : normalizedValue;
}

function relativePath(from: string, to: string): string {
  const normalizedFrom = normalizePath(from);
  const normalizedTo = normalizePath(to);
  const fromSegments = normalizedFrom === "/" ? [] : normalizedFrom.split("/").filter(Boolean);
  const toSegments = normalizedTo === "/" ? [] : normalizedTo.split("/").filter(Boolean);
  const maxSharedLength = Math.min(fromSegments.length, toSegments.length);
  let sharedLength = 0;

  while (sharedLength < maxSharedLength && fromSegments[sharedLength] === toSegments[sharedLength]) {
    sharedLength += 1;
  }

  const upSegments = fromSegments.slice(sharedLength).map(() => "..");
  const downSegments = toSegments.slice(sharedLength);
  const relativeSegments = [...upSegments, ...downSegments];
  return relativeSegments.length > 0 ? relativeSegments.join("/") : ".";
}

function isSafePathCharacterString(value: string): boolean {
  return !/[<>"'|;&$]/.test(value);
}

function hasFileNameShape(value: string): boolean {
  const fileName = basename(value);
  if (!fileName || fileName === "." || fileName === ".." || fileName.includes(" ")) {
    return false;
  }
  if (fileName.startsWith(".") && fileName.length > 1) {
    return true;
  }
  if (EXTENSIONLESS_FILE_NAME_SET.has(fileName)) {
    return true;
  }
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 && dotIndex < fileName.length - 1;
}

export function looksLikeFileLinkCandidate(value: string): boolean {
  const trimmedValue = value.trim();
  if (
    !trimmedValue
    || trimmedValue.length > 260
    || trimmedValue.includes("\n")
    || trimmedValue.includes("\r")
    || trimmedValue.includes("`")
    || trimmedValue.startsWith("-")
    || !isSafePathCharacterString(trimmedValue)
  ) {
    return false;
  }

  const normalizedValue = normalizePath(trimmedValue);
  if (normalizedValue === "." || normalizedValue === "/" || normalizedValue.endsWith("/")) {
    return false;
  }

  if (normalizedValue.includes("/")) {
    return hasFileNameShape(normalizedValue);
  }

  return hasFileNameShape(normalizedValue);
}

function resolveCandidatePath(candidate: string, context: TranscriptFileLinkContext): string | null {
  if (!looksLikeFileLinkCandidate(candidate)) {
    return null;
  }

  const normalizedRoot = normalizePath(context.rootDirectory);
  const normalizedCandidate = normalizePath(candidate);
  if (normalizedCandidate === "." || normalizedCandidate === "/" || normalizedCandidate.endsWith("/")) {
    return null;
  }

  if (isAbsolutePath(normalizedCandidate)) {
    if (normalizedCandidate === normalizedRoot) {
      return null;
    }
    const absoluteRelativePath = relativePath(normalizedRoot, normalizedCandidate);
    if (
      absoluteRelativePath === "."
      || absoluteRelativePath.startsWith("../")
      || absoluteRelativePath === ".."
      || dirname(absoluteRelativePath).startsWith("../")
    ) {
      return null;
    }
    return absoluteRelativePath;
  }

  if (normalizedCandidate.startsWith("../") || normalizedCandidate === "..") {
    return null;
  }

  return normalizedCandidate;
}

function buildCacheKey(candidate: string, context: TranscriptFileLinkContext): string {
  const target = context.fileExplorerTarget;
  return [
    target.type,
    target.id,
    target.startDirectory ?? context.rootDirectory,
    candidate,
  ].join("::");
}

async function resolveFileLink(
  candidate: string,
  context: TranscriptFileLinkContext,
): Promise<FileLinkResolution> {
  const resolvedPath = resolveCandidatePath(candidate, context);
  if (!resolvedPath) {
    return { status: "plain" };
  }

  try {
    const response = await getFileExplorerFileMetadataApi(
      context.fileExplorerTarget,
      resolvedPath,
      { startDirectory: context.fileExplorerTarget.startDirectory ?? context.rootDirectory },
    );
    if (response.file.kind !== "file") {
      return { status: "missing" };
    }
    return { status: "resolved", path: response.file.path };
  } catch {
    return { status: "missing" };
  }
}

function getCachedResolution(candidate: string, context: TranscriptFileLinkContext): CacheEntry {
  const cacheKey = buildCacheKey(candidate, context);
  const cachedEntry = transcriptFileLinkCache.get(cacheKey);
  if (cachedEntry) {
    return cachedEntry;
  }

  const promise = resolveFileLink(candidate, context).then((result) => {
    transcriptFileLinkCache.set(cacheKey, { result });
    return result;
  });
  const nextEntry: CacheEntry = {
    result: { status: "checking" },
    promise,
  };
  transcriptFileLinkCache.set(cacheKey, nextEntry);
  return nextEntry;
}

function getInlineCodeClassName(className?: string): string {
  return [
    "break-all rounded bg-gray-100 px-1.5 py-0.5 font-mono text-sm dark:bg-neutral-800",
    className,
  ].filter(Boolean).join(" ");
}

function getTextContent(children: ReactNode): string {
  if (typeof children === "string") {
    return children;
  }
  if (typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map((child) => getTextContent(child)).join("");
  }
  return "";
}

export function resetTranscriptFileLinkCache(): void {
  transcriptFileLinkCache.clear();
}

export function TranscriptInlineCode({
  children,
  className,
  fileLinkContext,
}: {
  children: ReactNode;
  className?: string;
  fileLinkContext?: TranscriptFileLinkContext;
}) {
  const textContent = useMemo(() => getTextContent(children), [children]);
  const [resolution, setResolution] = useState<FileLinkResolution>(() => {
    if (!fileLinkContext) {
      return { status: "plain" };
    }
    return getCachedResolution(textContent, fileLinkContext).result;
  });

  useEffect(() => {
    if (!fileLinkContext) {
      setResolution({ status: "plain" });
      return;
    }

    const cachedEntry = getCachedResolution(textContent, fileLinkContext);
    setResolution(cachedEntry.result);

    if (!cachedEntry.promise) {
      return;
    }

    let cancelled = false;
    void cachedEntry.promise.then((result) => {
      if (!cancelled) {
        setResolution(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [fileLinkContext, textContent]);

  if (resolution.status !== "resolved" || !fileLinkContext) {
    return <code className={getInlineCodeClassName(className)}>{children}</code>;
  }

  const href = fileLinkContext.getFileHref(resolution.path);

  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        fileLinkContext.openFile(resolution.path);
      }}
      className="inline underline decoration-dotted underline-offset-2 hover:decoration-solid"
      data-file-link-path={resolution.path}
    >
      <code className={getInlineCodeClassName(className)}>{children}</code>
    </a>
  );
}

export function TranscriptTextContent({
  content,
  className,
  dimmed = false,
  fileLinkContext,
}: {
  content: string;
  className: string;
  dimmed?: boolean;
  fileLinkContext?: TranscriptFileLinkContext;
}) {
  const parts = useMemo(() => {
    const result: Array<{ type: "text" | "code"; value: string }> = [];
    const inlineCodePattern = /`([^`\n\r]+)`/g;
    let currentIndex = 0;

    for (const match of content.matchAll(inlineCodePattern)) {
      const [fullMatch, inlineCodeValue = ""] = match;
      const matchIndex = match.index ?? 0;
      if (matchIndex > currentIndex) {
        result.push({ type: "text", value: content.slice(currentIndex, matchIndex) });
      }
      result.push({ type: "code", value: inlineCodeValue });
      currentIndex = matchIndex + fullMatch.length;
    }

    if (currentIndex < content.length) {
      result.push({ type: "text", value: content.slice(currentIndex) });
    }

    return result;
  }, [content]);

  return (
    <div className={className} data-dimmed={dimmed ? "true" : "false"}>
      {parts.map((part, index) => (
        part.type === "code"
          ? <TranscriptInlineCode key={`code-${index}`} fileLinkContext={fileLinkContext}>{part.value}</TranscriptInlineCode>
          : <span key={`text-${index}`}>{part.value}</span>
      ))}
    </div>
  );
}
