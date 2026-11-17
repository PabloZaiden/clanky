import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { query, type Options, type Query, type SDKUserMessage, type SDKSessionStateChangedMessage } from "@anthropic-ai/claude-agent-sdk";
import { HarnessError } from "../harness-errors";

export interface ClaudeProcess {
  query: Query;
  readonly state?: SDKSessionStateChangedMessage["state"];
  send(message: SDKUserMessage): Promise<void>;
  close(): Promise<void>;
}

export class ClaudeRuntime {
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;

  constructor(readonly directory: string, env?: NodeJS.ProcessEnv) {
    this.env = { ...process.env, ...env };
    delete this.env["CLANKY_BASE_URL"];
    delete this.env["CLANKY_API_KEY"];
    this.env["CLAUDE_AGENT_SDK_CLIENT_APP"] = "clanky";
    const executable = Bun.which("claude", { PATH: this.env["PATH"], cwd: directory });
    if (!executable) throw new HarnessError("harness_runtime_unavailable", "Claude Code CLI is not installed on the execution host.");
    this.executable = executable;
  }

  open(options: Options = {}, onState?: (state: SDKSessionStateChangedMessage["state"], sessionId: string) => void): ClaudeProcess {
    const abortController = options.abortController ?? new AbortController();
    let exited: Promise<void> = Promise.resolve();
    let closing: Promise<void> | undefined;
    const input = new ClaudeInput(abortController.signal);
    let state: SDKSessionStateChangedMessage["state"] | undefined;
    const native = query({
      prompt: input.stream(),
      options: {
        ...options,
        cwd: this.directory, env: this.env, pathToClaudeCodeExecutable: this.executable,
        abortController, includePartialMessages: true, forwardSubagentText: true,
        settingSources: ["user", "project", "local"],
        systemPrompt: options.systemPrompt ?? { type: "preset", preset: "claude_code" },
        spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
          const child = spawn(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"] });
          const output = stateFrames((next, sessionId) => {
            const ownedId = options.sessionId ?? options.resume;
            if (ownedId && sessionId !== ownedId) return;
            state = next;
            onState?.(next, sessionId);
          });
          child.stdout.once("error", (error) => output.destroy(error));
          child.stdout = child.stdout.pipe(output);
          exited = new Promise<void>((resolve) => {
            child.once("exit", () => { abortController.abort(); resolve(); });
            child.once("error", () => { abortController.abort(); resolve(); });
          });
          return child;
        },
      },
    });
    return {
      query: native,
      get state() { return state; },
      send: (message) => input.send(message),
      close: () => closing ??= (async () => {
        abortController.abort();
        native.close();
        await exited;
      })(),
    };
  }
}

class ClaudeInput {
  private readonly pending: Array<{ message: SDKUserMessage; receipt: ReturnType<typeof Promise.withResolvers<void>> }> = [];
  private wake = Promise.withResolvers<void>();
  private current?: ReturnType<typeof Promise.withResolvers<void>>;

  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener("abort", () => {
      const error = new HarnessError("harness_transport_closed", "Claude input closed before admission.");
      this.current?.reject(error);
      for (const input of this.pending.splice(0)) input.receipt.reject(error);
      this.wake.resolve();
    }, { once: true });
  }

  send(message: SDKUserMessage): Promise<void> {
    if (this.signal.aborted) throw new HarnessError("harness_transport_closed", "Claude input is closed.");
    if (this.pending.length >= 32) throw new HarnessError("harness_input_capacity", "Claude's pending native input capacity reached.");
    const receipt = Promise.withResolvers<void>();
    this.pending.push({ message, receipt });
    this.wake.resolve();
    return receipt.promise;
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    // Finite SDK input streams wait for completion and close the native stdin.
    while (!this.signal.aborted) {
      const input = this.pending.shift();
      if (!input) {
        await this.wake.promise;
        this.wake = Promise.withResolvers<void>();
        continue;
      }
      this.current = input.receipt;
      yield input.message;
      input.receipt.resolve();
      this.current = undefined;
    }
  }
}

function stateFrames(onState: (state: SDKSessionStateChangedMessage["state"], sessionId: string) => void): Transform {
  let parts: Buffer[] = [];
  let length = 0;
  let discarded = false;
  // The SDK consumes host-only idle frames internally; preserve its bytes and
  // observe only bounded native liveness metadata for owned-work settlement.
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        for (let offset = 0; offset < chunk.length;) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          length += end - offset;
          if (length > 4096) { discarded = true; parts = []; }
          if (!discarded) parts.push(Buffer.from(chunk.subarray(offset, end)));
          if (newline >= 0) {
            if (!discarded) {
              const line = Buffer.concat(parts).toString("utf8");
              if (line.includes('"session_state_changed"')) {
                const value: unknown = JSON.parse(line);
                if (typeof value === "object" && value !== null && "type" in value && value.type === "system"
                  && "subtype" in value && value.subtype === "session_state_changed") {
                  if (!("state" in value) || !["idle", "running", "requires_action"].includes(String(value.state))
                    || !("session_id" in value) || typeof value.session_id !== "string") {
                    throw new HarnessError("harness_event_gap", "Claude reported invalid native session-state metadata.");
                  }
                  if (value.state === "idle" || value.state === "running" || value.state === "requires_action") onState(value.state, value.session_id);
                }
              }
            }
            parts = []; length = 0; discarded = false;
          }
          offset = newline < 0 ? chunk.length : newline + 1;
        }
        done(null, chunk);
      } catch (error) {
        done(error instanceof Error ? error : new Error("Claude native state observation failed."));
      }
    },
  });
}
