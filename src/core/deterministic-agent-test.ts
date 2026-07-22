import type { DeterministicAgentTestResult } from "@/shared/deterministic-agent";
import type { AgentRun } from "@/shared/agent";
import type { ModelConfig } from "@/shared/model";
import type { TaskLogEntry } from "@/shared/task";
import { createLogger } from "@pablozaiden/webapp/server";
import { createTimestamp } from "@/shared/events";
import { chatManager } from "./chat-manager";
import { validateDeterministicAgentCode } from "./deterministic-agent-code";
import { DeterministicAgentOutput } from "./deterministic-agent-output";
import { executeDeterministicAgent } from "./deterministic-agent-runtime";
import { managedContextIdentityResolver } from "./managed-context-identity";

const log = createLogger("deterministic-agent-test");

export interface TestDeterministicAgentCodeOptions {
  name: string;
  prompt: string;
  code: string;
  workspaceId: string;
  directory: string;
  model: ModelConfig;
  baseBranch?: string;
  useWorktree: boolean;
  testRunId?: string;
  userId?: string;
  signal?: AbortSignal;
  onOutput?: (entry: TaskLogEntry) => void;
}

function createTestRun(options: TestDeterministicAgentCodeOptions): AgentRun {
  const now = createTimestamp();
  return {
    id: options.testRunId ?? crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    status: "starting",
    trigger: "manual",
    scheduledFor: now,
    messages: [],
    logs: [],
    toolCalls: [],
    pendingPermissionRequests: [],
    configSnapshot: {
      name: options.name,
      workspaceId: options.workspaceId,
      directory: options.directory,
      prompt: options.prompt,
      code: options.code,
      model: options.model,
      baseBranch: options.baseBranch,
      useWorktree: options.useWorktree,
      schedule: {
        startAtLocal: now.slice(0, 16),
        timezone: "UTC",
        interval: {
          value: 1,
          unit: "minutes",
        },
        nextRunAt: now,
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function testDeterministicAgentCode(
  options: TestDeterministicAgentCodeOptions,
): Promise<DeterministicAgentTestResult> {
  const diagnostics = validateDeterministicAgentCode(options.code);
  if (diagnostics.length > 0) {
    return {
      status: "failed",
      logs: [],
      error: "Agent code is invalid",
      diagnostics,
    };
  }

  const run = createTestRun(options);
  const output = new DeterministicAgentOutput(run, {
    persist: false,
    emit: Boolean(options.userId),
    userId: options.userId,
    onAppend: options.onOutput,
  });
  const signal = options.signal ?? new AbortController().signal;
  let chatId: string | undefined;

  try {
    const chat = await chatManager.createChat({
      name: `Test code: ${options.name}`,
      workspaceId: options.workspaceId,
      scope: "workspace",
      modelProviderID: options.model.providerID,
      modelID: options.model.modelID,
      modelVariant: options.model.variant,
      autoApprovePermissions: true,
      useWorktree: options.useWorktree,
      baseBranch: options.baseBranch,
      directory: options.directory,
      syncBaseBranch: true,
      prepareWorktreeOnCreate: true,
    });
    chatId = chat.config.id;
    if (signal.aborted) {
      throw new Error("Deterministic agent run interrupted", { cause: "aborted" });
    }
    const managedContextIdentity = await managedContextIdentityResolver.forChat(
      chatId,
      options.workspaceId,
    );

    const completed = await executeDeterministicAgent({
      run,
      code: options.code,
      chatId,
      workspaceId: options.workspaceId,
      directory: chat.state.worktree?.worktreePath ?? chat.config.directory,
      signal,
      output,
      managedContextIdentity,
    });
    return {
      status: "completed",
      logs: completed.logs,
      diagnostics: [],
    };
  } catch (error) {
    if (signal.aborted) {
      return {
        status: "cancelled",
        logs: output.run.logs,
        diagnostics: [],
      };
    }
    return {
      status: "failed",
      logs: output.run.logs,
      error: getErrorMessage(error),
      diagnostics: [],
    };
  } finally {
    if (chatId) {
      try {
        await chatManager.deleteChat(chatId);
      } catch (error) {
        log.warn("Failed to clean up deterministic agent test chat", {
          chatId,
          error: String(error),
        });
      }
    }
  }
}
