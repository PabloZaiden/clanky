/**
 * Public task-creation context. Nullable selections are requirements, not
 * values that may be submitted to POST /api/tasks.
 */

import { z } from "zod";
import type { TaskCreationDefaults } from "@/shared/task-creation";
import { CheapModelSelectionSchema, ModelConfigSchema } from "./model";

const TaskCreationDefaultsSchema = z.object({
  maxIterations: z.number().positive().nullable(),
  maxConsecutiveErrors: z.number(),
  activityTimeoutSeconds: z.number().min(60),
  stopPattern: z.string(),
  git: z.object({
    branchPrefix: z.string(),
    commitScope: z.string(),
  }),
  useWorktree: z.boolean(),
  clearPlanningFolder: z.boolean(),
  autoAcceptPlan: z.boolean(),
  fullyAutonomous: z.boolean(),
  draft: z.boolean(),
}) satisfies z.ZodType<TaskCreationDefaults>;

export const TaskCreationRequirementSchema = z.object({
  code: z.enum([
    "workspace_git_required",
    "execution_host_unavailable",
    "task_git_unavailable",
    "task_base_branch_required",
    "task_model_discovery_unavailable",
    "task_model_required",
    "task_model_unavailable",
    "task_cheap_model_unavailable",
  ]),
  message: z.string(),
});

export const TaskCreationContextResponseSchema = z.object({
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    directory: z.string(),
    workspaceType: z.enum(["git", "directory"]),
    executionTargetRevision: z.number().int(),
  }),
  capabilities: z.object({
    tasks: z.boolean(),
    worktrees: z.boolean(),
  }),
  ready: z.boolean(),
  defaults: TaskCreationDefaultsSchema.extend({
    attachments: z.array(z.never()).max(0),
    model: ModelConfigSchema.nullable(),
    cheapModel: CheapModelSelectionSchema.nullable(),
    baseBranch: z.string().min(1).nullable(),
  }),
  models: z.object({
    available: z.array(z.object({
      providerID: z.string(),
      providerName: z.string(),
      modelID: z.string(),
      modelName: z.string(),
      connected: z.boolean(),
      variants: z.array(z.string()).optional(),
    })),
    preferred: ModelConfigSchema.nullable(),
    preferredCheapModel: CheapModelSelectionSchema.nullable(),
    lastModel: ModelConfigSchema.nullable(),
    lastCheapModel: CheapModelSelectionSchema.nullable(),
  }),
  git: z.object({
    currentBranch: z.string().min(1).nullable(),
    defaultBranch: z.string().min(1).nullable(),
    branches: z.array(z.object({ name: z.string(), current: z.boolean() })),
  }),
  requirements: z.array(TaskCreationRequirementSchema),
  preferencePrecedence: z.object({
    planning: z.array(z.string()),
    model: z.array(z.string()),
    cheapModel: z.array(z.string()),
    baseBranch: z.array(z.string()),
  }),
});

export type TaskCreationRequirement = z.infer<typeof TaskCreationRequirementSchema>;
export type TaskCreationContextResponse = z.infer<typeof TaskCreationContextResponseSchema>;
