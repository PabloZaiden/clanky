import type {
  DeterministicAgentContext,
  DeterministicCommandResult,
  DeterministicExecOptions,
} from "@/shared/deterministic-agent";
import type { AgentRun } from "@/shared/agent";
import type { ManagedContextIdentity } from "@/shared/context-api-key";
import { chatManager } from "./chat-manager";
import { backendManager } from "./backend";
import { managedContextIdentityResolver } from "./managed-context-identity";
import { loadDeterministicAgentProgram } from "./deterministic-agent-code";
import { DeterministicAgentOutput } from "./deterministic-agent-output";

export interface DeterministicAgentRuntimeOptions {
  run: AgentRun;
  code: string;
  chatId: string;
  workspaceId: string;
  directory: string;
  signal: AbortSignal;
  output: DeterministicAgentOutput;
  managedContextIdentity?: ManagedContextIdentity;
}

function createAbortError(): Error {
  return new Error("Deterministic agent run interrupted", { cause: "aborted" });
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError();
  }
}

async function getLatestAssistantMessage(chatId: string): Promise<string> {
  const chat = await chatManager.getChat(chatId);
  if (!chat) {
    throw new Error(`Agent run chat was not found: ${chatId}`);
  }
  const message = [...chat.state.messages].reverse().find((entry) => entry.role === "assistant");
  if (!message) {
    throw new Error("Workspace prompt completed without an assistant response");
  }
  return message.content;
}

export async function executeDeterministicAgent(
  options: DeterministicAgentRuntimeOptions,
): Promise<AgentRun> {
  const {
    run,
    code,
    chatId,
    workspaceId,
    directory,
    signal,
    output,
  } = options;
  const identity = options.managedContextIdentity
    ?? await managedContextIdentityResolver.forAgentRun(run.id, workspaceId);
  const executor = await backendManager.getCommandExecutorForContextAsync(identity, directory);
  const program = await loadDeterministicAgentProgram(code);

  const exec = async (
    command: string,
    args: string[] = [],
    execOptions?: DeterministicExecOptions,
  ): Promise<DeterministicCommandResult> => {
    assertNotAborted(signal);
    let stdoutObserved = false;
    let stderrObserved = false;
    const result = await executor.exec(command, args, {
      cwd: execOptions?.cwd,
      timeout: execOptions?.timeout,
      signal,
      logFailures: false,
      onStdoutChunk: (chunk) => {
        stdoutObserved = true;
        output.append("stdout", "command", chunk);
      },
      onStderrChunk: (chunk) => {
        stderrObserved = true;
        output.append("stderr", "command", chunk);
      },
    });
    if (!stdoutObserved && result.stdout) {
      output.append("stdout", "command", result.stdout);
    }
    if (!stderrObserved && result.stderr) {
      output.append("stderr", "command", result.stderr);
    }
    return result;
  };

  const prompt = async (input: string): Promise<string> => {
    assertNotAborted(signal);
    let abortHandler: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      abortHandler = () => {
        const interruptPromise = chatManager.interruptChat(
          chatId,
          "Deterministic agent run interrupted",
        );
        void interruptPromise.then(
          () => reject(createAbortError()),
          (error) => reject(error),
        );
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    });
    try {
      await Promise.race([
        chatManager.sendMessage(chatId, { message: input }),
        abortPromise,
      ]);
      const completedChat = await Promise.race([
        chatManager.waitForChatIdle(chatId),
        abortPromise,
      ]);
      if (completedChat.state.status === "failed" || completedChat.state.error) {
        throw new Error(
          completedChat.state.error?.message ?? "Workspace prompt failed",
          { cause: completedChat.state.error },
        );
      }
      assertNotAborted(signal);
      return await getLatestAssistantMessage(chatId);
    } finally {
      if (abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  };

  const context: DeterministicAgentContext = {
    workspace: {
      exec,
      prompt,
    },
    stdout: {
      write: (text: string) => output.append("stdout", "program", String(text)),
    },
    stderr: {
      write: (text: string) => output.append("stderr", "program", String(text)),
    },
    signal,
  };

  await program(context);
  assertNotAborted(signal);
  return output.run;
}
