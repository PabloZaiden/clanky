import { ConfigValidationError } from "@pablozaiden/terminatui";
import type {
  CreateChatRequest,
  CreateLoopRequest,
  UpdateChatRequest,
  UpdateLoopRequest,
} from "@ralpher/contracts";
import type { CreateSshServerRequest, UpdateSshServerRequest } from "@ralpher/contracts/schemas/ssh-server";
import {
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
} from "@ralpher/contracts/schemas/workspace";
import type {
  AgentProvider,
  AgentTransport,
  ServerSettings,
} from "@ralpher/contracts/schemas/workspace";
import type { ChatStatus, LoopStatus } from "@ralpher/shared";
import type { z } from "zod";

export const DEFAULT_LOOP_STOP_PATTERN = "<promise>COMPLETE</promise>$";
export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 10;

type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;

export interface WorkspaceFormValues {
  name: string;
  directory: string;
  agentProvider: AgentProvider;
  agentTransport: AgentTransport;
  hostname: string;
  port: number;
  username: string;
  password: string;
  identityFile: string;
}

export interface ServerFormValues {
  name: string;
  address: string;
  username: string;
  repositoriesBasePath: string;
}

export interface LoopFormValues {
  workspace: string;
  name: string;
  prompt: string;
  modelProviderID: string;
  modelID: string;
  modelVariant: string;
  cheapModelMode: "same-as-loop" | "custom";
  cheapModelProviderID: string;
  cheapModelID: string;
  cheapModelVariant: string;
  baseBranch: string;
  maxIterations: number;
  maxConsecutiveErrors: number;
  activityTimeoutSeconds: number;
  useWorktree: boolean;
  clearPlanningFolder: boolean;
  planMode: boolean;
  autoAcceptPlan: boolean;
  fullyAutonomous: boolean;
  gitBranchPrefix: string;
  gitCommitScope: string;
}

export interface ChatFormValues {
  workspace: string;
  name: string;
  modelProviderID: string;
  modelID: string;
  modelVariant: string;
  baseBranch: string;
  useWorktree: boolean;
}

export function createServerSettings(values: WorkspaceFormValues): ServerSettings {
  if (values.agentTransport === "ssh") {
    return {
      agent: {
        provider: values.agentProvider,
        transport: "ssh",
        hostname: values.hostname.trim(),
        port: values.port,
        username: values.username.trim() || undefined,
        password: values.password.trim() || undefined,
        identityFile: values.identityFile.trim() || undefined,
      },
    };
  }

  return {
    agent: {
      provider: values.agentProvider,
      transport: "stdio",
    },
  };
}

export function buildCreateWorkspaceRequest(values: WorkspaceFormValues): CreateWorkspaceRequest {
  assertNonEmpty(values.name, "name");
  assertNonEmpty(values.directory, "directory");

  return {
    name: values.name.trim(),
    directory: values.directory.trim(),
    serverSettings: createServerSettings(values),
  };
}

export function buildUpdateWorkspaceRequest(values: WorkspaceFormValues): UpdateWorkspaceRequest {
  return {
    name: values.name.trim(),
    serverSettings: createServerSettings(values),
  };
}

export function buildCreateServerRequest(values: ServerFormValues): CreateSshServerRequest {
  assertNonEmpty(values.name, "name");
  assertNonEmpty(values.address, "address");
  assertNonEmpty(values.username, "username");

  return {
    name: values.name.trim(),
    address: values.address.trim(),
    username: values.username.trim(),
    repositoriesBasePath: values.repositoriesBasePath.trim() || null,
  };
}

export function buildUpdateServerRequest(values: ServerFormValues): UpdateSshServerRequest {
  return {
    name: values.name.trim(),
    address: values.address.trim(),
    username: values.username.trim(),
    repositoriesBasePath: values.repositoriesBasePath.trim() || null,
  };
}

export function buildCreateLoopRequest(
  values: LoopFormValues,
  workspaceId: string,
): CreateLoopRequest {
  assertNonEmpty(values.name, "name");
  assertNonEmpty(values.prompt, "prompt");
  assertNonEmpty(values.modelProviderID, "modelProviderID");
  assertNonEmpty(values.modelID, "modelID");
  assertNonEmpty(values.baseBranch, "baseBranch");

  return {
    name: values.name.trim(),
    workspaceId,
    prompt: values.prompt.trim(),
    attachments: [],
    model: {
      providerID: values.modelProviderID.trim(),
      modelID: values.modelID.trim(),
      variant: values.modelVariant.trim(),
    },
    cheapModel: values.cheapModelMode === "custom"
      ? {
          mode: "custom",
          model: {
            providerID: assertNonEmpty(values.cheapModelProviderID, "cheapModelProviderID"),
            modelID: assertNonEmpty(values.cheapModelID, "cheapModelID"),
            variant: values.cheapModelVariant.trim(),
          },
        }
      : {
          mode: "same-as-loop",
        },
    maxIterations: values.maxIterations > 0 ? values.maxIterations : null,
    maxConsecutiveErrors: values.maxConsecutiveErrors,
    activityTimeoutSeconds: values.activityTimeoutSeconds > 0
      ? Math.max(values.activityTimeoutSeconds, 60)
      : null,
    stopPattern: DEFAULT_LOOP_STOP_PATTERN,
    git: {
      branchPrefix: values.gitBranchPrefix.trim(),
      commitScope: values.gitCommitScope.trim(),
    },
    baseBranch: values.baseBranch.trim(),
    useWorktree: values.useWorktree,
    clearPlanningFolder: values.clearPlanningFolder,
    planMode: values.planMode,
    autoAcceptPlan: values.planMode ? (values.fullyAutonomous ? true : values.autoAcceptPlan) : false,
    fullyAutonomous: values.planMode ? values.fullyAutonomous : false,
    draft: false,
  };
}

export function buildUpdateLoopRequest(values: Omit<LoopFormValues, "workspace">): UpdateLoopRequest {
  return {
    name: values.name.trim(),
    prompt: values.prompt.trim(),
    model: {
      providerID: assertNonEmpty(values.modelProviderID, "modelProviderID"),
      modelID: assertNonEmpty(values.modelID, "modelID"),
      variant: values.modelVariant.trim(),
    },
    cheapModel: values.cheapModelMode === "custom"
      ? {
          mode: "custom",
          model: {
            providerID: assertNonEmpty(values.cheapModelProviderID, "cheapModelProviderID"),
            modelID: assertNonEmpty(values.cheapModelID, "cheapModelID"),
            variant: values.cheapModelVariant.trim(),
          },
        }
      : {
          mode: "same-as-loop",
        },
    maxIterations: values.maxIterations > 0 ? values.maxIterations : null,
    maxConsecutiveErrors: values.maxConsecutiveErrors,
    activityTimeoutSeconds: values.activityTimeoutSeconds > 0
      ? Math.max(values.activityTimeoutSeconds, 60)
      : null,
    stopPattern: DEFAULT_LOOP_STOP_PATTERN,
    git: {
      branchPrefix: values.gitBranchPrefix.trim(),
      commitScope: values.gitCommitScope.trim(),
    },
    baseBranch: values.baseBranch.trim(),
    useWorktree: values.useWorktree,
    clearPlanningFolder: values.clearPlanningFolder,
    planMode: values.planMode,
    autoAcceptPlan: values.planMode ? (values.fullyAutonomous ? true : values.autoAcceptPlan) : false,
    fullyAutonomous: values.planMode ? values.fullyAutonomous : false,
  };
}

export function buildCreateChatRequest(values: ChatFormValues, workspaceId: string): CreateChatRequest {
  return {
    name: assertNonEmpty(values.name, "name"),
    workspaceId,
    model: {
      providerID: assertNonEmpty(values.modelProviderID, "modelProviderID"),
      modelID: assertNonEmpty(values.modelID, "modelID"),
      variant: values.modelVariant.trim(),
    },
    useWorktree: values.useWorktree,
    baseBranch: assertNonEmpty(values.baseBranch, "baseBranch"),
  };
}

export function buildUpdateChatRequest(values: Omit<ChatFormValues, "workspace">): UpdateChatRequest {
  return {
    name: assertNonEmpty(values.name, "name"),
    model: {
      providerID: assertNonEmpty(values.modelProviderID, "modelProviderID"),
      modelID: assertNonEmpty(values.modelID, "modelID"),
      variant: values.modelVariant.trim(),
    },
    useWorktree: values.useWorktree,
    baseBranch: assertNonEmpty(values.baseBranch, "baseBranch"),
  };
}

export function sanitizeCommandName(rawValue: string, fallback: string): string {
  const normalized = rawValue
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function buildEntityCommandName(name: string, id: string): string {
  const fallback = `entity-${id.slice(0, 8)}`;
  return `${sanitizeCommandName(name, fallback)}-${id.slice(0, 6)}`;
}

export function requireConfirmation(confirm: boolean, actionName: string): void {
  if (!confirm) {
    throw new ConfigValidationError(`Set confirm to true before running ${actionName}.`, "confirm");
  }
}

export function getLoopActionNames(status: LoopStatus): string[] {
  const actions = ["info", "edit", "live"];

  if (status === "planning") {
    actions.push("stop", "set-pending", "clear-pending", "plan-feedback", "plan-accept", "plan-discard");
    return actions;
  }

  if (status === "starting" || status === "running" || status === "waiting") {
    actions.push("stop", "set-pending", "clear-pending");
    return actions;
  }

  if (status === "completed" || status === "max_iterations") {
    actions.push("follow-up", "accept", "push", "discard");
    return actions;
  }

  if (status === "stopped" || status === "failed") {
    actions.push("follow-up", "manual-complete", "discard");
    return actions;
  }

  if (status === "pushed") {
    actions.push("follow-up", "update-branch", "mark-merged", "purge");
    return actions;
  }

  if (status === "merged" || status === "deleted" || status === "draft") {
    actions.push("purge");
    return actions;
  }

  return actions;
}

export function getChatActionNames(status: ChatStatus): string[] {
  const actions = ["info", "edit", "live", "send", "delete"];

  if (status === "starting" || status === "streaming" || status === "interrupting") {
    actions.push("interrupt");
    return actions;
  }

  actions.push("reconnect");
  return actions;
}

function assertNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ConfigValidationError(`${field} is required.`, field);
  }
  return trimmed;
}
