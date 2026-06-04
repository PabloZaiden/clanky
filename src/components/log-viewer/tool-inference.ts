import type { FileDiff, ToolCallData } from "../../types";
import { formatToolPathForDisplay } from "./tool-paths";

export type InferredToolKind =
  | "view"
  | "edit"
  | "glob"
  | "rg"
  | "apply_patch"
  | "bash"
  | "read_bash"
  | "write_bash"
  | "sql"
  | "github_mcp"
  | "web_fetch"
  | "todo"
  | "skill"
  | "rubber_duck"
  | "unknown";

export interface ToolMeta {
  /** Inferred tool kind derived from the raw persisted payload shape. */
  kind: InferredToolKind;
  /** Human-readable one-line summary of what the tool is doing. */
  summary: string;
  /** Label for the output section (e.g. "Output", "Result", "Done"). */
  outputLabel: string;
  /** Preferred output rendering mode. */
  outputType: "text" | "json";
}

export interface ToolMetaContext {
  pathDisplayRoot?: string;
}

export interface ToolDetailRow {
  label: string;
  value: string;
}

export interface ApplyPatchFileSection {
  path: string;
  oldPath?: string;
  status: FileDiff["status"];
  additions: number;
  deletions: number;
  patch?: string;
}

export type ToolDetailBlock =
  | { type: "rows"; title?: string; rows: ToolDetailRow[] }
  | { type: "text"; title?: string; content: string }
  | { type: "code"; title?: string; content: string }
  | { type: "patch"; title?: string; files: ApplyPatchFileSection[] }
  | { type: "list"; title?: string; items: string[] }
  | { type: "json"; title?: string; value: unknown };

export interface StructuredToolDetails {
  inputBlocks: ToolDetailBlock[];
  outputBlocks: ToolDetailBlock[];
}

const RG_STYLE_KEYS = [
  "output_mode",
  "glob",
  "head_limit",
  "paths",
  "-n",
  "-i",
  "-A",
  "-B",
  "-C",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getStringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function getNumberField(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

function getBooleanField(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

function hasOnlyKeys(input: Record<string, unknown>, allowedKeys: string[]): boolean {
  return Object.keys(input).every((key) => allowedKeys.includes(key));
}

function getPathField(input: Record<string, unknown>): string | undefined {
  return getStringField(input, "path");
}

function getFileTargetField(input: Record<string, unknown>): string | undefined {
  return getStringField(input, "path") ?? getStringField(input, "filePath");
}

function isViewRange(value: unknown): value is [number, number] {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === "number"
    && typeof value[1] === "number";
}

function getPathsField(input: Record<string, unknown>): string[] | undefined {
  const value = input["paths"];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return value;
}

function getParsedCommandRecords(input: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const value = input?.["parsed_cmd"];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function getParsedCommandPath(input: Record<string, unknown> | undefined): string | undefined {
  const command = getParsedCommandRecords(input).find((entry) => {
    const type = getStringField(entry, "type");
    return type === "read" || type === "list_files";
  });
  return command ? getStringField(command, "path") ?? getStringField(command, "name") : undefined;
}

function getStoredName(tool: ToolCallData): string | undefined {
  const name = tool.name.trim().replace(/^general tool:\s*/i, "");
  return name.length > 0 ? name : undefined;
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

function getStoredNameKind(tool: ToolCallData): InferredToolKind | undefined {
  const name = getStoredName(tool)?.toLowerCase();
  if (!name) {
    return undefined;
  }

  if (name === "read" || name === "view") {
    return "view";
  }

  if (name === "edit" || name === "write" || name === "multiedit") {
    return "edit";
  }

  if (name === "execute" || name === "bash" || name === "shell") {
    return "bash";
  }

  if (name === "grep" || name === "rg") {
    return "rg";
  }

  if (name === "glob" || name === "ls") {
    return "glob";
  }

  if (name === "fetch" || name === "webfetch") {
    return "web_fetch";
  }

  if (name === "todowrite") {
    return "todo";
  }

  if (name === "context7_resolve_library_id" || name === "context7_get_library_docs") {
    return "rg";
  }

  if (name === "search") {
    const textOutput = getTextFromOutput(tool.output);
    if (textOutput?.startsWith("Found ")) {
      return "rg";
    }
    return "glob";
  }

  return undefined;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatScalarValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function formatOptionalPath(path: string | undefined, context: ToolMetaContext): string | undefined {
  return path ? formatToolPathForDisplay(path, context.pathDisplayRoot) : undefined;
}

function formatOptionalPaths(paths: string[] | undefined, context: ToolMetaContext): string | undefined {
  if (!paths || paths.length === 0) {
    return undefined;
  }
  return paths.map((path) => formatToolPathForDisplay(path, context.pathDisplayRoot)).join(", ");
}

function appendRow(rows: ToolDetailRow[], label: string, value: string | undefined): void {
  if (!value) {
    return;
  }
  rows.push({ label, value });
}

function splitNonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function extractTaggedBlock(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\/${tag}>`, "m"));
  const value = match?.[1];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizePatchLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return value;
}

function countPatchLines(lines: string[]): Pick<FileDiff, "additions" | "deletions"> {
  return lines.reduce(
    (counts, line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        counts.additions += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        counts.deletions += 1;
      }
      return counts;
    },
    { additions: 0, deletions: 0 }
  );
}

function formatApplyPatchPathLabel(path: string, oldPath?: string): string {
  return oldPath ? `${oldPath} → ${path}` : path;
}

function dedupeApplyPatchFileLabels(labels: string[]): string[] {
  return Array.from(new Set(labels));
}

function parseApplyPatchFiles(input: string): string[] {
  const lines = normalizePatchLines(input);
  const files: string[] = [];
  let currentSourcePath: string | undefined;
  let currentMoveTo: string | undefined;

  function flushCurrent(): void {
    if (!currentSourcePath) {
      return;
    }
    files.push(formatApplyPatchPathLabel(currentMoveTo ?? currentSourcePath, currentMoveTo ? currentSourcePath : undefined));
    currentSourcePath = undefined;
    currentMoveTo = undefined;
  }

  for (const line of lines) {
    if (line === "*** Begin Patch" || line === "*** End Patch") {
      continue;
    }

    const fileMatch = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (fileMatch) {
      flushCurrent();
      const sourcePath = fileMatch[2]?.trim();
      if (sourcePath) {
        currentSourcePath = sourcePath;
      }
      continue;
    }

    if (!currentSourcePath) {
      continue;
    }

    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
    if (moveMatch) {
      const moveTo = moveMatch[1]?.trim();
      if (moveTo) {
        currentMoveTo = moveTo;
      }
    }
  }

  flushCurrent();
  return dedupeApplyPatchFileLabels(files);
}

interface ParsedApplyPatchDetails {
  sections: ApplyPatchFileSection[];
  fileLabels: string[];
}

function parseApplyPatchDetails(input: string): ParsedApplyPatchDetails {
  const lines = normalizePatchLines(input);
  const sections: ApplyPatchFileSection[] = [];
  const fileLabels: string[] = [];
  let current:
    | {
        sourcePath: string;
        moveTo?: string;
        status: Exclude<FileDiff["status"], "renamed">;
        lines: string[];
      }
    | undefined;

  function flushCurrent(): void {
    if (!current) {
      return;
    }

    const path = current.moveTo ?? current.sourcePath;
    const oldPath = current.moveTo ? current.sourcePath : undefined;
    fileLabels.push(formatApplyPatchPathLabel(path, oldPath));

    const counts = countPatchLines(current.lines);
    sections.push({
      path,
      oldPath,
      status: current.moveTo ? "renamed" : current.status,
      additions: counts.additions,
      deletions: counts.deletions,
      patch: current.lines.length > 0 ? current.lines.join("\n") : undefined,
    });
    current = undefined;
  }

  for (const line of lines) {
    if (line === "*** Begin Patch" || line === "*** End Patch") {
      continue;
    }

    const fileMatch = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (fileMatch) {
      flushCurrent();
      const operation = fileMatch[1];
      const sourcePath = fileMatch[2]?.trim();
      if (!sourcePath) {
        continue;
      }
      current = {
        sourcePath,
        status: operation === "Add" ? "added" : operation === "Delete" ? "deleted" : "modified",
        lines: [],
      };
      continue;
    }

    if (!current) {
      continue;
    }

    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
    if (moveMatch) {
      const moveTo = moveMatch[1]?.trim();
      if (moveTo) {
        current.moveTo = moveTo;
      }
      continue;
    }

    current.lines.push(line);
  }

  flushCurrent();
  return {
    sections,
    fileLabels: dedupeApplyPatchFileLabels(fileLabels),
  };
}

export function parseApplyPatchSections(input: string): ApplyPatchFileSection[] {
  return parseApplyPatchDetails(input).sections;
}

export function getTextFromOutput(output: unknown): string | undefined {
  if (typeof output === "string") {
    return output;
  }
  if (!isRecord(output)) {
    return undefined;
  }

  const content = output["content"];
  if (typeof content === "string") {
    return content;
  }

  const detailedContent = output["detailedContent"];
  if (typeof detailedContent === "string") {
    return detailedContent;
  }

  const rawOutput = output["output"];
  return typeof rawOutput === "string" ? rawOutput : undefined;
}

export function inferToolKind(tool: ToolCallData): InferredToolKind {
  const { input } = tool;

  if (typeof input === "string" && input.startsWith("*** Begin Patch")) {
    return "apply_patch";
  }

  if (!isRecord(input)) {
    return getStoredNameKind(tool) ?? "unknown";
  }

  if (isEmptyRecord(input)) {
    return getStoredNameKind(tool) ?? "unknown";
  }

  if (Array.isArray(input["todos"])) {
    return "todo";
  }

  if (getStringField(input, "agent_type") === "rubber-duck") {
    return "rubber_duck";
  }

  if (typeof input["patchText"] === "string" && input["patchText"].startsWith("*** Begin Patch")) {
    return "apply_patch";
  }

  if (isRecord(input["changes"])) {
    return "edit";
  }

  const shellId = getStringField(input, "shellId");
  const delay = getNumberField(input, "delay");

  if (shellId && delay !== undefined && typeof input["input"] === "string") {
    return "write_bash";
  }

  if (shellId && delay !== undefined && hasOnlyKeys(input, ["shellId", "delay"])) {
    return "read_bash";
  }

  if (typeof input["command"] === "string") {
    return "bash";
  }

  const parsedCommands = getParsedCommandRecords(input);
  if (parsedCommands.some((entry) => getStringField(entry, "type") === "read")) {
    return "view";
  }

  if (parsedCommands.some((entry) => getStringField(entry, "type") === "list_files")) {
    return "glob";
  }

  if (typeof input["url"] === "string") {
    return "web_fetch";
  }

  if (typeof input["skill"] === "string") {
    return "skill";
  }

  if (typeof input["description"] === "string" && typeof input["query"] === "string") {
    return "sql";
  }

  if (typeof input["method"] === "string" && typeof input["owner"] === "string" && typeof input["repo"] === "string") {
    return "github_mcp";
  }

  const fileTarget = getFileTargetField(input);
  if (fileTarget && isViewRange(input["view_range"])) {
    return "view";
  }

  if (fileTarget && typeof input["pattern"] !== "string") {
    return "view";
  }

  if (typeof input["pattern"] === "string") {
    const path = getPathField(input);
    const hasRgStyleKeys = RG_STYLE_KEYS.some((key) => key in input);
    if (hasRgStyleKeys) {
      return "rg";
    }

    if (hasOnlyKeys(input, ["pattern"]) || (path && hasOnlyKeys(input, ["pattern", "path"]))) {
      return "glob";
    }
  }

  return getStoredNameKind(tool) ?? "unknown";
}

export function getToolSummary(tool: ToolCallData, kind: InferredToolKind, context: ToolMetaContext = {}): string {
  const input = isRecord(tool.input) ? tool.input : undefined;

  switch (kind) {
    case "view": {
      const path = input ? getFileTargetField(input) ?? getParsedCommandPath(input) : undefined;
      const displayPath = path ? formatToolPathForDisplay(path, context.pathDisplayRoot) : undefined;
      const range = input?.["view_range"];
      if (displayPath && isViewRange(range)) {
        return `View ${displayPath}:${range[0]}-${range[1]}`;
      }
      return `View ${displayPath ?? "file"}`;
    }
    case "edit": {
      const changes = input && isRecord(input["changes"]) ? input["changes"] : undefined;
      const changedPaths = changes ? Object.keys(changes) : [];
      if (changedPaths.length === 1) {
        return `Edit ${formatToolPathForDisplay(changedPaths[0]!, context.pathDisplayRoot)}`;
      }
      if (changedPaths.length > 1) {
        return `Edit ${changedPaths.length} files`;
      }
      return "Edit files";
    }
    case "glob": {
      const pattern = input ? getStringField(input, "pattern") : undefined;
      const path = input ? getPathField(input) ?? getParsedCommandPath(input) : undefined;
      const displayPath = formatOptionalPath(path, context);
      if (!pattern) {
        return displayPath ? `List ${displayPath}` : "List files";
      }
      if (path && pattern) {
        return `Find files matching '${pattern}' in ${displayPath ?? path}`;
      }
      return `Find files matching '${pattern ?? ""}'`;
    }
    case "rg": {
      const pattern = input ? getStringField(input, "pattern") : undefined;
      const path = input ? getPathField(input) : undefined;
      const paths = input ? getPathsField(input) : undefined;
      const displayPath = formatOptionalPath(path, context);
      if (path && pattern) {
        return `Search for '${pattern}' in ${displayPath ?? path}`;
      }
      if (paths && pattern) {
        return `Search for '${pattern}' in ${paths.length} paths`;
      }
      return `Search for '${pattern ?? ""}'`;
    }
    case "apply_patch": {
      if (typeof tool.input !== "string") {
        return "Apply patch";
      }
      const files = parseApplyPatchFiles(tool.input);
      if (files.length === 1) {
        return `Patch ${files[0]}`;
      }
      if (files.length > 1) {
        return `Patch ${files.length} files`;
      }
      return "Apply patch";
    }
    case "bash": {
      const description = input ? getStringField(input, "description") : undefined;
      const command = input ? getStringField(input, "command") : undefined;
      return description ?? truncate(command ?? "Run command", 80);
    }
    case "read_bash":
      return `Read shell output (shell ${shellIdFromInput(input) ?? "unknown"})`;
    case "write_bash": {
      const shellId = shellIdFromInput(input) ?? "unknown";
      const rawInput = input ? getStringField(input, "input") : undefined;
      const preview = rawInput ? rawInput.trim() : "";
      if (preview.length > 0 && preview.length <= 20 && !/[\r\n\t]/.test(preview)) {
        return `Send input to shell ${shellId}: ${JSON.stringify(preview)}`;
      }
      return `Send input to shell ${shellId}`;
    }
    case "sql": {
      const description = input ? getStringField(input, "description") : undefined;
      return description ?? "SQL query";
    }
    case "github_mcp": {
      const repo = input ? getStringField(input, "repo") : undefined;
      const owner = input ? getStringField(input, "owner") : undefined;
      const method = input ? getStringField(input, "method") : undefined;
      const pullNumber = input?.["pullNumber"];
      if (repo && typeof pullNumber === "number" && method) {
        return `GitHub ${repo}#${pullNumber} ${method}`;
      }
      if (owner && repo && method) {
        return `GitHub ${owner}/${repo} ${method}`;
      }
      return "GitHub tool call";
    }
    case "web_fetch": {
      const url = input ? getStringField(input, "url") : undefined;
      return `Fetch ${url ?? "URL"}`;
    }
    case "todo": {
      const todos = input?.["todos"];
      if (Array.isArray(todos)) {
        return `Update todo list (${todos.length})`;
      }
      return "Update todo list";
    }
    case "skill": {
      const skill = input ? getStringField(input, "skill") : undefined;
      return `Load skill ${skill ?? "unknown"}`;
    }
    case "rubber_duck": {
      const description = input ? getStringField(input, "description") : undefined;
      const name = input ? getStringField(input, "name") : undefined;
      if (description) {
        return `Rubber duck: ${description}`;
      }
      if (name) {
        return `Rubber duck: ${name}`;
      }
      return "Rubber duck agent";
    }
    case "unknown": {
      const storedName = getStoredName(tool);
      return storedName ? `General tool: ${storedName}` : "Unknown tool";
    }
  }
}

function shellIdFromInput(input: Record<string, unknown> | undefined): string | undefined {
  return input ? getStringField(input, "shellId") : undefined;
}

export function getToolOutputType(tool: ToolCallData, kind: InferredToolKind): "text" | "json" {
  const textOutput = getTextFromOutput(tool.output);
  if (textOutput !== undefined) {
    if (kind === "unknown" && isValidJsonString(textOutput)) {
      return "json";
    }
    return "text";
  }

  switch (kind) {
    case "view":
    case "edit":
    case "glob":
    case "rg":
    case "apply_patch":
    case "bash":
    case "read_bash":
    case "write_bash":
    case "web_fetch":
    case "todo":
    case "skill":
    case "rubber_duck":
      return "text";
    case "sql":
    case "github_mcp":
    case "unknown":
      return "json";
  }
}

export function getToolMeta(tool: ToolCallData, context: ToolMetaContext = {}): ToolMeta {
  const kind = inferToolKind(tool);
  const outputLabel = kind === "sql" ? "Done" : kind === "view" || kind === "glob" || kind === "rg" || kind === "apply_patch"
    ? "Result"
    : "Output";

  return {
    kind,
    summary: getToolSummary(tool, kind, context),
    outputLabel,
    outputType: getToolOutputType(tool, kind),
  };
}

export function formatToolValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const rendered = JSON.stringify(value, null, 2);
  return rendered ?? "undefined";
}

function isValidJsonString(value: string): boolean {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return false;
  }

  try {
    JSON.parse(trimmedValue);
    return true;
  } catch {
    return false;
  }
}

export function formatJsonString(value: string): string | null {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return null;
  }

  try {
    return JSON.stringify(JSON.parse(trimmedValue), null, 2);
  } catch {
    return null;
  }
}

function buildViewDetails(input: Record<string, unknown>, tool: ToolCallData, context: ToolMetaContext): StructuredToolDetails {
  const rows: ToolDetailRow[] = [];
  const path = formatOptionalPath(getFileTargetField(input), context);
  const range = input["view_range"];
  appendRow(rows, "Path", path);
  if (isViewRange(range)) {
    appendRow(rows, "Lines", `${range[0]}-${range[1]}`);
  }
  if (getBooleanField(input, "forceReadLargeFiles")) {
    appendRow(rows, "Large file mode", "Enabled");
  }

  const textOutput = getTextFromOutput(tool.output);
  const contentOutput = textOutput ? extractTaggedBlock(textOutput, "content") ?? textOutput : undefined;
  const outputBlocks = textOutput
    ? [{ type: "text", title: "Contents", content: contentOutput! } satisfies ToolDetailBlock]
    : [];

  return {
    inputBlocks: rows.length > 0 ? [{ type: "rows", rows }] : [],
    outputBlocks,
  };
}

function buildFallbackViewDetails(tool: ToolCallData, context: ToolMetaContext): StructuredToolDetails {
  const outputText = getTextFromOutput(tool.output);
  const path = outputText ? extractTaggedBlock(outputText, "path") : undefined;
  const contentOutput = outputText ? extractTaggedBlock(outputText, "content") ?? outputText : undefined;
  const rows: ToolDetailRow[] = [];
  appendRow(rows, "Path", formatOptionalPath(path, context));

  return {
    inputBlocks: rows.length > 0 ? [{ type: "rows", rows }] : [],
    outputBlocks: contentOutput ? [{ type: "text", title: "Contents", content: contentOutput }] : [],
  };
}

function buildGlobDetails(input: Record<string, unknown>, tool: ToolCallData, context: ToolMetaContext): StructuredToolDetails {
  const rows: ToolDetailRow[] = [];
  appendRow(rows, "Pattern", getStringField(input, "pattern"));
  appendRow(rows, "Path", formatOptionalPath(getPathField(input), context));
  appendRow(rows, "Paths", formatOptionalPaths(getPathsField(input), context));

  const arrayOutput = getStringArray(tool.output);
  if (arrayOutput && arrayOutput.length > 0) {
    return {
      inputBlocks: rows.length > 0 ? [{ type: "rows", rows }] : [],
      outputBlocks: [{ type: "list", title: "Matches", items: arrayOutput.map((entry) => formatToolPathForDisplay(entry, context.pathDisplayRoot)) }],
    };
  }

  const textOutput = getTextFromOutput(tool.output);
  const outputLines = textOutput ? splitNonEmptyLines(textOutput) : [];
  return {
    inputBlocks: rows.length > 0 ? [{ type: "rows", rows }] : [],
    outputBlocks: outputLines.length > 1
      ? [{ type: "list", title: "Matches", items: outputLines.map((entry) => formatToolPathForDisplay(entry, context.pathDisplayRoot)) }]
      : textOutput
        ? [{ type: "text", title: "Result", content: textOutput }]
        : [],
  };
}

function buildRgDetails(input: Record<string, unknown>, tool: ToolCallData, context: ToolMetaContext): StructuredToolDetails {
  const rows: ToolDetailRow[] = [];
  appendRow(rows, "Pattern", getStringField(input, "pattern"));
  appendRow(rows, "Path", formatOptionalPath(getPathField(input), context));
  appendRow(rows, "Paths", formatOptionalPaths(getPathsField(input), context));
  appendRow(rows, "Output mode", getStringField(input, "output_mode"));
  appendRow(rows, "Glob", getStringField(input, "glob"));
  appendRow(rows, "File type", getStringField(input, "type"));
  appendRow(rows, "Head limit", formatScalarValue(input["head_limit"]));
  appendRow(rows, "Line numbers", getBooleanField(input, "-n") ? "On" : undefined);
  appendRow(rows, "Case insensitive", getBooleanField(input, "-i") ? "On" : undefined);
  appendRow(rows, "Multiline", getBooleanField(input, "multiline") ? "On" : undefined);

  const textOutput = getTextFromOutput(tool.output);
  return {
    inputBlocks: rows.length > 0 ? [{ type: "rows", rows }] : [],
    outputBlocks: textOutput ? [{ type: "text", title: "Matches", content: textOutput }] : [],
  };
}

function buildFallbackSearchDetails(tool: ToolCallData, context: ToolMetaContext): StructuredToolDetails {
  const outputText = getTextFromOutput(tool.output);
  const outputRecord = isRecord(tool.output) ? tool.output : undefined;
  const metadata = outputRecord && isRecord(outputRecord["metadata"]) ? outputRecord["metadata"] : undefined;
  const matches = Array.isArray(metadata?.["matches"]) ? metadata["matches"] : undefined;

  if (matches && matches.every((match) => isRecord(match))) {
    const items = matches
      .map((match) => {
        const file = typeof match["file"] === "string" ? formatToolPathForDisplay(match["file"], context.pathDisplayRoot) : undefined;
        const line = typeof match["line"] === "number" ? String(match["line"]) : undefined;
        const text = typeof match["text"] === "string" ? match["text"].trim() : undefined;
        return [file, line ? `:${line}` : undefined, text ? ` ${text}` : undefined].filter(Boolean).join("");
      })
      .filter((item) => item.length > 0);

    return {
      inputBlocks: [],
      outputBlocks: items.length > 0 ? [{ type: "list", title: "Matches", items }] : outputText ? [{ type: "text", title: "Matches", content: outputText }] : [],
    };
  }

  return {
    inputBlocks: [],
    outputBlocks: outputText ? [{ type: "text", title: "Matches", content: outputText }] : [],
  };
}

function buildApplyPatchDetails(tool: ToolCallData): StructuredToolDetails {
  const patchText = typeof tool.input === "string"
    ? tool.input
    : isRecord(tool.input) && typeof tool.input["patchText"] === "string"
      ? tool.input["patchText"]
      : undefined;

  if (!patchText) {
    return { inputBlocks: [], outputBlocks: [] };
  }

  const { sections, fileLabels } = parseApplyPatchDetails(patchText);
  const rows: ToolDetailRow[] = [];
  if (fileLabels.length === 1) {
    appendRow(rows, "File", fileLabels[0]);
  } else if (fileLabels.length > 1) {
    appendRow(rows, "Files", fileLabels.join(", "));
  }

  return {
    inputBlocks: [
      ...(rows.length > 0 ? [{ type: "rows", rows } satisfies ToolDetailBlock] : []),
      sections.length > 0
        ? { type: "patch", title: "Patch", files: sections }
        : { type: "code", title: "Patch", content: patchText },
    ],
    outputBlocks: getTextFromOutput(tool.output)
      ? [{ type: "text", title: "Result", content: getTextFromOutput(tool.output)! }]
      : [],
  };
}

function buildBashDetails(input: Record<string, unknown>, tool: ToolCallData): StructuredToolDetails {
  const rows: ToolDetailRow[] = [];
  appendRow(rows, "Description", getStringField(input, "description"));
  appendRow(rows, "Shell", getStringField(input, "shellId"));
  appendRow(rows, "Mode", getStringField(input, "mode"));
  appendRow(rows, "Initial wait", formatScalarValue(input["initial_wait"]));
  appendRow(rows, "Detached", getBooleanField(input, "detach") ? "Yes" : undefined);

  const command = getStringField(input, "command");
  const outputText = getTextFromOutput(tool.output);
  return {
    inputBlocks: [
      ...(rows.length > 0 ? [{ type: "rows", rows } satisfies ToolDetailBlock] : []),
      ...(command ? [{ type: "code", title: "Command", content: command } satisfies ToolDetailBlock] : []),
    ],
    outputBlocks: outputText ? [{ type: "text", title: "Output", content: outputText }] : [],
  };
}

function buildReadBashDetails(input: Record<string, unknown>, tool: ToolCallData): StructuredToolDetails {
  const rows: ToolDetailRow[] = [];
  appendRow(rows, "Shell", getStringField(input, "shellId"));
  appendRow(rows, "Delay", formatScalarValue(input["delay"]));
  return {
    inputBlocks: rows.length > 0 ? [{ type: "rows", rows }] : [],
    outputBlocks: getTextFromOutput(tool.output) ? [{ type: "text", title: "Output", content: getTextFromOutput(tool.output)! }] : [],
  };
}

function buildWriteBashDetails(input: Record<string, unknown>, tool: ToolCallData): StructuredToolDetails {
  const rows: ToolDetailRow[] = [];
  appendRow(rows, "Shell", getStringField(input, "shellId"));
  appendRow(rows, "Delay", formatScalarValue(input["delay"]));
  const shellInput = getStringField(input, "input");
  return {
    inputBlocks: [
      ...(rows.length > 0 ? [{ type: "rows", rows } satisfies ToolDetailBlock] : []),
      ...(shellInput ? [{ type: "code", title: "Sent input", content: shellInput } satisfies ToolDetailBlock] : []),
    ],
    outputBlocks: getTextFromOutput(tool.output) ? [{ type: "text", title: "Output", content: getTextFromOutput(tool.output)! }] : [],
  };
}

function buildSqlDetails(input: Record<string, unknown>, tool: ToolCallData): StructuredToolDetails {
  const rows: ToolDetailRow[] = [];
  appendRow(rows, "Description", getStringField(input, "description"));
  const query = getStringField(input, "query");
  const outputText = getTextFromOutput(tool.output);
  return {
    inputBlocks: [
      ...(rows.length > 0 ? [{ type: "rows", rows } satisfies ToolDetailBlock] : []),
      ...(query ? [{ type: "code", title: "Query", content: query } satisfies ToolDetailBlock] : []),
    ],
    outputBlocks: outputText ? [{ type: "text", title: "Result", content: outputText }] : [],
  };
}

function buildGitHubMcpDetails(input: Record<string, unknown>, tool: ToolCallData): StructuredToolDetails {
  const rows: ToolDetailRow[] = [];
  appendRow(rows, "Owner", getStringField(input, "owner"));
  appendRow(rows, "Repo", getStringField(input, "repo"));
  appendRow(rows, "Method", getStringField(input, "method"));
  appendRow(rows, "Pull request", formatScalarValue(input["pullNumber"]));
  appendRow(rows, "Resource", formatScalarValue(input["resource_id"]));
  appendRow(rows, "Page", formatScalarValue(input["page"]));
  appendRow(rows, "Per page", formatScalarValue(input["perPage"] ?? input["per_page"]));

  const outputText = getTextFromOutput(tool.output);
  return {
    inputBlocks: rows.length > 0 ? [{ type: "rows", rows }] : [],
    outputBlocks: outputText ? [{ type: "text", title: "Result", content: outputText }] : [],
  };
}

function buildWebFetchDetails(input: Record<string, unknown>, tool: ToolCallData): StructuredToolDetails {
  const rows: ToolDetailRow[] = [];
  appendRow(rows, "URL", getStringField(input, "url"));
  appendRow(rows, "Max length", formatScalarValue(input["max_length"]));
  appendRow(rows, "Start index", formatScalarValue(input["start_index"]));
  appendRow(rows, "Raw HTML", getBooleanField(input, "raw") ? "Yes" : undefined);
  return {
    inputBlocks: rows.length > 0 ? [{ type: "rows", rows }] : [],
    outputBlocks: getTextFromOutput(tool.output) ? [{ type: "text", title: "Content", content: getTextFromOutput(tool.output)! }] : [],
  };
}

function buildSkillDetails(input: Record<string, unknown>, tool: ToolCallData): StructuredToolDetails {
  const rows: ToolDetailRow[] = [];
  appendRow(rows, "Skill", getStringField(input, "skill"));
  return {
    inputBlocks: rows.length > 0 ? [{ type: "rows", rows }] : [],
    outputBlocks: getTextFromOutput(tool.output) ? [{ type: "text", title: "Output", content: getTextFromOutput(tool.output)! }] : [],
  };
}

function buildRubberDuckDetails(input: Record<string, unknown>, tool: ToolCallData): StructuredToolDetails {
  const rows: ToolDetailRow[] = [];
  appendRow(rows, "Description", getStringField(input, "description"));
  appendRow(rows, "Agent type", getStringField(input, "agent_type"));
  appendRow(rows, "Name", getStringField(input, "name"));

  const prompt = getStringField(input, "prompt");
  const outputText = getTextFromOutput(tool.output);
  const outputBlocks: ToolDetailBlock[] = outputText
    ? [{ type: "text", title: "Output", content: outputText }]
    : tool.output !== undefined
      ? [{ type: "json", title: "Output", value: tool.output }]
      : [];

  return {
    inputBlocks: [
      ...(rows.length > 0 ? [{ type: "rows", rows } satisfies ToolDetailBlock] : []),
      ...(prompt ? [{ type: "text", title: "Prompt", content: prompt } satisfies ToolDetailBlock] : []),
    ],
    outputBlocks,
  };
}

function buildTodoDetails(input: Record<string, unknown>, tool: ToolCallData): StructuredToolDetails {
  const todos = Array.isArray(input["todos"]) ? input["todos"] : [];
  const todoItems = todos
    .filter((todo) => isRecord(todo))
    .map((todo) => {
      const content = typeof todo["content"] === "string" ? todo["content"] : "";
      const status = typeof todo["status"] === "string" ? todo["status"] : undefined;
      const priority = typeof todo["priority"] === "string" ? todo["priority"] : undefined;
      const suffix = [status, priority].filter(Boolean).join(" / ");
      return suffix ? `${content} (${suffix})` : content;
    })
    .filter((item) => item.length > 0);

  const outputText = getTextFromOutput(tool.output);
  return {
    inputBlocks: todoItems.length > 0 ? [{ type: "list", title: "Todos", items: todoItems }] : [],
    outputBlocks: outputText ? [{ type: "text", title: "Output", content: outputText }] : [],
  };
}

export function getStructuredToolDetails(tool: ToolCallData, context: ToolMetaContext = {}): StructuredToolDetails | null {
  const kind = inferToolKind(tool);

  if (kind === "apply_patch") {
    return buildApplyPatchDetails(tool);
  }

  if (!isRecord(tool.input) || isEmptyRecord(tool.input)) {
    switch (kind) {
      case "view":
        return buildFallbackViewDetails(tool, context);
      case "glob":
      case "rg":
        return buildFallbackSearchDetails(tool, context);
      default:
        return null;
    }
  }

  switch (kind) {
    case "view":
      return buildViewDetails(tool.input, tool, context);
    case "edit":
      return null;
    case "glob":
      return buildGlobDetails(tool.input, tool, context);
    case "rg":
      return buildRgDetails(tool.input, tool, context);
    case "bash":
      return buildBashDetails(tool.input, tool);
    case "read_bash":
      return buildReadBashDetails(tool.input, tool);
    case "write_bash":
      return buildWriteBashDetails(tool.input, tool);
    case "sql":
      return buildSqlDetails(tool.input, tool);
    case "github_mcp":
      return buildGitHubMcpDetails(tool.input, tool);
    case "web_fetch":
      return buildWebFetchDetails(tool.input, tool);
    case "todo":
      return buildTodoDetails(tool.input, tool);
    case "skill":
      return buildSkillDetails(tool.input, tool);
    case "rubber_duck":
      return buildRubberDuckDetails(tool.input, tool);
    case "unknown":
      return null;
  }
}
