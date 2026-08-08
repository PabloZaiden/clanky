import type { TaskLogEntry } from "./task";

export const DETERMINISTIC_AGENT_CODE_CONTRACT = {
  exportRule: "The source must export a default function named run (ctx) or an anonymous default function.",
  asyncRule: "The function may be async and must use only the provided context.",
  exec: "ctx.workspace.exec(command, args?, options?) -> Promise<DeterministicCommandResult>",
  prompt: "ctx.workspace.prompt(input) -> Promise<string>",
  output: "ctx.stdout.write(text) and ctx.stderr.write(text) for observable output.",
  signal: "ctx.signal: AbortSignal for cancellation.",
  restrictions: "Do not invent imports, credentials, filesystem access, or APIs outside this context.",
  visibility: "The user can only see text written to stdout and stderr. Never print secrets or other hidden information to either stream.",
  contextTypes: [
    [
      "interface DeterministicExecOptions {",
      "  cwd?: string;",
      "  timeout?: number; // milliseconds",
      "}",
    ].join("\n"),
    [
      "interface DeterministicCommandResult {",
      "  success: boolean;",
      "  stdout: string;",
      "  stderr: string;",
      "  exitCode: number;",
      "}",
    ].join("\n"),
    [
      "interface DeterministicWorkspace {",
      "  exec(",
      "    command: string,",
      "    args?: string[],",
      "    options?: DeterministicExecOptions,",
      "  ): Promise<DeterministicCommandResult>;",
      "  prompt(input: string): Promise<string>;",
      "}",
    ].join("\n"),
    [
      "interface DeterministicOutputWriter {",
      "  write(text: string): void;",
      "}",
    ].join("\n"),
    [
      "interface DeterministicAgentContext {",
      "  workspace: DeterministicWorkspace;",
      "  stdout: DeterministicOutputWriter;",
      "  stderr: DeterministicOutputWriter;",
      "  signal: AbortSignal;",
      "}",
    ].join("\n"),
  ],
  runtimeSemantics: [
    "workspace.exec() invokes one command with a separate argument array and does not parse shell syntax. Use an explicit shell command such as `sh -c` when shell features are intentional.",
    "workspace.exec() uses the current run directory as its default working directory: the prepared worktree directory when worktrees are enabled, or the workspace's configured directory otherwise. options.cwd overrides that default, and options.timeout is in milliseconds.",
    "A non-zero command exit, timeout, or command-level cancellation resolves to a result with success false and preserves stdout, stderr, and exitCode; it is not thrown as a command exception.",
    "Command output is returned to the program only. It is not user-visible unless the program deliberately forwards selected, sanitized text through stdout.write() or stderr.write().",
    "workspace.prompt() sends a message to the current Clanky conversation and resolves with the assistant response. Bridge failures reject the call, so handle failure without leaking credentials or hidden data.",
    "ctx.signal becomes aborted when the run is cancelled. Check it before expensive work and pass its cancellation through awaited operations instead of continuing after cancellation.",
    "Only text explicitly written with stdout.write() or stderr.write() is visible. Direct console or process output is ignored by the deterministic runner.",
  ],
  nodeRestrictions: [
    "Source runs under Node.js 24+ TypeScript type stripping and must be complete, self-contained source.",
    "Do not use enum declarations, namespace declarations, module declarations, or constructor parameter properties; Node.js type stripping does not support them.",
    "Use only the supplied context. Do not invent imports, credentials, filesystem access, environment assumptions, or undocumented APIs.",
    "Keep useful failures observable, but sanitize error details and never print secrets, tokens, credentials, or other hidden information.",
  ],
  examples: [
    {
      title: "Run a command and forward useful output",
      description: "Arguments stay separate from the command, and command output is explicitly selected for visibility.",
      code: [
        "export default async function run(ctx) {",
        '  const result = await ctx.workspace.exec("git", ["status", "--short"], { timeout: 30_000 });',
        "  if (!result.success) {",
        '    ctx.stderr.write("git status failed with exit code " + result.exitCode + "\\n");',
        "    return;",
        "  }",
        '  ctx.stdout.write(result.stdout || "Working tree is clean.\\n");',
        "}",
      ].join("\n"),
    },
    {
      title: "Ask the current conversation for input",
      description: "prompt() returns a string to the program; it is not automatically displayed to the user.",
      code: [
        "export default async function run(ctx) {",
        '  const response = await ctx.workspace.prompt("Summarize the current workspace status.");',
        '  ctx.stdout.write(response + "\\n");',
        "}",
      ].join("\n"),
    },
    {
      title: "Honor cancellation",
      description: "Check the signal around awaited work and stop without forwarding stale output.",
      code: [
        "export default async function run(ctx) {",
        "  if (ctx.signal.aborted) return;",
        '  const result = await ctx.workspace.exec("git", ["status", "--short"]);',
        "  if (ctx.signal.aborted) return;",
        '  if (result.success) ctx.stdout.write(result.stdout);',
        "}",
      ].join("\n"),
    },
  ],
} as const;

export const DETERMINISTIC_AGENT_CODE_EXAMPLE = DETERMINISTIC_AGENT_CODE_CONTRACT.examples[0].code;

export interface DeterministicExecOptions {
  cwd?: string;
  timeout?: number;
}

export interface DeterministicCommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DeterministicWorkspace {
  exec(
    command: string,
    args?: string[],
    options?: DeterministicExecOptions,
  ): Promise<DeterministicCommandResult>;
  prompt(input: string): Promise<string>;
}

export interface DeterministicOutputWriter {
  write(text: string): void;
}

export interface DeterministicAgentContext {
  workspace: DeterministicWorkspace;
  stdout: DeterministicOutputWriter;
  stderr: DeterministicOutputWriter;
  signal: AbortSignal;
}

export interface DeterministicCodeDiagnostic {
  message: string;
  line?: number;
  column?: number;
}

export interface GeneratedAgentCode {
  code: string;
  diagnostics: DeterministicCodeDiagnostic[];
}

export interface DeterministicAgentTestResult {
  status: "completed" | "failed" | "cancelled";
  logs: TaskLogEntry[];
  error?: string;
  diagnostics: DeterministicCodeDiagnostic[];
}

export type DeterministicAgentTestStreamEvent =
  | {
      type: "log";
      log: TaskLogEntry;
    }
  | {
      type: "result";
      result: DeterministicAgentTestResult;
    };
