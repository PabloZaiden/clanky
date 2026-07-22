import type { TaskLogEntry } from "./task";

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
