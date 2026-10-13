/**
 * Core orchestration for creating and starting tasks.
 *
 * Routes validate request bodies and translate the domain errors raised here.
 * Workspace resolution, model validation, preference persistence, planning
 * file seeding, startup, and cleanup all remain inside Core.
 */

import type { Task, Workspace } from "@/shared";
import type { CreateTaskRequest, GenerateTaskTitleRequest } from "@/contracts";
import type {
  TaskCreationContextResponse,
  TaskCreationRequirement,
} from "@/contracts/schemas/task-creation-context";
import {
  getTaskCreationDefaults,
  resolveTaskCreationCheapModel,
  resolveTaskCreationModel,
} from "@/shared/task-creation";
import { UPLOADED_PLAN_IMPLEMENTATION_PROMPT } from "../lib/uploaded-plan";
import {
  normalizeUploadedPlanningFiles,
  type ValidatedPlanningFiles,
} from "./planning-file-service";
import { backendManager } from "./backend-manager";
import { DomainError } from "../domain/domain-error";
import { GitService } from "./git";
import { createLogger } from "@pablozaiden/webapp/server";
import { getModelsForWorkspace, isModelEnabled } from "./model-discovery";
import { preferencesManager } from "./preferences-manager";
import { taskManager } from "./task-manager";
import { workspaceManager } from "./workspace-manager";
import { assertGitBackedWorkspace, isGitBackedWorkspace } from "./workspace-capabilities";

const log = createLogger("core:task-creation-service");

export type TaskStartPhase = "uploaded_plan" | "plan";

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
  private async getCreationGitContext(
    workspace: Workspace,
    context: TaskCreationContextResponse,
  ): Promise<void> {
    let git: GitService;
    try {
      const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
      git = GitService.withExecutor(executor);
    } catch {
      context.requirements.push({
        code: "execution_host_unavailable",
        message: "Connect the selected workspace's execution host before creating a task.",
      });
      return;
    }

    try {
      if (!await git.isGitRepo(workspace.directory)) {
        context.requirements.push({
          code: "task_git_unavailable",
          message: "The selected workspace directory must be a readable Git repository on its execution host.",
        });
        return;
      }
      const [currentBranch, defaultBranch, branches] = await Promise.all([
        git.getCurrentBranch(workspace.directory),
        git.getDefaultBranch(workspace.directory),
        git.getBranches(workspace.directory),
      ]);
      context.git.branches = branches;
      context.git.currentBranch = currentBranch && currentBranch !== "HEAD" ? currentBranch : null;
      const branchNames = new Set(branches.map((branch) => branch.name));
      const defaultRef = branchNames.has(defaultBranch)
        ? defaultBranch
        : branches.find((branch) => branch.name === `origin/${defaultBranch}`)?.name;
      const candidates = [defaultRef, context.git.currentBranch].filter(
        (branch): branch is string => Boolean(branch && branch !== "HEAD" && branchNames.has(branch)),
      );
      for (const branch of candidates) {
        if (await git.branchExists(workspace.directory, branch)) {
          context.defaults.baseBranch = branch;
          context.git.defaultBranch = defaultRef === branch ? branch : null;
          break;
        }
      }
      if (!context.defaults.baseBranch) {
        context.requirements.push({
          code: "task_base_branch_required",
          message: "Select an existing branch with a commit on this workspace's execution host before creating a task.",
        });
      }
    } catch {
      context.requirements.push({
        code: "task_git_unavailable",
        message: "Read Git branches from the selected workspace's execution host before creating a task.",
      });
    }
  }

  private async getCreationModelContext(
    workspace: Workspace,
    context: TaskCreationContextResponse,
  ): Promise<void> {
    try {
      const models = await getModelsForWorkspace(workspace.id, workspace);
      context.models.available = models.map((model) => ({
        providerID: model.providerID,
        providerName: model.providerName,
        modelID: model.modelID,
        modelName: model.modelName,
        connected: model.connected,
        ...(model.variants ? { variants: [...model.variants] } : {}),
      }));
    } catch {
      context.requirements.push({
        code: "task_model_discovery_unavailable",
        message: "Make model discovery available on the selected workspace's execution host before choosing a task model.",
      });
      return;
    }

    const models = context.models.available;
    const model = resolveTaskCreationModel({ models, lastModel: context.models.lastModel });
    const cheapModel = resolveTaskCreationCheapModel({
      models,
      lastCheapModel: context.models.lastCheapModel,
    });
    context.models.preferred = model;
    context.models.preferredCheapModel = cheapModel;
    if (!model) {
      context.requirements.push({
        code: "task_model_required",
        message: "Configure a connected model on this workspace before creating a task.",
      });
      return;
    }

    const selections: {
      model: typeof model;
      code: TaskCreationRequirement["code"];
      cheap: boolean;
    }[] = [{ model, code: "task_model_unavailable", cheap: false }];
    if (cheapModel.mode === "custom") {
      selections.push({ model: cheapModel.model, code: "task_cheap_model_unavailable", cheap: true });
    }
    for (const selection of selections) {
      try {
        await this.validateModel(workspace.id, selection.model, selection.code);
        if (selection.cheap) {
          context.defaults.cheapModel = cheapModel;
        } else {
          context.defaults.model = model;
          if (cheapModel.mode === "same-as-task") {
            context.defaults.cheapModel = cheapModel;
          }
        }
      } catch {
        context.requirements.push({
          code: selection.code,
          message: selection.cheap
            ? "Choose a connected helper model for the selected workspace."
            : "The preferred task model is not connected on this workspace; select an available model.",
        });
      }
    }
  }

  async getCreationContext(workspaceId: string): Promise<TaskCreationContextResponse> {
    const workspace = await workspaceManager.requireWorkspace(workspaceId);
    const [lastModel, lastCheapModel] = await Promise.all([
      preferencesManager.getLastModel(),
      preferencesManager.getLastCheapModel(),
    ]);
    const tasks = isGitBackedWorkspace(workspace);
    const worktrees = tasks && workspace.allowWorktrees !== false;
    const context: TaskCreationContextResponse = {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        directory: workspace.directory,
        workspaceType: workspace.workspaceType,
        executionTargetRevision: workspace.executionTargetRevision,
      },
      capabilities: { tasks, worktrees },
      ready: false,
      defaults: {
        ...getTaskCreationDefaults({ worktreesAllowed: worktrees }),
        attachments: [],
        model: null,
        cheapModel: null,
        baseBranch: null,
      },
      models: {
        available: [],
        preferred: null,
        preferredCheapModel: null,
        lastModel: lastModel ? {
          providerID: lastModel.providerID,
          modelID: lastModel.modelID,
          variant: lastModel.variant ?? "",
        } : null,
        lastCheapModel: !lastCheapModel ? null : lastCheapModel.mode === "same-as-task"
          ? { mode: "same-as-task" }
          : {
              mode: "custom",
              model: {
                providerID: lastCheapModel.model.providerID,
                modelID: lastCheapModel.model.modelID,
                variant: lastCheapModel.model.variant ?? "",
              },
            },
      },
      git: { currentBranch: null, defaultBranch: null, branches: [] },
      requirements: [],
      preferencePrecedence: {
        planning: ["explicit_request", "browser_saved_new_task_planning", "initial_task", "form_default"],
        model: ["initial_task", "browser_saved_task_model_or_server_last_model", "first_connected_model"],
        cheapModel: ["initial_task", "browser_saved_task_cheap_model", "server_last_cheap_model", "same_as_task"],
        baseBranch: ["explicit_valid_branch", "workspace_default_branch", "workspace_current_branch"],
      },
    };
    if (!tasks) {
      context.requirements.push({
        code: "workspace_git_required",
        message: "Tasks require a Git-backed workspace; select one explicitly.",
      });
      return context;
    }
    await Promise.all([
      this.getCreationGitContext(workspace, context),
      this.getCreationModelContext(workspace, context),
    ]);
    context.ready = context.requirements.length === 0;
    return context;
  }

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
  ): Promise<Task> {
    if (uploadedPlan) {
      try {
        await taskManager.seedPlanFiles(task.config.id, uploadedPlan);
        await taskManager.acceptPlan(task.config.id, {
          mode: "start_task",
          executionPrompt: UPLOADED_PLAN_IMPLEMENTATION_PROMPT,
          executionPromptMode: "engine_context",
        });
        return await taskManager.getTask(task.config.id) ?? task;
      } catch (error) {
        await this.cleanupFailedTask(task.config.id);
        throw new TaskCreationStartError(task.config.id, "uploaded_plan", error);
      }
    }

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
    const effectiveAutoAcceptPlan = hasUploadedPlan ? true : input.autoAcceptPlan;
    const workspace = await workspaceManager.requireWorkspace(input.workspaceId);
    assertGitBackedWorkspace(workspace, "Tasks require a Git-backed workspace.");
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

    return await this.startCreatedTask(task, input, uploadedPlan);
  }

  async generateTitle(input: GenerateTaskTitleRequest): Promise<string> {
    const workspace = await workspaceManager.requireWorkspace(input.workspaceId);
    assertGitBackedWorkspace(workspace, "Task title generation requires a Git-backed workspace.");
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
