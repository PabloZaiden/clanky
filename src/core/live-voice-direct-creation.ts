/**
 * Real creation defaults and confirmation-frozen create/message/open intent.
 */
import { z } from "zod";
import { DomainError } from "../domain/domain-error";
import { CreateTaskRequestSchema } from "@/contracts/schemas/task";
import { CreateChatRequestSchema } from "@/contracts/schemas/chat";
import { CreateWorkspaceRequestSchema, AgentProviderSchema } from "@/contracts/schemas/workspace";
import { ModelConfigSchema, CheapModelSelectionSchema, type ModelConfig } from "@/contracts/schemas/model";
import { TaskCreationContextResponseSchema } from "@/contracts/schemas/task-creation-context";
import { ExecutionHostRefSchema } from "@/contracts/schemas/execution-host";
import { getExecutionHostSourceId } from "@/shared/execution-host";
import { DEFAULT_CHAT_CONFIG } from "@/shared/chat";
import { getTaskCreationDefaults, resolveTaskCreationModel, resolveTaskCreationCheapModel } from "@/shared/task-creation";
import type { DirectToolInput } from "./live-voice-direct-contracts";
import { directRecord, LiveVoiceDirectContext } from "./live-voice-direct-context";
import type { OperationResult } from "./clanky-operation-service";
import { createLogger } from "@pablozaiden/webapp/server";

const log = createLogger("core:voice-direct-creation");
const ModelsSchema = TaskCreationContextResponseSchema.shape.models.shape.available;
type Models = z.infer<typeof ModelsSchema>;

function savedPreference<T>(schema: z.ZodType<T>, raw: string | null | undefined): T | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (cause) { throw new DomainError("voice_saved_preference_invalid", "The saved browser model preference is invalid; select a model explicitly.", { cause }); }
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainError("voice_saved_preference_invalid", "The saved browser model preference is invalid; select a model explicitly.");
  return result.data;
}

function requireAvailable(models: Models, preference: ModelConfig | null): void {
  if (!preference) return;
  const available = models.find((model) => model.providerID === preference.providerID && model.modelID === preference.modelID && model.connected);
  if (!available || preference.variant && available.variants?.length && !available.variants.includes(preference.variant)) {
    throw new DomainError("voice_model_preference_unavailable", "The requested or remembered model is unavailable. Choose an available model explicitly.", {
      details: { models: models.filter((model) => model.connected).slice(0, 8).map(({ providerID, modelID }) => ({ providerID, modelID })) },
    });
  }
}

function chooseModel(models: Models, preference: ModelConfig | null): ModelConfig {
  requireAvailable(models, preference);
  const model = resolveTaskCreationModel({ models, initialModel: preference });
  if (!model) throw new DomainError("voice_model_required", "No connected model is available for this target.");
  return model;
}

export async function directCreateTask(context: LiveVoiceDirectContext, input: DirectToolInput<"clanky_create_task">): Promise<unknown> {
  if (!input.workspace) throw new DomainError("voice_workspace_required", "Choose a workspace for the task.");
  const workspaceId = String((await context.resolve("workspace", input.workspace))["id"]);
  const [ui, creation] = await Promise.all([
    context.uiContext(),
    context.readExact("GET /api/workspaces/:id/task-creation-context", { id: workspaceId }),
  ]);
  const available = TaskCreationContextResponseSchema.parse(creation);
  const models = available.models.available;
  const preference = input.model ?? savedPreference(ModelConfigSchema, ui.modelPreferences?.taskModelJson) ?? available.models.lastModel;
  const cheapPreference = input.cheapModel ?? savedPreference(CheapModelSelectionSchema, ui.modelPreferences?.cheapModelJson) ?? available.models.lastCheapModel;
  requireAvailable(models, cheapPreference?.mode === "custom" ? cheapPreference.model : null);
  const model = chooseModel(models, preference);
  const cheapModel = resolveTaskCreationCheapModel({ models, initialCheapModel: cheapPreference });
  const baseBranch = input.baseBranch ?? available.defaults.baseBranch;
  if (!baseBranch || !available.git.branches.some((branch) => branch.name === baseBranch)) {
    throw new DomainError("voice_branch_required", "Choose an existing branch on the workspace host.", {
      details: { branches: available.git.branches.slice(0, 12).map(({ name }) => name) },
    });
  }
  const unresolved = available.requirements.filter((requirement) =>
    !["task_base_branch_required", "task_model_required", "task_model_unavailable", "task_cheap_model_unavailable"].includes(requirement.code),
  );
  if (unresolved.length) throw new DomainError("voice_creation_not_ready", "The selected workspace is not ready to create tasks.", { details: { requirements: unresolved } });
  if (input.useWorktree === true && !available.capabilities.worktrees) {
    throw new DomainError("voice_worktree_unavailable", "Worktrees are disabled for this workspace.");
  }
  const defaults = getTaskCreationDefaults({
    initial: available.defaults, planningPreferences: ui.planningPreferences,
    worktreesAllowed: available.capabilities.worktrees,
  });
  const body = CreateTaskRequestSchema.parse({
    ...defaults, name: input.name, prompt: input.prompt, workspaceId, model, cheapModel, baseBranch,
    attachments: [], draft: input.draft, useWorktree: input.useWorktree ?? defaults.useWorktree,
    autoAcceptPlan: input.autoAcceptPlan ?? defaults.autoAcceptPlan,
    fullyAutonomous: input.fullyAutonomous ?? defaults.fullyAutonomous,
  });
  return await context.execute({ operationId: "POST /api/tasks", body, confirmationDescription: input.confirmationDescription });
}

async function afterChatCreation(context: LiveVoiceDirectContext, input: DirectToolInput<"clanky_create_chat">, created: OperationResult): Promise<OperationResult> {
  let sent: Record<string, unknown> | null = null;
  let opened: unknown = null;
  const id = directRecord(created.data)["id"];
  if (typeof id !== "string") return {
    ...created, ok: false, code: "voice_created_reference_unavailable", completion: "outcome_unknown",
    data: { creation: created.data, message: { completion: "not_executed" }, open: { completion: "not_executed" } },
  };
  try {
    if (input.initialMessage) {
      sent = directRecord(await context.execute({
        operationId: "POST /api/chats/:id/messages", parameters: { id },
        body: { message: input.initialMessage, attachments: [] },
      }));
      if (sent["ok"] !== true) return {
        ...created, ok: false, code: "voice_creation_partial",
        data: { creation: created.data, message: sent, open: { completion: "not_executed" } },
      };
    }
    if (input.open) opened = await context.options.actions.uiAction({ type: "open_chat", chatId: id }, context.options.requestId);
    return {
      ...created, ...(opened && directRecord(opened)["status"] === "failed" ? { ok: false, code: "voice_creation_partial" } : {}),
      data: { creation: created.data, message: sent, open: opened },
    };
  } catch (error) {
    log.error("Chat created but follow-on intent failed", { id, error: String(error) });
    return {
      ...created, ok: false, code: "voice_creation_partial",
      data: { creation: created.data, message: sent ?? { completion: "outcome_unknown" }, open: opened ?? { completion: "not_executed" } },
    };
  }
}

export async function directCreateChat(context: LiveVoiceDirectContext, input: DirectToolInput<"clanky_create_chat">): Promise<unknown> {
  if (Boolean(input.workspace) === Boolean(input.host)) {
    throw new DomainError("voice_creation_target_required", "Choose exactly one workspace or execution host.");
  }
  let operationId = "POST /api/chats";
  let parameters: Record<string, string> = {};
  let body: unknown;
  if (input.workspace) {
    const workspaceId = String((await context.resolve("workspace", input.workspace))["id"]);
    const [workspace, models, last] = await Promise.all([
      context.readExact("GET /api/workspaces/:id", { id: workspaceId }),
      context.readExact("GET /api/models", {}, { query: { workspaceId } }),
      context.readExact("GET /api/preferences/last-model"),
    ]);
    const owned = directRecord(workspace);
    const preference = input.model ?? (last ? ModelConfigSchema.parse(last) : null);
    const model = chooseModel(ModelsSchema.parse(models), preference);
    const useWorktree = input.useWorktree ?? (owned["workspaceType"] === "git" && owned["allowWorktrees"] !== false && DEFAULT_CHAT_CONFIG.useWorktree);
    let baseBranch = input.baseBranch;
    if (useWorktree) {
      const creation = TaskCreationContextResponseSchema.parse(await context.readExact("GET /api/workspaces/:id/task-creation-context", { id: workspaceId }));
      baseBranch ??= creation.defaults.baseBranch;
      if (!baseBranch || !creation.git.branches.some((branch) => branch.name === baseBranch)) {
        throw new DomainError("voice_branch_required", "Choose a valid branch on the workspace host.");
      }
    }
    body = CreateChatRequestSchema.parse({
      workspaceId, model, useWorktree, ...(input.name ? { name: input.name } : {}),
      ...(baseBranch ? { baseBranch } : {}), ...(input.directory ? { directory: input.directory } : {}),
    });
  } else {
    if (!input.directory) throw new DomainError("voice_directory_required", "Choose the directory on the selected execution host.");
    if (input.useWorktree || input.baseBranch) throw new DomainError("voice_host_chat_worktree_unsupported", "A direct-host chat has no workspace worktree settings.");
    const host = await context.host(input.host!);
    const ref = ExecutionHostRefSchema.parse(host["ref"]);
    parameters = { kind: ref.kind, id: getExecutionHostSourceId(ref) };
    const preferred = host["preferredModel"] ? ModelConfigSchema.parse(host["preferredModel"]) : null;
    const preference = input.model ?? preferred;
    if (!preference) throw new DomainError("voice_model_required", "Choose a model or configure the host's preferred model.");
    const providerID = AgentProviderSchema.parse(preference.providerID);
    const models = ModelsSchema.parse(await context.readExact("POST /api/execution-hosts/:kind/:id/chat-models", parameters, {
      body: { providerID, directory: input.directory },
    }));
    body = { directory: input.directory, model: chooseModel(models, preference), ...(input.name ? { name: input.name } : {}) };
    operationId = "POST /api/execution-hosts/:kind/:id/chats";
  }
  const compound = Boolean(input.initialMessage || input.open);
  if (compound && !input.afterCreationDescription) {
    throw new DomainError("voice_confirmation_description_required", "Describe the initial-message and navigation actions for the visual confirmation.");
  }
  const description = input.confirmationDescription && compound
    ? `${input.confirmationDescription} ${input.afterCreationDescription}`
    : input.confirmationDescription;
  return await context.execute({
    operationId, parameters, body, confirmationDescription: description,
    ...(compound ? { afterConfirmed: async (created: OperationResult) => await afterChatCreation(context, input, created) } : {}),
  });
}

export async function directCreateWorkspace(context: LiveVoiceDirectContext, input: DirectToolInput<"clanky_create_workspace">): Promise<unknown> {
  const host = await context.host(input.host);
  const body = CreateWorkspaceRequestSchema.parse({
    name: input.name, directory: input.directory, executionHost: host["ref"],
    serverSettings: { agent: input.agent }, workspaceType: input.workspaceType,
    ...(input.allowWorktrees !== null ? { allowWorktrees: input.allowWorktrees } : {}),
    ...(input.allowClankyContext !== null ? { allowClankyContext: input.allowClankyContext } : {}),
  });
  return await context.execute({ operationId: "POST /api/workspaces", body, confirmationDescription: input.confirmationDescription });
}
