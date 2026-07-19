import { Children, cloneElement, isValidElement, useMemo, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import { getFileExplorerFileMetadataApi } from "../../hooks/workspaceFileActions";
import type { TranscriptFileLinkContext, TranscriptFileLinkTarget } from "./types";

const log = createLogger("transcript-file-links");

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
  const windowsDrivePrefix = normalizedValue.match(/^[A-Za-z]:/)?.[0];
  if (windowsDrivePrefix && lastSlashIndex === windowsDrivePrefix.length) {
    return `${windowsDrivePrefix}/`;
  }
  return normalizedValue.slice(0, lastSlashIndex);
}

function parentDirectory(value: string): string {
  const normalizedValue = normalizePath(value);
  const directory = dirname(normalizedValue);
  if (directory) {
    return directory;
  }
  if (normalizedValue.startsWith("/")) {
    return "/";
  }
  const windowsDrivePrefix = normalizedValue.match(/^[A-Za-z]:/)?.[0];
  return windowsDrivePrefix ? `${windowsDrivePrefix}/` : "";
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

function hasAbsolutePathShape(value: string): boolean {
  if (!isAbsolutePath(value) || value.endsWith("/")) {
    return false;
  }
  const segments = value.split("/").filter(Boolean);
  return segments.length >= 2;
}

export function looksLikeFileLinkCandidate(value: string): boolean {
  const trimmedValue = value.trim();
  if (
    !trimmedValue
    || trimmedValue.length > 260
    || trimmedValue.includes("://")
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

  if (isAbsolutePath(normalizedValue)) {
    return hasAbsolutePathShape(normalizedValue);
  }

  if (normalizedValue.includes("/")) {
    return hasFileNameShape(normalizedValue);
  }

  return hasFileNameShape(normalizedValue);
}

function resolveCandidateTarget(candidate: string, context: TranscriptFileLinkContext): TranscriptFileLinkTarget | null {
  if (!looksLikeFileLinkCandidate(candidate)) {
    return null;
  }

  const normalizedRoot = normalizePath(context.rootDirectory);
  const normalizedCandidate = normalizePath(candidate);
  if (normalizedCandidate === "." || normalizedCandidate === "/" || normalizedCandidate.endsWith("/")) {
    return null;
  }

  if (isAbsolutePath(normalizedCandidate)) {
    const isDirectoryShapedCandidate = !hasFileNameShape(normalizedCandidate);
    if (normalizedCandidate === normalizedRoot) {
      return null;
    }
    if (isDirectoryShapedCandidate) {
      return {
        kind: "directory",
        path: ".",
        startDirectory: normalizedCandidate,
      };
    }
    const absoluteRelativePath = relativePath(normalizedRoot, normalizedCandidate);
    if (
      absoluteRelativePath === "."
      || absoluteRelativePath.startsWith("../")
      || absoluteRelativePath === ".."
      || dirname(absoluteRelativePath).startsWith("../")
    ) {
      const outsideRootDirectory = parentDirectory(normalizedCandidate);
      const outsideRootFileName = basename(normalizedCandidate);
      if (
        !outsideRootDirectory
        || outsideRootFileName === "."
        || outsideRootFileName === ".."
      ) {
        return null;
      }
      return {
        kind: "file",
        path: outsideRootFileName,
        startDirectory: outsideRootDirectory,
      };
    }
    return {
      kind: "file",
      path: absoluteRelativePath,
      startDirectory: normalizedRoot,
    };
  }

  if (normalizedCandidate.startsWith("../") || normalizedCandidate === "..") {
    return null;
  }

  return {
    kind: "file",
    path: normalizedCandidate,
    startDirectory: normalizedRoot,
  };
}

async function validateFileLinkTarget(
  target: TranscriptFileLinkTarget,
  context: TranscriptFileLinkContext,
): Promise<TranscriptFileLinkTarget> {
  const response = await getFileExplorerFileMetadataApi(
    context.fileExplorerTarget,
    target.path,
    { startDirectory: target.startDirectory },
  );
  if (response.file.kind === "directory") {
    return {
      kind: "directory",
      path: ".",
      startDirectory: response.file.absolutePath,
    };
  }
  return {
    kind: "file",
    path: response.file.path,
    startDirectory: target.startDirectory,
  };
}

function getInlineCodeClassName(className?: string): string {
  return [
    "break-all rounded bg-gray-100 px-1.5 py-0.5 font-mono text-sm text-gray-900 dark:bg-neutral-800 dark:text-gray-100",
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
}

function shouldHandleInlineFileLinkClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented
    && event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey
  );
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
  const target = useMemo(() => {
    if (!fileLinkContext) {
      return null;
    }
    return resolveCandidateTarget(textContent, fileLinkContext);
  }, [fileLinkContext, textContent]);

  if (!target || !fileLinkContext) {
    return <code className={getInlineCodeClassName(className)}>{children}</code>;
  }

  const href = fileLinkContext.getFileHref(target);

  return (
    <TranscriptPathLink target={target} fileLinkContext={fileLinkContext} href={href}>
      <code className={getInlineCodeClassName(className)}>{children}</code>
    </TranscriptPathLink>
  );
}

function getTargetDisplayPath(target: TranscriptFileLinkTarget): string {
  return target.kind === "directory" ? target.startDirectory : target.path;
}

function TranscriptPathLink({
  children,
  target,
  fileLinkContext,
  href,
}: {
  children: ReactNode;
  target: TranscriptFileLinkTarget;
  fileLinkContext: TranscriptFileLinkContext;
  href: string;
}) {
  return (
    <a
      href={href}
      onClick={(event) => {
        if (!shouldHandleInlineFileLinkClick(event)) {
          return;
        }
        event.preventDefault();
        void validateFileLinkTarget(target, fileLinkContext)
          .then((validatedTarget) => fileLinkContext.openFile(validatedTarget))
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            const fallbackMessage = message || `Could not open "${getTargetDisplayPath(target)}".`;
            if (fileLinkContext.onFileOpenError) {
              fileLinkContext.onFileOpenError(fallbackMessage);
              return;
            }
            log.warn(fallbackMessage);
          });
      }}
      className="inline underline decoration-dotted underline-offset-2 hover:decoration-solid"
      data-file-link-path={getTargetDisplayPath(target)}
    >
      {children}
    </a>
  );
}

function trimTrailingPathPunctuation(value: string): { candidate: string; trailing: string } {
  let candidate = value;
  let trailing = "";

  while (candidate.length > 0) {
    const lastCharacter = candidate[candidate.length - 1];
    if (lastCharacter && /[.,;:!?]/.test(lastCharacter)) {
      candidate = candidate.slice(0, -1);
      trailing = `${lastCharacter}${trailing}`;
      continue;
    }
    if (
      (lastCharacter === ")" && candidate.split(")").length > candidate.split("(").length)
      || (lastCharacter === "]" && candidate.split("]").length > candidate.split("[").length)
      || (lastCharacter === "}" && candidate.split("}").length > candidate.split("{").length)
    ) {
      candidate = candidate.slice(0, -1);
      trailing = `${lastCharacter}${trailing}`;
      continue;
    }
    break;
  }

  return { candidate, trailing };
}

function splitPlainTextPathParts(content: string, fileLinkContext?: TranscriptFileLinkContext): ReactNode[] {
  if (!fileLinkContext) {
    return [content];
  }

  const result: ReactNode[] = [];
  const absolutePathPattern = /(^|[\s([{<])((?:\/|[A-Za-z]:\/)[^\s`<>"'|;&$]+)/g;
  let currentIndex = 0;

  for (const match of content.matchAll(absolutePathPattern)) {
    const [fullMatch, prefix = "", rawCandidate = ""] = match;
    const matchIndex = match.index ?? 0;
    const candidateStartIndex = matchIndex + prefix.length;
    const { candidate, trailing } = trimTrailingPathPunctuation(rawCandidate);
    const target = resolveCandidateTarget(candidate, fileLinkContext);

    if (!target) {
      continue;
    }

    if (candidateStartIndex > currentIndex) {
      result.push(content.slice(currentIndex, candidateStartIndex));
    }

    const href = fileLinkContext.getFileHref(target);
    result.push(
      <TranscriptPathLink
        key={`path-${candidateStartIndex}-${candidate}`}
        target={target}
        fileLinkContext={fileLinkContext}
        href={href}
      >
        {candidate}
      </TranscriptPathLink>,
    );

    if (trailing) {
      result.push(trailing);
    }

    currentIndex = matchIndex + fullMatch.length;
  }

  if (currentIndex < content.length) {
    result.push(content.slice(currentIndex));
  }

  return result.length > 0 ? result : [content];
}

export function TranscriptInlineTextContent({
  content,
  fileLinkContext,
}: {
  content: string;
  fileLinkContext?: TranscriptFileLinkContext;
}) {
  const parts = useMemo(() => splitPlainTextPathParts(content, fileLinkContext), [content, fileLinkContext]);
  return <>{parts}</>;
}

export function renderTranscriptTextNodes(children: ReactNode, fileLinkContext?: TranscriptFileLinkContext): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <TranscriptInlineTextContent content={child} fileLinkContext={fileLinkContext} />;
    }
    if (!isValidElement(child)) {
      return child;
    }
    if (child.type === "a" || child.type === "code" || child.type === "pre" || child.type === TranscriptInlineCode) {
      return child;
    }
    const props = child.props as { children?: ReactNode };
    if (props.children === undefined) {
      return child;
    }
    return cloneElement(child as ReactElement<{ children?: ReactNode }>, {
      children: renderTranscriptTextNodes(props.children, fileLinkContext),
    });
  });
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
          : <TranscriptInlineTextContent key={`text-${index}`} content={part.value} fileLinkContext={fileLinkContext} />
      ))}
    </div>
  );
}
