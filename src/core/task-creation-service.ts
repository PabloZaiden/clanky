/**
 * Core orchestration for creating and starting tasks.
 *
 * Routes validate request bodies and translate the domain errors raised here.
 * Workspace resolution, model validation, preference persistence, planning
 * file seeding, startup, and cleanup all remain inside Core.
 */

import type { Task } from "@/shared";
import type { CreateTaskRequest, GenerateTaskTitleRequest } from "@/contracts";
import { UPLOADED_PLAN_IMPLEMENTATION_PROMPT } from "../lib/uploaded-plan";
import {
  normalizeUploadedPlanningFiles,
  type ValidatedPlanningFiles,
} from "./planning-file-service";
import { backendManager } from "./backend-manager";
import { DomainError } from "./domain-error";
import { GitService } from "./git";
import { createLogger } from "./logger";
import { isModelEnabled } from "./model-discovery";
import { taskManager } from "./task-manager";
import { workspaceManager } from "./workspace-manager";

const log = createLogger("core:task-creation-service");

export type TaskStartPhase = "uploaded_plan" | "plan" | "task";

export class TaskCreationStartError extends Error {
  readonly taskId: string;
  readonly phase: TaskStartPhase;
  readonly originalError: unknown;

  constructor(taskId: string, phase: TaskStartPhase, originalError: unknown) {
    super(String(originalError), {
      cause: originalError,
    });
    this.name = "TaskCreationStartError";
    this.taskId = taskId;
    this.phase = phase;
    this.originalError = originalError;
  }
}

function getModelErrorCode(
  validation: Awaited<ReturnType<typeof isModelEnabled>>,
  fallbackCode: string,
): string {
  return validation.errorCode ?? fallbackCode;
}

class TaskCreationService {
  private async validateModel(
    workspaceId: string,
    model: { providerID: string; modelID: string },
    fallbackCode: string,
  ): Promise<void> {
    const validation = await isModelEnabled(workspaceId, model.providerID, model.modelID);
    if (validation.enabled) {
      return;
    }

    throw new DomainError(
      getModelErrorCode(validation, fallbackCode),
      validation.error ?? "The selected model is not available",
      {
        details: {
          workspaceId,
          providerID: model.providerID,
          modelID: model.modelID,
        },
      },
    );
  }

  private async cleanupFailedTask(taskId: string): Promise<void> {
    try {
      const deleted = await taskManager.deleteTask(taskId);
      if (!deleted) {
        log.warn("Task cleanup after startup failure did not delete the task", { taskId });
      }
    } catch (error) {
      log.warn("Failed to clean up task after startup failure", {
        taskId,
        error: String(error),
      });
    }
  }

  private async startCreatedTask(
    task: Task,
    input: CreateTaskRequest,
    uploadedPlan: ValidatedPlanningFiles | null,
    planMode: boolean,
  ): Promise<Task> {
    if (uploadedPlan) {
      try {
        await taskManager.seedPlanFiles(task.config.id, uploadedPlan);
        await taskManager.acceptPlan(task.config.id, {
          mode: "start_task",
          executionPrompt: UPLOADED_PLAN_IMPLEMENTATION_PROMPT,
          executionPromptMode: "task_context",
        });
        return await taskManager.getTask(task.config.id) ?? task;
      } catch (error) {
        await this.cleanupFailedTask(task.config.id);
        throw new TaskCreationStartError(task.config.id, "uploaded_plan", error);
      }
    }

    if (planMode) {
      try {
        await taskManager.startPlanMode(task.config.id, {
          attachments: input.attachments,
        });
        return await taskManager.getTask(task.config.id) ?? task;
      } catch (error) {
        await this.cleanupFailedTask(task.config.id);
        throw new TaskCreationStartError(task.config.id, "plan", error);
      }
    }

    try {
      await taskManager.startTask(task.config.id, {
        attachments: input.attachments,
      });
      return await taskManager.getTask(task.config.id) ?? task;
    } catch (error) {
      await this.cleanupFailedTask(task.config.id);
      throw new TaskCreationStartError(task.config.id, "task", error);
    }
  }

  async create(input: CreateTaskRequest): Promise<Task> {
    let uploadedPlan: ValidatedPlanningFiles | null = null;
    if (input.uploadedPlan) {
      try {
        uploadedPlan = normalizeUploadedPlanningFiles(input.uploadedPlan);
      } catch (error) {
        throw new DomainError(
          "invalid_uploaded_plan",
          error instanceof Error ? error.message : String(error),
          {
            cause: error,
            details: { workspaceId: input.workspaceId },
          },
        );
      }
    }

    const hasUploadedPlan = uploadedPlan !== null;
    const effectivePlanMode = hasUploadedPlan ? true : input.planMode;
    const effectiveAutoAcceptPlan = hasUploadedPlan ? true : input.autoAcceptPlan;
    const workspace = await workspaceManager.requireWorkspace(input.workspaceId);
    await workspaceManager.touchWorkspace(workspace.id);

    let git: GitService | null = null;
    const getGitService = async (): Promise<GitService> => {
      if (!git) {
        const executor = await backendManager.getCommandExecutorAsync(
          workspace.id,
          workspace.directory,
        );
        git = GitService.withExecutor(executor);
      }
      return git;
    };

    if (input.model.providerID && input.model.modelID) {
      await this.validateModel(
        workspace.id,
        input.model,
        "model_not_enabled",
      );
    }
    if (input.cheapModel.mode === "custom") {
      await this.validateModel(
        workspace.id,
        input.cheapModel.model,
        "cheap_model_not_enabled",
      );
    }

    let effectiveBaseBranch = input.baseBranch;
    if (!effectiveBaseBranch) {
      try {
        effectiveBaseBranch = await (await getGitService()).getDefaultBranch(workspace.directory);
        log.debug("Auto-detected default branch for task", {
          workspaceId: workspace.id,
          baseBranch: effectiveBaseBranch,
        });
      } catch (error) {
        log.warn("Failed to detect default branch; task will use the current branch", {
          workspaceId: workspace.id,
          error: String(error),
        });
      }
    }

    const task = await taskManager.createTask({
      name: input.name,
      directory: workspace.directory,
      prompt: input.prompt,
      issueNumber: input.issueNumber,
      attachments: input.attachments,
      workspaceId: workspace.id,
      modelProviderID: input.model.providerID,
      modelID: input.model.modelID,
      modelVariant: input.model.variant,
      cheapModel: input.cheapModel,
      maxIterations: input.maxIterations ?? undefined,
      maxConsecutiveErrors: input.maxConsecutiveErrors,
      activityTimeoutSeconds: input.activityTimeoutSeconds,
      stopPattern: input.stopPattern,
      gitBranchPrefix: input.git.branchPrefix,
      gitCommitScope: input.git.commitScope,
      baseBranch: effectiveBaseBranch,
      useWorktree: input.useWorktree,
      clearPlanningFolder: input.clearPlanningFolder,
      planMode: effectivePlanMode,
      autoAcceptPlan: effectiveAutoAcceptPlan,
      fullyAutonomous: input.fullyAutonomous,
      draft: input.draft,
    });

    await taskManager.saveLastUsedModel({
      providerID: input.model.providerID,
      modelID: input.model.modelID,
      variant: input.model.variant,
    });
    await taskManager.saveLastUsedCheapModel(input.cheapModel);

    if (input.draft) {
      return task;
    }

    return await this.startCreatedTask(task, input, uploadedPlan, effectivePlanMode);
  }

  async generateTitle(input: GenerateTaskTitleRequest): Promise<string> {
    const workspace = await workspaceManager.requireWorkspace(input.workspaceId);
    await workspaceManager.touchWorkspace(workspace.id);
    return await taskManager.generateTaskTitle({
      workspaceId: workspace.id,
      directory: workspace.directory,
      prompt: input.prompt,
      model: input.model,
      cheapModel: input.cheapModel,
    });
  }
}

export const taskCreationService = new TaskCreationService();
