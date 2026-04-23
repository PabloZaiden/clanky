import type { FileDiff, ToolCallData } from "../../types";
import { formatToolPathForDisplay } from "./tool-paths";

export type InferredToolKind =
  | "view"
  | "glob"
  | "rg"
  | "apply_patch"
  | "bash"
  | "read_bash"
  | "write_bash"
  | "sql"
  | "github_mcp"
  | "web_fetch"
  | "skill"
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

function getStoredName(tool: ToolCallData): string | undefined {
  const name = tool.name.trim();
  return name.length > 0 ? name : undefined;
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

function formatApplyPatchFileLabel(file: ApplyPatchFileSection): string {
  return file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
}

function parseApplyPatchFiles(input: string): string[] {
  const sections = parseApplyPatchSections(input);
  if (sections.length > 0) {
    return Array.from(new Set(sections.map((section) => formatApplyPatchFileLabel(section))));
  }

  const matches = input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm);
  const files = Array.from(matches, (match) => match[1]?.trim()).filter((file): file is string => Boolean(file));
  return Array.from(new Set(files));
}

export function parseApplyPatchSections(input: string): ApplyPatchFileSection[] {
  const lines = normalizePatchLines(input);
  const sections: ApplyPatchFileSection[] = [];
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

    const counts = countPatchLines(current.lines);
    sections.push({
      path: current.moveTo ?? current.sourcePath,
      oldPath: current.moveTo ? current.sourcePath : undefined,
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
  return sections;
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
  return typeof detailedContent === "string" ? detailedContent : undefined;
}

export function inferToolKind(tool: ToolCallData): InferredToolKind {
  const { input } = tool;

  if (typeof input === "string" && input.startsWith("*** Begin Patch")) {
    return "apply_patch";
  }

  if (!isRecord(input)) {
    return "unknown";
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

  return "unknown";
}

export function getToolSummary(tool: ToolCallData, kind: InferredToolKind, context: ToolMetaContext = {}): string {
  const input = isRecord(tool.input) ? tool.input : undefined;

  switch (kind) {
    case "view": {
      const path = input ? getFileTargetField(input) : undefined;
      const displayPath = path ? formatToolPathForDisplay(path, context.pathDisplayRoot) : undefined;
      const range = input?.["view_range"];
      if (displayPath && isViewRange(range)) {
        return `View ${displayPath}:${range[0]}-${range[1]}`;
      }
      return `View ${displayPath ?? "file"}`;
    }
    case "glob": {
      const pattern = input ? getStringField(input, "pattern") : undefined;
      const path = input ? getPathField(input) : undefined;
      if (path && pattern) {
        return `Find files matching '${pattern}' in ${path}`;
      }
      return `Find files matching '${pattern ?? ""}'`;
    }
    case "rg": {
      const pattern = input ? getStringField(input, "pattern") : undefined;
      const path = input ? getPathField(input) : undefined;
      const paths = input ? getPathsField(input) : undefined;
      if (path && pattern) {
        return `Search for '${pattern}' in ${path}`;
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
    case "skill": {
      const skill = input ? getStringField(input, "skill") : undefined;
      return `Load skill ${skill ?? "unknown"}`;
    }
    case "unknown": {
      const storedName = getStoredName(tool);
      return storedName ? `Unknown tool (stored as ${storedName})` : "Unknown tool";
    }
  }
}

function shellIdFromInput(input: Record<string, unknown> | undefined): string | undefined {
  return input ? getStringField(input, "shellId") : undefined;
}

export function getToolOutputType(tool: ToolCallData, kind: InferredToolKind): "text" | "json" {
  if (getTextFromOutput(tool.output) !== undefined) {
    return "text";
  }

  switch (kind) {
    case "view":
    case "glob":
    case "rg":
    case "apply_patch":
    case "bash":
    case "read_bash":
    case "write_bash":
    case "web_fetch":
    case "skill":
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
  const outputBlocks = textOutput
    ? [{ type: "text", title: "Contents", content: textOutput } satisfies ToolDetailBlock]
    : [];

  return {
    inputBlocks: rows.length > 0 ? [{ type: "rows", rows }] : [],
    outputBlocks,
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

function buildApplyPatchDetails(tool: ToolCallData): StructuredToolDetails {
  if (typeof tool.input !== "string") {
    return { inputBlocks: [], outputBlocks: [] };
  }

  const sections = parseApplyPatchSections(tool.input);
  const files = sections.length > 0
    ? sections.map((section) => formatApplyPatchFileLabel(section))
    : parseApplyPatchFiles(tool.input);
  const rows: ToolDetailRow[] = [];
  if (files.length === 1) {
    appendRow(rows, "File", files[0]);
  } else if (files.length > 1) {
    appendRow(rows, "Files", files.join(", "));
  }

  return {
    inputBlocks: [
      ...(rows.length > 0 ? [{ type: "rows", rows } satisfies ToolDetailBlock] : []),
      sections.length > 0
        ? { type: "patch", title: "Patch", files: sections }
        : { type: "code", title: "Patch", content: tool.input },
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

export function getStructuredToolDetails(tool: ToolCallData, context: ToolMetaContext = {}): StructuredToolDetails | null {
  const kind = inferToolKind(tool);

  if (kind === "apply_patch") {
    return buildApplyPatchDetails(tool);
  }

  if (!isRecord(tool.input)) {
    return null;
  }

  switch (kind) {
    case "view":
      return buildViewDetails(tool.input, tool, context);
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
    case "skill":
      return buildSkillDetails(tool.input, tool);
    case "unknown":
      return null;
  }
}
