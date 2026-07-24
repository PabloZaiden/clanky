import type { ToolCallRecord } from "./tool-call";

export type ToolCallKind =
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

export interface ToolCallPresentationContext {
  pathDisplayRoot?: string;
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

const PATCH_SCAN_LIMIT = 128 * 1024;

const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:\/$/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:\//;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getStringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getNumberField(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
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

function hasOnlyKeys(input: Record<string, unknown>, allowedKeys: string[]): boolean {
  return Object.keys(input).every((key) => allowedKeys.includes(key));
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

function getStoredName(tool: ToolCallRecord): string | undefined {
  const name = tool.name.trim().replace(/^general tool:\s*/i, "");
  return name.length > 0 ? name : undefined;
}

function getNamedKind(name: string | undefined, input?: Record<string, unknown>): ToolCallKind | undefined {
  const normalized = name?.trim().toLowerCase().replace(/^general tool:\s*/i, "");
  if (!normalized) {
    return undefined;
  }

  if (normalized === "read" || normalized === "view" || normalized === "read_file" || normalized === "read_file_range") {
    return "view";
  }
  if (normalized === "edit" || normalized === "write" || normalized === "multiedit") {
    return "edit";
  }
  if (normalized === "execute" || normalized === "bash" || normalized === "shell" || normalized === "terminal") {
    return "bash";
  }
  if (normalized === "grep" || normalized === "rg") {
    return "rg";
  }
  if (normalized === "glob" || normalized === "ls" || normalized === "list_files") {
    return "glob";
  }
  if (normalized === "fetch" || normalized === "webfetch" || normalized === "web_fetch") {
    return "web_fetch";
  }
  if (normalized === "todowrite") {
    return "todo";
  }
  if (normalized === "context7_resolve_library_id" || normalized === "context7_get_library_docs") {
    return "rg";
  }
  if (normalized === "sql" || normalized === "query") {
    return "sql";
  }

  if (normalized === "search") {
    const pattern = input ? getStringField(input, "pattern") : undefined;
    if (pattern && input && RG_STYLE_KEYS.some((key) => key in input)) {
      return "rg";
    }
    return "glob";
  }

  return undefined;
}

function getInputNamedKind(input: Record<string, unknown>): ToolCallKind | undefined {
  for (const key of ["tool", "tool_name", "toolName", "operation", "action", "type", "name"]) {
    const kind = getNamedKind(getStringField(input, key), input);
    if (kind) {
      return kind;
    }
  }
  return undefined;
}

function truncateSummary(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

function normalizeDisplayPath(path: string): string {
  const normalizedSlashes = path.replaceAll("\\", "/");
  const collapsed = normalizedSlashes.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/") && !WINDOWS_DRIVE_ROOT_PATTERN.test(collapsed)) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
}

function isAbsoluteDisplayPath(path: string): boolean {
  return path.startsWith("/") || WINDOWS_ABSOLUTE_PATH_PATTERN.test(path);
}

export function formatToolPathForDisplay(path: string, displayRoot?: string): string {
  const normalizedPath = normalizeDisplayPath(path);
  if (!displayRoot || !isAbsoluteDisplayPath(normalizedPath)) {
    return normalizedPath;
  }

  const normalizedRoot = normalizeDisplayPath(displayRoot);
  if (!isAbsoluteDisplayPath(normalizedRoot)) {
    return normalizedPath;
  }

  if (normalizedPath === normalizedRoot) {
    return ".";
  }

  const rootedPrefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  if (!normalizedPath.startsWith(rootedPrefix)) {
    return normalizedPath;
  }

  const relativePath = normalizedPath.slice(rootedPrefix.length);
  return relativePath.length > 0 ? relativePath : normalizedPath;
}

function getCommandUrl(command: string): string | undefined {
  if (!/\bcurl\b/i.test(command)) {
    return undefined;
  }
  const match = command.match(/https?:\/\/[^\s"'<>]+/i);
  return match?.[0];
}

function parsePatchFileLabels(input: string): string[] {
  const files: string[] = [];
  let currentPath: string | undefined;
  let moveTo: string | undefined;

  function flush(): void {
    if (!currentPath) {
      return;
    }
    files.push(moveTo ? `${currentPath} → ${moveTo}` : currentPath);
    currentPath = undefined;
    moveTo = undefined;
  }

  for (const line of input.slice(0, PATCH_SCAN_LIMIT).split(/\r?\n/)) {
    const fileMatch = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (fileMatch) {
      flush();
      currentPath = fileMatch[2]?.trim();
      continue;
    }

    if (currentPath) {
      const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
      if (moveMatch) {
        moveTo = moveMatch[1]?.trim();
      }
    }
  }

  flush();
  return Array.from(new Set(files));
}

function getPatchInput(tool: ToolCallRecord): string | undefined {
  if (typeof tool.input === "string" && tool.input.startsWith("*** Begin Patch")) {
    return tool.input;
  }
  if (isRecord(tool.input)) {
    const patchText = tool.input["patchText"];
    if (typeof patchText === "string" && patchText.startsWith("*** Begin Patch")) {
      return patchText;
    }
  }
  return undefined;
}

export function inferToolCallKind(tool: ToolCallRecord): ToolCallKind {
  const input = tool.input;
  const patchInput = getPatchInput(tool);
  if (patchInput) {
    return "apply_patch";
  }

  if (!isRecord(input) || Object.keys(input).length === 0) {
    return getNamedKind(getStoredName(tool)) ?? "unknown";
  }

  if (Array.isArray(input["todos"])) {
    return "todo";
  }

  if (getStringField(input, "agent_type") === "rubber-duck") {
    return "rubber_duck";
  }

  const inputNamedKind = getInputNamedKind(input);
  if (inputNamedKind) {
    return inputNamedKind;
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

  return getNamedKind(getStoredName(tool), input) ?? "unknown";
}

function getOptionalPath(path: string | undefined, context: ToolCallPresentationContext): string | undefined {
  return path ? formatToolPathForDisplay(path, context.pathDisplayRoot) : undefined;
}

function getGenericInputSummary(input: Record<string, unknown>): string | undefined {
  for (const key of ["description", "operation", "action", "target", "path", "filePath", "url", "command", "query", "name"]) {
    const value = getStringField(input, key);
    if (value) {
      return truncateSummary(value);
    }
  }
  return undefined;
}

export function getToolCallSummary(
  tool: ToolCallRecord,
  kind: ToolCallKind = inferToolCallKind(tool),
  context: ToolCallPresentationContext = {},
): string {
  const input = isRecord(tool.input) ? tool.input : undefined;

  switch (kind) {
    case "view": {
      const path = input ? getFileTargetField(input) ?? getParsedCommandPath(input) : undefined;
      const displayPath = getOptionalPath(path, context);
      const range = input?.["view_range"];
      if (displayPath && isViewRange(range)) {
        return `View ${displayPath}:${range[0]}-${range[1]}`;
      }
      return `View ${displayPath ?? "file"}`;
    }
    case "edit": {
      const changes = input && isRecord(input["changes"]) ? input["changes"] : undefined;
      const changedPaths = changes ? Object.keys(changes) : [];
      const target = input ? getFileTargetField(input) : undefined;
      if (changedPaths.length === 1) {
        return `Edit ${getOptionalPath(changedPaths[0], context)}`;
      }
      if (changedPaths.length > 1) {
        return `Edit ${changedPaths.length} files`;
      }
      if (target) {
        return `Edit ${getOptionalPath(target, context)}`;
      }
      return "Edit files";
    }
    case "glob": {
      const pattern = input ? getStringField(input, "pattern") : undefined;
      const path = input ? getPathField(input) ?? getParsedCommandPath(input) : undefined;
      const displayPath = getOptionalPath(path, context);
      if (!pattern) {
        return displayPath ? `List ${displayPath}` : "List files";
      }
      if (path && pattern) {
        return `Find files matching '${truncateSummary(pattern, 80)}' in ${displayPath ?? path}`;
      }
      return `Find files matching '${truncateSummary(pattern, 100)}'`;
    }
    case "rg": {
      const pattern = input ? getStringField(input, "pattern") : undefined;
      const path = input ? getPathField(input) : undefined;
      const paths = input ? getPathsField(input) : undefined;
      const displayPath = getOptionalPath(path, context);
      if (path && pattern) {
        return `Search for '${truncateSummary(pattern, 80)}' in ${displayPath ?? path}`;
      }
      if (paths && pattern) {
        return `Search for '${truncateSummary(pattern, 80)}' in ${paths.length} paths`;
      }
      return `Search for '${truncateSummary(pattern ?? "text", 100)}'`;
    }
    case "apply_patch": {
      const patchInput = getPatchInput(tool);
      const files = patchInput ? parsePatchFileLabels(patchInput) : [];
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
      if (description) {
        return truncateSummary(description);
      }
      if (command) {
        const commandUrl = getCommandUrl(command);
        if (commandUrl) {
          return `Fetch ${truncateSummary(commandUrl, 120)}`;
        }
        return truncateSummary(command);
      }
      return "Run command";
    }
    case "read_bash":
      return `Read shell output (shell ${input ? getStringField(input, "shellId") ?? "unknown" : "unknown"})`;
    case "write_bash": {
      const shellId = input ? getStringField(input, "shellId") ?? "unknown" : "unknown";
      const rawInput = input ? getStringField(input, "input") : undefined;
      const preview = rawInput ? rawInput.trim() : "";
      if (preview.length > 0 && preview.length <= 20 && !/[\r\n\t]/.test(preview)) {
        return `Send input to shell ${shellId}: ${JSON.stringify(preview)}`;
      }
      return `Send input to shell ${shellId}`;
    }
    case "sql": {
      const description = input ? getStringField(input, "description") : undefined;
      return description ? truncateSummary(description) : "SQL query";
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
      return Array.isArray(todos) ? `Update todo list (${todos.length})` : "Update todo list";
    }
    case "skill": {
      const skill = input ? getStringField(input, "skill") : undefined;
      return `Load skill ${skill ?? "unknown"}`;
    }
    case "rubber_duck": {
      const description = input ? getStringField(input, "description") : undefined;
      const name = input ? getStringField(input, "name") : undefined;
      if (description) {
        return `Rubber duck: ${truncateSummary(description)}`;
      }
      if (name) {
        return `Rubber duck: ${truncateSummary(name)}`;
      }
      return "Rubber duck agent";
    }
    case "unknown": {
      const storedName = getStoredName(tool);
      const inputSummary = input ? getGenericInputSummary(input) : undefined;
      if (inputSummary && storedName && storedName.toLowerCase() !== "other") {
        return `${storedName}: ${inputSummary}`;
      }
      return storedName ? `General tool: ${storedName}` : "Unknown tool";
    }
  }
}

export function getToolCallOutputLabel(kind: ToolCallKind, status: ToolCallRecord["status"]): string {
  if (status === "failed") {
    return "Error";
  }
  if (kind === "sql") {
    return "Done";
  }
  if (kind === "view" || kind === "glob" || kind === "rg" || kind === "apply_patch") {
    return "Result";
  }
  return "Output";
}
