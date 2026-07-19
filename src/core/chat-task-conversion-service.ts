/**
 * Chat transcript and planning-file conversion into plan-mode tasks.
 */

import type { Chat, Task } from "@/shared";
import { ChatBusyError, isAgentChat, isChatBusyStatus } from "@/shared/chat";
import { backendManager } from "./backend";
import { GitService } from "./git";
import { taskManager, type TaskManager } from "./task-manager";
import type { ChatTaskConversionPort, ChatStatePort, ChatWorktreePort } from "./chat-service-contracts";
import { buildSeededPlanStatusContent, readValidatedPlanningFiles } from "./planning-file-service";
import {
  buildSpawnCurrentPlanPrompt,
  buildSpawnTaskNameFromChat,
  buildSpawnTaskNameFromCurrentPlan,
  buildSpawnTaskPrompt,
} from "../utils/chat-to-task-prompt";
import { createLogger } from "@pablozaiden/webapp/server";

const log = createLogger("chat-task-conversion-service");

export interface ChatTaskConversionServiceDependencies {
  state: ChatStatePort;
  worktree: ChatWorktreePort;
  taskManager?: Pick<
    TaskManager,
    "createTask" | "startPlanMode" | "saveLastUsedModel" | "seedPlanFiles" | "deleteTask" | "getTask"
  >;
  executorProvider?: Pick<typeof backendManager, "getCommandExecutorAsync">;
}

export class ChatTaskConversionService implements ChatTaskConversionPort {
  private readonly state: ChatStatePort;
  private readonly worktree: ChatWorktreePort;
  private readonly taskManager: Pick<
    TaskManager,
    "createTask" | "startPlanMode" | "saveLastUsedModel" | "seedPlanFiles" | "deleteTask" | "getTask"
  >;
  private readonly executorProvider: Pick<typeof backendManager, "getCommandExecutorAsync">;

  constructor(dependencies: ChatTaskConversionServiceDependencies) {
    this.state = dependencies.state;
    this.worktree = dependencies.worktree;
    this.taskManager = dependencies.taskManager ?? taskManager;
    this.executorProvider = dependencies.executorProvider ?? backendManager;
  }

  async spawnTaskFromChat(chatId: string): Promise<Task> {
    const chat = await this.state.getChat(chatId);
    if (!chat) {
      throw new Error(`Chat not found: ${chatId}`);
    }
    this.assertChatIsAvailable(chat);
    if (isAgentChat(chat)) {
      throw new Error("Agent run chats cannot be spawned into tasks");
    }

    const executor = await this.executorProvider.getCommandExecutorAsync(chat.config.workspaceId, chat.config.directory);
    const git = GitService.withExecutor(executor);
    const baseBranch = chat.state.worktree?.originalBranch
      ?? chat.config.baseBranch
      ?? await git.getDefaultBranch(chat.config.directory);

    const prompt = buildSpawnTaskPrompt(chat.config.name, chat.state.messages);

    await this.state.touchWorkspace(chat.config.workspaceId);

    const task = await this.taskManager.createTask({
      name: buildSpawnTaskNameFromChat(chat.config.name, chat.state.messages),
      directory: chat.config.directory,
      prompt,
      workspaceId: chat.config.workspaceId,
      modelProviderID: chat.config.model.providerID,
      modelID: chat.config.model.modelID,
      modelVariant: chat.config.model.variant,
      baseBranch,
      useWorktree: chat.config.useWorktree,
      planMode: true,
      autoAcceptPlan: false,
      fullyAutonomous: false,
    });

    try {
      await this.taskManager.startPlanMode(task.config.id);
      await this.taskManager.saveLastUsedModel(chat.config.model);
    } catch (error) {
      try {
        await this.taskManager.deleteTask(task.config.id);
      } catch (cleanupError) {
        log.warn("Failed to clean up spawned task after plan-mode start failure", {
          taskId: task.config.id,
          chatId,
          error: String(cleanupError),
        });
      }
      throw new Error("Failed to start spawned task in plan mode", { cause: error });
    }

    return await this.taskManager.getTask(task.config.id) ?? task;
  }

  async spawnTaskFromCurrentPlan(chatId: string, planFilePath?: string): Promise<Task> {
    const chat = await this.state.getChat(chatId);
    if (!chat) {
      throw new Error(`Chat not found: ${chatId}`);
    }
    this.assertChatIsAvailable(chat);
    if (isAgentChat(chat)) {
      throw new Error("Agent run chats cannot be spawned into tasks");
    }

    const working = await this.worktree.resolveWorkingDirectory(chat, {
      prepareWorkspace: !this.worktree.hasEstablishedWorkspaceContext(chat),
    });
    const workingExecutor = await this.executorProvider.getCommandExecutorAsync(
      working.chat.config.workspaceId,
      working.directory,
    );
    const currentPlan = await readValidatedPlanningFiles(workingExecutor, working.directory, planFilePath);

    const executor = await this.executorProvider.getCommandExecutorAsync(chat.config.workspaceId, chat.config.directory);
    const git = GitService.withExecutor(executor);
    const baseBranch = working.chat.state.worktree?.originalBranch
      ?? working.chat.config.baseBranch
      ?? await git.getDefaultBranch(working.chat.config.directory);

    const prompt = buildSpawnCurrentPlanPrompt();

    await this.state.touchWorkspace(working.chat.config.workspaceId);

    const task = await this.taskManager.createTask({
      name: buildSpawnTaskNameFromCurrentPlan(
        working.chat.config.name,
        working.chat.state.messages,
        currentPlan.planContent,
      ),
      directory: working.chat.config.directory,
      prompt,
      workspaceId: working.chat.config.workspaceId,
      modelProviderID: working.chat.config.model.providerID,
      modelID: working.chat.config.model.modelID,
      modelVariant: working.chat.config.model.variant,
      baseBranch,
      useWorktree: working.chat.config.useWorktree,
      planMode: true,
      autoAcceptPlan: false,
      fullyAutonomous: false,
    });

    try {
      await this.taskManager.seedPlanFiles(task.config.id, {
        planContent: currentPlan.planContent,
        statusContent: currentPlan.statusContent ?? buildSeededPlanStatusContent(task.config.name),
        planSourcePath: currentPlan.planSourcePath,
        statusSourcePath: currentPlan.statusContent ? currentPlan.statusSourcePath : undefined,
      });
      await this.taskManager.saveLastUsedModel(working.chat.config.model);
    } catch (error) {
      try {
        await this.taskManager.deleteTask(task.config.id);
      } catch (cleanupError) {
        log.warn("Failed to clean up spawned task after current-plan seed failure", {
          taskId: task.config.id,
          chatId,
          error: String(cleanupError),
        });
      }
      throw new Error("Failed to seed spawned task from the current plan", { cause: error });
    }

    return await this.taskManager.getTask(task.config.id) ?? task;
  }

  private assertChatIsAvailable(chat: Chat): void {
    if (isChatBusyStatus(chat.state.status)) {
      throw new ChatBusyError();
    }
  }
}
