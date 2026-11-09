import type { Automation, AutomationConfig, AutomationRun, AutomationRunStatus } from "@/shared/automation";
import type { MessageAttachment } from "@/shared/message-attachments";
import { isChatBusyStatus } from "@/shared/chat";
import { createInitialAutomationState, isAutomationRunActiveStatus } from "@/shared/automation";
import { createTimestamp } from "@/shared/events";
import { createLogger } from "@pablozaiden/webapp/server";
import { DomainError } from "../domain/domain-error";
import { getWorkspace, touchWorkspace } from "../persistence/workspaces";
import {
  deleteAutomation,
  deleteAutomationRun,
  deleteAutomationRuns,
  listAutomationRuns,
  listAutomations,
  listAutomationsByWorkspace,
  listActiveAutomationRuns,
  loadAutomation,
  loadAutomationRun,
  loadAutomationRunSummary,
  saveAutomation,
} from "../persistence/automations";
import { chatManager } from "./chat-manager";
import { automationRunner } from "./automation-runner";
import { managedContextIdentityResolver } from "./managed-context-identity";
import { managedCredentialService } from "./managed-credential-service";
import { calculateNextRunAt } from "./automation-schedule";
import { automationEventEmitter } from "./event-emitter";
import { normalizeAutomationCode, validateDeterministicAutomationCode } from "./deterministic-automation-code";
import {
  cleanupDeterministicAutomationGenerationFiles,
  getGenerationSourceFilePath,
} from "./deterministic-automation-generation";
import { backendManager } from "./backend";
import type { CommandExecutor } from "./command-executor";
import {
  assertGitBackedWorkspace,
  assertWorktreesAllowed,
  isGitBackedWorkspace,
} from "./workspace-capabilities";

const INTERRUPT_CHAT_ID_WAIT_MS = 2000;
const INTERRUPT_CHAT_ID_POLL_MS = 50;
const log = createLogger("automation-manager");

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CreateAutomationOptions {
  name: string;
  workspaceId: string;
  prompt: string;
  code?: string | null;
  model: AutomationConfig["model"];
  baseBranch?: string;
  useWorktree: boolean;
  schedule: Omit<AutomationConfig["schedule"], "nextRunAt"> & { nextRunAt?: string };
  enabled?: boolean;
}

export interface UpdateAutomationOptions {
  name?: string;
  prompt?: string;
  code?: string | null;
  model?: AutomationConfig["model"];
  baseBranch?: string | null;
  useWorktree?: boolean;
  schedule?: Omit<AutomationConfig["schedule"], "nextRunAt"> & { nextRunAt?: string };
  enabled?: boolean;
  isPrivate?: boolean;
}

export interface ListAutomationRunsOptions {
  limit?: number;
  offset?: number;
}

export interface PurgeAutomationRunsOptions {
  before?: string;
  statuses?: AutomationRunStatus[];
}

export class AutomationManager {
  private async waitForInterruptibleRun(runId: string): Promise<AutomationRun | null> {
    const deadline = Date.now() + INTERRUPT_CHAT_ID_WAIT_MS;
    while (Date.now() <= deadline) {
      const run = await loadAutomationRun(runId);
      if (!run || !isAutomationRunActiveStatus(run.status)) {
        return null;
      }
      if (run.chatId) {
        return run;
      }
      await delay(INTERRUPT_CHAT_ID_POLL_MS);
    }

    const run = await loadAutomationRun(runId);
    if (!run || !isAutomationRunActiveStatus(run.status)) {
      return null;
    }
    if (run.chatId) {
      return run;
    }
    return run;
  }

  async createAutomation(options: CreateAutomationOptions): Promise<Automation> {
    const workspace = await getWorkspace(options.workspaceId);
    if (!workspace) {
      throw new DomainError("workspace_not_found", "Workspace not found", {
        details: { workspaceId: options.workspaceId },
      });
    }
    if (
      !isGitBackedWorkspace(workspace)
      && (options.useWorktree || options.baseBranch !== undefined)
    ) {
      assertGitBackedWorkspace(
        workspace,
        "Directory workspaces do not support branches or worktrees.",
      );
    }
    if (options.useWorktree) {
      assertWorktreesAllowed(workspace);
    }
    const now = createTimestamp();
    const nextRunAt = options.schedule.nextRunAt
      ?? calculateNextRunAt(options.schedule);
    const enabled = options.enabled ?? true;
    const code = normalizeAutomationCode(options.code);
    const codeDiagnostics = code ? validateDeterministicAutomationCode(code) : [];
    if (codeDiagnostics.length > 0) {
      throw new DomainError(
        "automation_code_invalid",
        "Automation code is invalid",
        { details: { diagnostics: codeDiagnostics } },
      );
    }
    const config: AutomationConfig = {
      id: crypto.randomUUID(),
      name: options.name.trim(),
      workspaceId: options.workspaceId,
      directory: workspace.directory,
      prompt: options.prompt,
      code,
      model: options.model,
      baseBranch: isGitBackedWorkspace(workspace) ? options.baseBranch : undefined,
      useWorktree: isGitBackedWorkspace(workspace) ? options.useWorktree : false,
      schedule: {
        ...options.schedule,
        nextRunAt,
      },
      enabled,
      createdAt: now,
      updatedAt: now,
      mode: "automation",
    };
    const automation: Automation = {
      config,
      state: {
        ...createInitialAutomationState(config.id, enabled ? nextRunAt : undefined),
        status: enabled ? "enabled" : "paused",
      },
    };
    await saveAutomation(automation);
    await touchWorkspace(options.workspaceId);
    automationEventEmitter.emit({
      type: "automation.created",
      automationId: automation.config.id,
      automation,
      timestamp: now,
    });
    return automation;
  }

  async getAutomation(automationId: string): Promise<Automation | null> {
    return loadAutomation(automationId);
  }

  async getGenerationChat(automationId: string): Promise<Awaited<ReturnType<typeof chatManager.getChat>>> {
    const automation = await loadAutomation(automationId);
    if (!automation?.config.generationChatId) {
      return null;
    }
    const chat = await chatManager.getChat(automation.config.generationChatId);
    if (chat) {
      return chat;
    }

    const updated: Automation = {
      config: {
        ...automation.config,
        generationChatId: undefined,
        updatedAt: createTimestamp(),
      },
      state: automation.state,
    };
    await saveAutomation(updated);
    automationEventEmitter.emit({
      type: "automation.updated",
      automationId,
      automation: updated,
      timestamp: updated.config.updatedAt,
    });
    return null;
  }

  async resetGenerationChat(
    automationId: string,
    options: { model: AutomationConfig["model"] },
  ): Promise<Awaited<ReturnType<typeof chatManager.createChat>>> {
    const automation = await loadAutomation(automationId);
    if (!automation) {
      throw new DomainError("automation_not_found", "Automation not found", {
        details: { automationId },
      });
    }

    const previousChatId = automation.config.generationChatId;
    if (previousChatId) {
      const generationExecutor: CommandExecutor = await backendManager.getCommandExecutorAsync(
        automation.config.workspaceId,
        automation.config.directory,
      );
      const previousChat = await chatManager.getChat(previousChatId);
      if (previousChat && isChatBusyStatus(previousChat.state.status)) {
        try {
          await chatManager.interruptChat(previousChatId, "Generation conversation replaced");
        } catch (error) {
          log.warn("Failed to interrupt the previous deterministic automation generation chat", {
            automationId,
            chatId: previousChatId,
            error: String(error),
          });
        }
      }
      await cleanupDeterministicAutomationGenerationFiles(
        automation.config.workspaceId,
        automation.config.directory,
        previousChatId,
        generationExecutor,
      );
      await chatManager.deleteChat(previousChatId);
    }

    const chat = await chatManager.createChat({
      name: `Generate code: ${automation.config.name}`,
      workspaceId: automation.config.workspaceId,
      scope: "automation",
      modelProviderID: options.model.providerID,
      modelID: options.model.modelID,
      modelVariant: options.model.variant,
      useWorktree: false,
      directory: automation.config.directory,
      syncBaseBranch: false,
      prepareWorktreeOnCreate: false,
    });
    const updated: Automation = {
      config: {
        ...automation.config,
        generationChatId: chat.config.id,
        updatedAt: createTimestamp(),
      },
      state: automation.state,
    };
    try {
      await saveAutomation(updated);
    } catch (error) {
      await chatManager.deleteChat(chat.config.id);
      throw error;
    }
    automationEventEmitter.emit({
      type: "automation.updated",
      automationId,
      automation: updated,
      timestamp: updated.config.updatedAt,
    });
    return chat;
  }

  async getGenerationDraft(automationId: string): Promise<string | null> {
    const automation = await loadAutomation(automationId);
    if (!automation?.config.generationChatId) {
      return null;
    }
    const chat = await this.getGenerationChat(automationId);
    if (!chat) {
      return null;
    }
    const executor = await backendManager.getCommandExecutorAsync(
      automation.config.workspaceId,
      automation.config.directory,
    );
    const source = await executor.readFile(
      getGenerationSourceFilePath(automation.config.directory, chat.config.id),
    );
    const trimmed = source?.trim();
    return trimmed ? trimmed : null;
  }

  async getAutomations(workspaceId?: string): Promise<Automation[]> {
    return workspaceId ? listAutomationsByWorkspace(workspaceId) : listAutomations();
  }

  private async syncGenerationDraft(automation: Automation, code: string | undefined): Promise<void> {
    const chatId = automation.config.generationChatId;
    if (!chatId || !(await chatManager.getChat(chatId))) {
      return;
    }
    const executor = await backendManager.getCommandExecutorAsync(
      automation.config.workspaceId,
      automation.config.directory,
    );
    const sourcePath = getGenerationSourceFilePath(automation.config.directory, chatId);
    if (code) {
      if (!(await executor.writeFile(sourcePath, code))) {
        throw new DomainError("automation_generation_draft_sync_failed", "Could not save the generation draft");
      }
      return;
    }
    const result = await executor.exec("rm", ["-f", "--", sourcePath], {
      cwd: automation.config.directory,
      timeout: 10_000,
      logFailures: false,
    });
    if (!result.success) {
      throw new DomainError("automation_generation_draft_sync_failed", "Could not clear the generation draft");
    }
  }

  async updateAutomation(automationId: string, updates: UpdateAutomationOptions): Promise<Automation | null> {
    const automation = await loadAutomation(automationId);
    if (!automation) {
      return null;
    }
    const workspace = await getWorkspace(automation.config.workspaceId);
    if (
      workspace
      && !isGitBackedWorkspace(workspace)
      && (updates.useWorktree === true || updates.baseBranch !== undefined && updates.baseBranch !== null)
    ) {
      assertGitBackedWorkspace(
        workspace,
        "Directory workspaces do not support branches or worktrees.",
      );
    }
    if (
      workspace
      && updates.useWorktree === true
      && automation.config.useWorktree !== true
    ) {
      assertWorktreesAllowed(workspace);
    }
    const nextSchedule = updates.schedule
      ? {
          ...updates.schedule,
          nextRunAt: updates.schedule.nextRunAt ?? calculateNextRunAt(updates.schedule),
        }
      : automation.config.schedule;
    const enabled = updates.enabled ?? automation.config.enabled;
    const code = updates.code === undefined
      ? automation.config.code
      : normalizeAutomationCode(updates.code);
    const codeDiagnostics = code ? validateDeterministicAutomationCode(code) : [];
    if (codeDiagnostics.length > 0) {
      throw new DomainError(
        "automation_code_invalid",
        "Automation code is invalid",
        { details: { diagnostics: codeDiagnostics } },
      );
    }
    const updated: Automation = {
      config: {
        ...automation.config,
        name: updates.name?.trim() ?? automation.config.name,
        prompt: updates.prompt ?? automation.config.prompt,
        code,
        model: updates.model ?? automation.config.model,
        baseBranch: workspace && !isGitBackedWorkspace(workspace)
          ? undefined
          : updates.baseBranch === null ? undefined : updates.baseBranch ?? automation.config.baseBranch,
        useWorktree: workspace && !isGitBackedWorkspace(workspace)
          ? false
          : updates.useWorktree ?? automation.config.useWorktree,
        schedule: nextSchedule,
        enabled,
        isPrivate: updates.isPrivate ?? automation.config.isPrivate,
        updatedAt: createTimestamp(),
      },
      state: {
        ...automation.state,
        status: automation.state.activeRunId ? "running" : enabled ? "enabled" : "paused",
        nextRunAt: enabled ? nextSchedule.nextRunAt : undefined,
      },
    };
    if (updates.code !== undefined) {
      await this.syncGenerationDraft(automation, code);
    }
    await saveAutomation(updated);
    automationEventEmitter.emit({
      type: "automation.updated",
      automationId,
      automation: updated,
      timestamp: createTimestamp(),
    });
    return updated;
  }

  async pauseAutomation(automationId: string): Promise<Automation | null> {
    return this.updateAutomation(automationId, { enabled: false });
  }

  async resumeAutomation(automationId: string): Promise<Automation | null> {
    const automation = await loadAutomation(automationId);
    if (!automation) {
      return null;
    }
    return this.updateAutomation(automationId, {
      enabled: true,
      schedule: {
        ...automation.config.schedule,
        nextRunAt: calculateNextRunAt(automation.config.schedule),
      },
    });
  }

  async runNow(automationId: string, attachments: MessageAttachment[] = []): Promise<AutomationRun> {
    const automation = await loadAutomation(automationId);
    if (!automation) {
      throw new DomainError("automation_not_found", "Automation not found", {
        details: { automationId },
      });
    }
    const activeRuns = await listActiveAutomationRuns(automationId);
    if (activeRuns.length > 0 || automation.state.activeRunId) {
      throw new DomainError("automation_already_running", "Automation already has an active run", {
        details: { automationId },
      });
    }
    return automationRunner.startAutomationRun(automation, "manual", { attachments });
  }

  async interruptAutomation(automationId: string, reason?: string): Promise<AutomationRun | null> {
    const automation = await loadAutomation(automationId);
    if (!automation?.state.activeRunId) {
      return null;
    }
    const run = await this.waitForInterruptibleRun(automation.state.activeRunId);
    if (!run) {
      return null;
    }
    const interrupted = await automationRunner.interruptRun(run, reason);
    await saveAutomation({
      config: {
        ...automation.config,
        updatedAt: createTimestamp(),
      },
      state: {
        ...automation.state,
        status: automation.config.enabled ? "enabled" : "paused",
        activeRunId: undefined,
      },
    });
    automationEventEmitter.emit({
      type: "automation.run.interrupted",
      automationId,
      automationRunId: interrupted.id,
      timestamp: createTimestamp(),
    });
    return interrupted;
  }

  async listRuns(automationId: string, options: ListAutomationRunsOptions = {}): Promise<AutomationRun[]> {
    return listAutomationRuns(automationId, options);
  }

  async getRun(runId: string): Promise<AutomationRun | null> {
    return loadAutomationRun(runId);
  }

  async getRunSummary(runId: string): Promise<AutomationRun | null> {
    return loadAutomationRunSummary(runId);
  }

  async deleteRun(runId: string): Promise<boolean> {
    const run = await loadAutomationRun(runId);
    if (!run) {
      return false;
    }
    const identity = await managedContextIdentityResolver.forAutomationRun(
      run.id,
      run.configSnapshot.workspaceId,
    );
    await managedCredentialService.revokeContextIfConfigured(identity);
    await chatManager.deleteChat(run.chatId ?? run.id);
    const deleted = await deleteAutomationRun(runId);
    if (deleted) {
      automationEventEmitter.emit({
        type: "automation.run.deleted",
        automationId: run.automationId,
        automationRunId: runId,
        timestamp: createTimestamp(),
      });
    }
    return deleted;
  }

  async purgeRuns(automationId: string, options: PurgeAutomationRunsOptions = {}): Promise<string[]> {
    const runs = await listAutomationRuns(automationId, { limit: 10000, offset: 0 });
    const selectedRuns = runs.filter((run) => {
      if (options.before && run.createdAt >= options.before) {
        return false;
      }
      if (options.statuses && options.statuses.length > 0 && !options.statuses.includes(run.status)) {
        return false;
      }
      return run.status !== "starting" && run.status !== "running" && run.status !== "scheduled";
    });
    for (const run of selectedRuns) {
      const identity = await managedContextIdentityResolver.forAutomationRun(
        run.id,
        run.configSnapshot.workspaceId,
      );
      await managedCredentialService.revokeContextIfConfigured(identity);
      await chatManager.deleteChat(run.chatId ?? run.id);
    }
    const deletedRunIds = await deleteAutomationRuns(automationId, {
      before: options.before,
      statuses: options.statuses,
    });
    if (deletedRunIds.length > 0) {
      automationEventEmitter.emit({
        type: "automation.runs.purged",
        automationId,
        deletedRunIds,
        timestamp: createTimestamp(),
      });
    }
    return deletedRunIds;
  }

  async deleteAutomation(automationId: string): Promise<boolean> {
    const automation = await loadAutomation(automationId);
    if (!automation) {
      return false;
    }
    const runs = await listAutomationRuns(automationId, { limit: 10000, offset: 0 });
    for (const run of runs) {
      if (run.status === "starting" || run.status === "running" || run.status === "scheduled") {
        await automationRunner.interruptRun(run, "Automation deleted");
      }
      const identity = await managedContextIdentityResolver.forAutomationRun(
        run.id,
        run.configSnapshot.workspaceId,
      );
      await managedCredentialService.revokeContextIfConfigured(identity);
      await chatManager.deleteChat(run.chatId ?? run.id);
    }
    if (automation.config.generationChatId) {
      const generationExecutor = await backendManager.getCommandExecutorAsync(
        automation.config.workspaceId,
        automation.config.directory,
      );
      const generationChat = await chatManager.getChat(automation.config.generationChatId);
      if (generationChat && isChatBusyStatus(generationChat.state.status)) {
        try {
          await chatManager.interruptChat(automation.config.generationChatId, "Automation deleted");
        } catch (error) {
          log.warn("Failed to interrupt deterministic automation generation chat during automation deletion", {
            automationId,
            chatId: automation.config.generationChatId,
            error: String(error),
          });
        }
      }
      await cleanupDeterministicAutomationGenerationFiles(
        automation.config.workspaceId,
        automation.config.directory,
        automation.config.generationChatId,
        generationExecutor,
      );
      await chatManager.deleteChat(automation.config.generationChatId);
    }
    const deleted = await deleteAutomation(automationId);
    if (deleted) {
      automationEventEmitter.emit({
        type: "automation.deleted",
        automationId,
        workspaceId: automation.config.workspaceId,
        timestamp: createTimestamp(),
      });
    }
    return deleted;
  }
}

export const automationManager = new AutomationManager();
