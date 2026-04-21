import type { ToolCallData } from "../../types";

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

function parseApplyPatchFiles(input: string): string[] {
  const matches = input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm);
  const files = Array.from(matches, (match) => match[1]?.trim()).filter((file): file is string => Boolean(file));
  return Array.from(new Set(files));
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

export function getToolSummary(tool: ToolCallData, kind: InferredToolKind): string {
  const input = isRecord(tool.input) ? tool.input : undefined;

  switch (kind) {
    case "view": {
      const path = input ? getFileTargetField(input) : undefined;
      const range = input?.["view_range"];
      if (path && isViewRange(range)) {
        return `View ${path}:${range[0]}-${range[1]}`;
      }
      return `View ${path ?? "file"}`;
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

export function getToolMeta(tool: ToolCallData): ToolMeta {
  const kind = inferToolKind(tool);
  const outputLabel = kind === "sql" ? "Done" : kind === "view" || kind === "glob" || kind === "rg" || kind === "apply_patch"
    ? "Result"
    : "Output";

  return {
    kind,
    summary: getToolSummary(tool, kind),
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
