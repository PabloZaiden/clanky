/**
 * Shared CLI parsing and HTTP handling for one-shot command execution.
 */

import { CommandExecResultSchema } from "@/contracts/schemas";
import type { CliCommandResult } from "@pablozaiden/webapp/cli";
import {
  fetchCliApi,
  readCliResponseBody,
  responseErrorMessage,
  type CliApiAuth,
  type CliApiContext,
} from "./remote-api";

export interface ParsedExecCommand {
  target: string;
  cwd?: string;
  timeoutMs?: number;
  command: string;
  args: string[];
  options: Record<string, string>;
}

function usageError(message: string): Error {
  return new Error(message);
}

function parseOptionValue(
  args: readonly string[],
  index: number,
  name: string,
  inlineValue?: string,
): { value: string; nextIndex: number } {
  const value = inlineValue ?? args[index + 1];
  if (!value || value.startsWith("--")) {
    throw usageError(`${name} requires a value`);
  }
  return {
    value,
    nextIndex: inlineValue === undefined ? index + 1 : index,
  };
}

function parseOptions(
  args: readonly string[],
  allowedOptions: readonly string[],
  optionLabel: string,
): { positionals: string[]; options: Record<string, string> } {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [rawName, inlineValue] = arg.split("=", 2);
    const name = rawName ?? arg;
    if (!allowedOptions.includes(name)) {
      throw usageError(`Unknown ${optionLabel} option: ${name}`);
    }
    if (options[name] !== undefined) {
      throw usageError(`${name} may only be specified once`);
    }
    const parsed = parseOptionValue(args, index, name, inlineValue);
    options[name] = parsed.value;
    index = parsed.nextIndex;
  }
  return { positionals, options };
}

function parseTimeout(value: string): number {
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000) {
    throw usageError("--timeout must be an integer between 1 and 1800000");
  }
  return timeoutMs;
}

export function parseExecCommandArgs(
  args: readonly string[],
  usageName: string,
  targetLabel: string,
  additionalOptions: readonly string[] = [],
): ParsedExecCommand {
  const separator = args.indexOf("--");
  if (separator < 0) {
    throw usageError(`${usageName} requires -- before COMMAND`);
  }
  const controls = args.slice(0, separator);
  const commandArgs = args.slice(separator + 1);
  const { positionals, options } = parseOptions(
    controls,
    ["--cwd", "--timeout", ...additionalOptions],
    targetLabel,
  );
  if (positionals.length !== 1 || !positionals[0]) {
    throw usageError(`${usageName} requires one ${targetLabel} ID or name`);
  }
  const command = commandArgs[0];
  if (!command) {
    throw usageError(`${usageName} requires a command after --`);
  }
  return {
    target: positionals[0],
    cwd: options["--cwd"],
    timeoutMs: options["--timeout"] === undefined
      ? undefined
      : parseTimeout(options["--timeout"]),
    command,
    args: commandArgs.slice(1),
    options,
  };
}

export interface CliExecOutput {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

function writeCliOutput(output: { write(chunk: string): unknown }, text: string): void {
  if (text) {
    output.write(text);
  }
}

export async function runCliExecRequest(
  input: CliApiContext,
  auth: CliApiAuth,
  endpoint: string,
  command: Omit<ParsedExecCommand, "target" | "options">,
  output: CliExecOutput,
  responseLabel: string,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<CliCommandResult> {
  const response = await fetchCliApi(
    input,
    auth,
    endpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify({
        command: command.command,
        args: command.args,
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      }),
      signal,
    },
  );
  const body = await readCliResponseBody(response);
  if (!response.ok) {
    return {
      exitCode: 1,
      error: responseErrorMessage(body, `${responseLabel} command failed (HTTP ${String(response.status)})`),
    };
  }
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : undefined;
  const parsed = CommandExecResultSchema.safeParse({
    success: record?.["success"],
    stdout: record?.["stdout"],
    stderr: record?.["stderr"],
    exitCode: record?.["exitCode"],
  });
  if (!parsed.success) {
    return { exitCode: 1, error: `The ${responseLabel} exec response is invalid` };
  }
  if (parsed.data.success !== (parsed.data.exitCode === 0)) {
    return { exitCode: 1, error: `The ${responseLabel} exec response is inconsistent` };
  }
  writeCliOutput(output.stdout, parsed.data.stdout);
  writeCliOutput(output.stderr, parsed.data.stderr);
  return {
    exitCode: parsed.data.success ? 0 : parsed.data.exitCode,
  };
}
