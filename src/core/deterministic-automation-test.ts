import type { DeterministicAutomationTestResult } from "@/shared/deterministic-automation";
import type { AutomationRun } from "@/shared/automation";
import type { ModelConfig } from "@/shared/model";
import type { ConversationLogEntry } from "@/shared/conversation";
import { createLogger } from "@pablozaiden/webapp/server";
import { createTimestamp } from "@/shared/events";
import { chatManager } from "./chat-manager";
import { validateDeterministicAutomationCode } from "./deterministic-automation-code";
import { DeterministicAutomationOutput } from "./deterministic-automation-output";
import { executeDeterministicAutomation } from "./deterministic-automation-runtime";
import { managedContextIdentityResolver } from "./managed-context-identity";
import { getWorkspace } from "../persistence/workspaces";
import { assertWorktreesAllowed } from "./workspace-capabilities";

const log = createLogger("deterministic-automation-test");

export interface TestDeterministicAutomationCodeOptions {
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
  onOutput?: (entry: ConversationLogEntry) => void;
}

function createTestRun(options: TestDeterministicAutomationCodeOptions): AutomationRun {
  const now = createTimestamp();
  return {
    id: crypto.randomUUID(),
    automationId: crypto.randomUUID(),
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

export async function testDeterministicAutomationCode(
  options: TestDeterministicAutomationCodeOptions,
): Promise<DeterministicAutomationTestResult> {
  const diagnostics = validateDeterministicAutomationCode(options.code);
  if (diagnostics.length > 0) {
    return {
      status: "failed",
      logs: [],
      error: "Automation code is invalid",
      diagnostics,
    };
  }

  const run = createTestRun(options);
  const output = new DeterministicAutomationOutput(run, {
    persist: false,
    emit: Boolean(options.userId),
    userId: options.userId,
    eventAutomationRunId: options.testRunId,
    onAppend: options.onOutput,
  });
  const signal = options.signal ?? new AbortController().signal;
  let chatId: string | undefined;

  try {
    if (options.useWorktree) {
      const workspace = await getWorkspace(options.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${options.workspaceId}`);
      }
      assertWorktreesAllowed(workspace);
    }
    const chat = await chatManager.createAutomationRunChat({
      name: `Test code: ${options.name}`,
      workspaceId: options.workspaceId,
      modelProviderID: options.model.providerID,
      modelID: options.model.modelID,
      modelVariant: options.model.variant,
      useWorktree: options.useWorktree,
      baseBranch: options.baseBranch,
      directory: options.directory,
      syncBaseBranch: true,
      prepareWorktreeOnCreate: true,
    });
    chatId = chat.config.id;
    if (signal.aborted) {
      throw new Error("Deterministic automation run interrupted", { cause: "aborted" });
    }
    const managedContextIdentity = await managedContextIdentityResolver.forChat(
      chatId,
      options.workspaceId,
    );

    const completed = await executeDeterministicAutomation({
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
        log.warn("Failed to clean up deterministic automation test chat", {
          chatId,
          error: String(error),
        });
      }
    }
  }
}
