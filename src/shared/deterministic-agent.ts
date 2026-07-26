import type { TaskLogEntry } from "./task";

export const DETERMINISTIC_AGENT_CODE_CONTRACT = {
  exportRule: "The source must export a default function named run (ctx) or an anonymous default function.",
  asyncRule: "The function may be async and must use only the provided context.",
  exec: "ctx.workspace.exec(command, args?, options?) -> Promise<{ success, exitCode, stdout, stderr }>",
  prompt: "ctx.workspace.prompt(message) -> Promise<string>",
  output: "ctx.stdout.write(text) and ctx.stderr.write(text) for observable output.",
  signal: "ctx.signal for cancellation.",
  restrictions: "Do not invent imports, credentials, filesystem access, or APIs outside this context.",
  visibility: "The user can only see text written to stdout and stderr. Never print secrets or other hidden information to either stream.",
} as const;

export const DETERMINISTIC_AGENT_CODE_EXAMPLE = [
  "export default function run(ctx) {",
  '  ctx.stdout.write("Hello from my agent!\\n");',
  "}",
].join("\n");

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
