import type { Agent, AgentConfig, AgentRun, AgentRunStatus } from "@/shared/agent";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import { isChatBusyStatus } from "@/shared/chat";
import { createInitialAgentState, isAgentRunActiveStatus } from "@/shared/agent";
import { createTimestamp } from "@/shared/events";
import { createLogger } from "@pablozaiden/webapp/server";
import { DomainError } from "./domain-error";
import { getWorkspace, touchWorkspace } from "../persistence/workspaces";
import {
  deleteAgent,
  deleteAgentRun,
  deleteAgentRuns,
  listAgentRuns,
  listAgents,
  listAgentsByWorkspace,
  listActiveAgentRuns,
  loadAgent,
  loadAgentRun,
  loadAgentRunSummary,
  saveAgent,
} from "../persistence/agents";
import { chatManager } from "./chat-manager";
import { agentRunner } from "./agent-runner";
import { managedContextIdentityResolver } from "./managed-context-identity";
import { managedCredentialService } from "./managed-credential-service";
import { calculateNextRunAt } from "./agent-schedule";
import { agentEventEmitter } from "./event-emitter";
import { normalizeAgentCode, validateDeterministicAgentCode } from "./deterministic-agent-code";
import {
  cleanupDeterministicAgentGenerationFiles,
  getGenerationSourceFilePath,
} from "./deterministic-agent-generation";
import { backendManager } from "./backend";
import type { CommandExecutor } from "./command-executor";
import { assertGitBackedWorkspace, isGitBackedWorkspace } from "./workspace-capabilities";

const INTERRUPT_CHAT_ID_WAIT_MS = 2000;
const INTERRUPT_CHAT_ID_POLL_MS = 50;
const log = createLogger("agent-manager");

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CreateAgentOptions {
  name: string;
  workspaceId: string;
  prompt: string;
  code?: string | null;
  model: AgentConfig["model"];
  baseBranch?: string;
  useWorktree: boolean;
  schedule: Omit<AgentConfig["schedule"], "nextRunAt"> & { nextRunAt?: string };
  enabled?: boolean;
}

export interface UpdateAgentOptions {
  name?: string;
  prompt?: string;
  code?: string | null;
  model?: AgentConfig["model"];
  baseBranch?: string | null;
  useWorktree?: boolean;
  schedule?: Omit<AgentConfig["schedule"], "nextRunAt"> & { nextRunAt?: string };
  enabled?: boolean;
  isPrivate?: boolean;
}

export interface ListAgentRunsOptions {
  limit?: number;
  offset?: number;
}

export interface PurgeAgentRunsOptions {
  before?: string;
  statuses?: AgentRunStatus[];
}

export class AgentManager {
  private async waitForInterruptibleRun(runId: string): Promise<AgentRun | null> {
    const deadline = Date.now() + INTERRUPT_CHAT_ID_WAIT_MS;
    while (Date.now() <= deadline) {
      const run = await loadAgentRun(runId);
      if (!run || !isAgentRunActiveStatus(run.status)) {
        return null;
      }
      if (run.chatId) {
        return run;
      }
      await delay(INTERRUPT_CHAT_ID_POLL_MS);
    }

    const run = await loadAgentRun(runId);
    if (!run || !isAgentRunActiveStatus(run.status)) {
      return null;
    }
    if (run.chatId) {
      return run;
    }
    return run;
  }

  async createAgent(options: CreateAgentOptions): Promise<Agent> {
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
    const now = createTimestamp();
    const nextRunAt = options.schedule.nextRunAt
      ?? calculateNextRunAt(options.schedule);
    const enabled = options.enabled ?? true;
    const code = normalizeAgentCode(options.code);
    const codeDiagnostics = code ? validateDeterministicAgentCode(code) : [];
    if (codeDiagnostics.length > 0) {
      throw new DomainError(
        "agent_code_invalid",
        "Agent code is invalid",
        { details: { diagnostics: codeDiagnostics } },
      );
    }
    const config: AgentConfig = {
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
      mode: "agent",
    };
    const agent: Agent = {
      config,
      state: {
        ...createInitialAgentState(config.id, enabled ? nextRunAt : undefined),
        status: enabled ? "enabled" : "paused",
      },
    };
    await saveAgent(agent);
    await touchWorkspace(options.workspaceId);
    agentEventEmitter.emit({
      type: "agent.created",
      agentId: agent.config.id,
      agent,
      timestamp: now,
    });
    return agent;
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    return loadAgent(agentId);
  }

  async getGenerationChat(agentId: string): Promise<Awaited<ReturnType<typeof chatManager.getChat>>> {
    const agent = await loadAgent(agentId);
    if (!agent?.config.generationChatId) {
      return null;
    }
    const chat = await chatManager.getChat(agent.config.generationChatId);
    if (chat) {
      return chat;
    }

    const updated: Agent = {
      config: {
        ...agent.config,
        generationChatId: undefined,
        updatedAt: createTimestamp(),
      },
      state: agent.state,
    };
    await saveAgent(updated);
    agentEventEmitter.emit({
      type: "agent.updated",
      agentId,
      agent: updated,
      timestamp: updated.config.updatedAt,
    });
    return null;
  }

  async resetGenerationChat(
    agentId: string,
    options: { model: AgentConfig["model"] },
  ): Promise<Awaited<ReturnType<typeof chatManager.createChat>>> {
    const agent = await loadAgent(agentId);
    if (!agent) {
      throw new DomainError("agent_not_found", "Agent not found", {
        details: { agentId },
      });
    }

    const previousChatId = agent.config.generationChatId;
    if (previousChatId) {
      const generationExecutor: CommandExecutor = await backendManager.getCommandExecutorAsync(
        agent.config.workspaceId,
        agent.config.directory,
      );
      const previousChat = await chatManager.getChat(previousChatId);
      if (previousChat && isChatBusyStatus(previousChat.state.status)) {
        try {
          await chatManager.interruptChat(previousChatId, "Generation conversation replaced");
        } catch (error) {
          log.warn("Failed to interrupt the previous deterministic agent generation chat", {
            agentId,
            chatId: previousChatId,
            error: String(error),
          });
        }
      }
      await cleanupDeterministicAgentGenerationFiles(
        agent.config.workspaceId,
        agent.config.directory,
        previousChatId,
        generationExecutor,
      );
      await chatManager.deleteChat(previousChatId);
    }

    const chat = await chatManager.createChat({
      name: `Generate code: ${agent.config.name}`,
      workspaceId: agent.config.workspaceId,
      scope: "agent",
      modelProviderID: options.model.providerID,
      modelID: options.model.modelID,
      modelVariant: options.model.variant,
      useWorktree: false,
      autoApprovePermissions: true,
      directory: agent.config.directory,
      syncBaseBranch: false,
      prepareWorktreeOnCreate: false,
    });
    const updated: Agent = {
      config: {
        ...agent.config,
        generationChatId: chat.config.id,
        updatedAt: createTimestamp(),
      },
      state: agent.state,
    };
    try {
      await saveAgent(updated);
    } catch (error) {
      await chatManager.deleteChat(chat.config.id);
      throw error;
    }
    agentEventEmitter.emit({
      type: "agent.updated",
      agentId,
      agent: updated,
      timestamp: updated.config.updatedAt,
    });
    return chat;
  }

  async getGenerationDraft(agentId: string): Promise<string | null> {
    const agent = await loadAgent(agentId);
    if (!agent?.config.generationChatId) {
      return null;
    }
    const chat = await this.getGenerationChat(agentId);
    if (!chat) {
      return null;
    }
    const executor = await backendManager.getCommandExecutorAsync(
      agent.config.workspaceId,
      agent.config.directory,
    );
    const source = await executor.readFile(
      getGenerationSourceFilePath(agent.config.directory, chat.config.id),
    );
    const trimmed = source?.trim();
    return trimmed ? trimmed : null;
  }

  async getAgents(workspaceId?: string): Promise<Agent[]> {
    return workspaceId ? listAgentsByWorkspace(workspaceId) : listAgents();
  }

  private async syncGenerationDraft(agent: Agent, code: string | undefined): Promise<void> {
    const chatId = agent.config.generationChatId;
    if (!chatId || !(await chatManager.getChat(chatId))) {
      return;
    }
    const executor = await backendManager.getCommandExecutorAsync(
      agent.config.workspaceId,
      agent.config.directory,
    );
    const sourcePath = getGenerationSourceFilePath(agent.config.directory, chatId);
    if (code) {
      if (!(await executor.writeFile(sourcePath, code))) {
        throw new DomainError("agent_generation_draft_sync_failed", "Could not save the generation draft");
      }
      return;
    }
    const result = await executor.exec("rm", ["-f", "--", sourcePath], {
      cwd: agent.config.directory,
      timeout: 10_000,
      logFailures: false,
    });
    if (!result.success) {
      throw new DomainError("agent_generation_draft_sync_failed", "Could not clear the generation draft");
    }
  }

  async updateAgent(agentId: string, updates: UpdateAgentOptions): Promise<Agent | null> {
    const agent = await loadAgent(agentId);
    if (!agent) {
      return null;
    }
    const workspace = await getWorkspace(agent.config.workspaceId);
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
    const nextSchedule = updates.schedule
      ? {
          ...updates.schedule,
          nextRunAt: updates.schedule.nextRunAt ?? calculateNextRunAt(updates.schedule),
        }
      : agent.config.schedule;
    const enabled = updates.enabled ?? agent.config.enabled;
    const code = updates.code === undefined
      ? agent.config.code
      : normalizeAgentCode(updates.code);
    const codeDiagnostics = code ? validateDeterministicAgentCode(code) : [];
    if (codeDiagnostics.length > 0) {
      throw new DomainError(
        "agent_code_invalid",
        "Agent code is invalid",
        { details: { diagnostics: codeDiagnostics } },
      );
    }
    const updated: Agent = {
      config: {
        ...agent.config,
        name: updates.name?.trim() ?? agent.config.name,
        prompt: updates.prompt ?? agent.config.prompt,
        code,
        model: updates.model ?? agent.config.model,
        baseBranch: workspace && !isGitBackedWorkspace(workspace)
          ? undefined
          : updates.baseBranch === null ? undefined : updates.baseBranch ?? agent.config.baseBranch,
        useWorktree: workspace && !isGitBackedWorkspace(workspace)
          ? false
          : updates.useWorktree ?? agent.config.useWorktree,
        schedule: nextSchedule,
        enabled,
        isPrivate: updates.isPrivate ?? agent.config.isPrivate,
        updatedAt: createTimestamp(),
      },
      state: {
        ...agent.state,
        status: agent.state.activeRunId ? "running" : enabled ? "enabled" : "paused",
        nextRunAt: enabled ? nextSchedule.nextRunAt : undefined,
      },
    };
    if (updates.code !== undefined) {
      await this.syncGenerationDraft(agent, code);
    }
    await saveAgent(updated);
    agentEventEmitter.emit({
      type: "agent.updated",
      agentId,
      agent: updated,
      timestamp: createTimestamp(),
    });
    return updated;
  }

  async pauseAgent(agentId: string): Promise<Agent | null> {
    return this.updateAgent(agentId, { enabled: false });
  }

  async resumeAgent(agentId: string): Promise<Agent | null> {
    const agent = await loadAgent(agentId);
    if (!agent) {
      return null;
    }
    return this.updateAgent(agentId, {
      enabled: true,
      schedule: {
        ...agent.config.schedule,
        nextRunAt: calculateNextRunAt(agent.config.schedule),
      },
    });
  }

  async runNow(agentId: string, attachments: MessageImageAttachment[] = []): Promise<AgentRun> {
    const agent = await loadAgent(agentId);
    if (!agent) {
      throw new DomainError("agent_not_found", "Agent not found", {
        details: { agentId },
      });
    }
    const activeRuns = await listActiveAgentRuns(agentId);
    if (activeRuns.length > 0 || agent.state.activeRunId) {
      throw new DomainError("agent_already_running", "Agent already has an active run", {
        details: { agentId },
      });
    }
    return agentRunner.startAgentRun(agent, "manual", { attachments });
  }

  async interruptAgent(agentId: string, reason?: string): Promise<AgentRun | null> {
    const agent = await loadAgent(agentId);
    if (!agent?.state.activeRunId) {
      return null;
    }
    const run = await this.waitForInterruptibleRun(agent.state.activeRunId);
    if (!run) {
      return null;
    }
    const interrupted = await agentRunner.interruptRun(run, reason);
    await saveAgent({
      config: {
        ...agent.config,
        updatedAt: createTimestamp(),
      },
      state: {
        ...agent.state,
        status: agent.config.enabled ? "enabled" : "paused",
        activeRunId: undefined,
      },
    });
    agentEventEmitter.emit({
      type: "agent.run.interrupted",
      agentId,
      agentRunId: interrupted.id,
      timestamp: createTimestamp(),
    });
    return interrupted;
  }

  async listRuns(agentId: string, options: ListAgentRunsOptions = {}): Promise<AgentRun[]> {
    return listAgentRuns(agentId, options);
  }

  async getRun(runId: string): Promise<AgentRun | null> {
    return loadAgentRun(runId);
  }

  async getRunSummary(runId: string): Promise<AgentRun | null> {
    return loadAgentRunSummary(runId);
  }

  async deleteRun(runId: string): Promise<boolean> {
    const run = await loadAgentRun(runId);
    if (!run) {
      return false;
    }
    const identity = await managedContextIdentityResolver.forAgentRun(
      run.id,
      run.configSnapshot.workspaceId,
    );
    await managedCredentialService.revokeContextIfConfigured(identity);
    await chatManager.deleteChat(run.chatId ?? run.id);
    const deleted = await deleteAgentRun(runId);
    if (deleted) {
      agentEventEmitter.emit({
        type: "agent.run.deleted",
        agentId: run.agentId,
        agentRunId: runId,
        timestamp: createTimestamp(),
      });
    }
    return deleted;
  }

  async purgeRuns(agentId: string, options: PurgeAgentRunsOptions = {}): Promise<string[]> {
    const runs = await listAgentRuns(agentId, { limit: 10000, offset: 0 });
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
      const identity = await managedContextIdentityResolver.forAgentRun(
        run.id,
        run.configSnapshot.workspaceId,
      );
      await managedCredentialService.revokeContextIfConfigured(identity);
      await chatManager.deleteChat(run.chatId ?? run.id);
    }
    const deletedRunIds = await deleteAgentRuns(agentId, {
      before: options.before,
      statuses: options.statuses,
    });
    if (deletedRunIds.length > 0) {
      agentEventEmitter.emit({
        type: "agent.runs.purged",
        agentId,
        deletedRunIds,
        timestamp: createTimestamp(),
      });
    }
    return deletedRunIds;
  }

  async deleteAgent(agentId: string): Promise<boolean> {
    const agent = await loadAgent(agentId);
    if (!agent) {
      return false;
    }
    const runs = await listAgentRuns(agentId, { limit: 10000, offset: 0 });
    for (const run of runs) {
      if (run.status === "starting" || run.status === "running" || run.status === "scheduled") {
        await agentRunner.interruptRun(run, "Agent deleted");
      }
      const identity = await managedContextIdentityResolver.forAgentRun(
        run.id,
        run.configSnapshot.workspaceId,
      );
      await managedCredentialService.revokeContextIfConfigured(identity);
      await chatManager.deleteChat(run.chatId ?? run.id);
    }
    if (agent.config.generationChatId) {
      const generationExecutor = await backendManager.getCommandExecutorAsync(
        agent.config.workspaceId,
        agent.config.directory,
      );
      const generationChat = await chatManager.getChat(agent.config.generationChatId);
      if (generationChat && isChatBusyStatus(generationChat.state.status)) {
        try {
          await chatManager.interruptChat(agent.config.generationChatId, "Agent deleted");
        } catch (error) {
          log.warn("Failed to interrupt deterministic agent generation chat during agent deletion", {
            agentId,
            chatId: agent.config.generationChatId,
            error: String(error),
          });
        }
      }
      await cleanupDeterministicAgentGenerationFiles(
        agent.config.workspaceId,
        agent.config.directory,
        agent.config.generationChatId,
        generationExecutor,
      );
      await chatManager.deleteChat(agent.config.generationChatId);
    }
    const deleted = await deleteAgent(agentId);
    if (deleted) {
      agentEventEmitter.emit({
        type: "agent.deleted",
        agentId,
        timestamp: createTimestamp(),
      });
    }
    return deleted;
  }
}

export const agentManager = new AgentManager();
