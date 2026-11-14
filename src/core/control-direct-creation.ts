/**
 * Shared creation defaults and confirmation-frozen create/message/open intent.
 */
import { z } from "zod";
import { DomainError } from "../domain/domain-error";
import { CreateChatRequestSchema, CreateExecutionHostChatRequestSchema } from "@/contracts/schemas/chat";
import { CreateWorkspaceRequestSchema } from "@/contracts/schemas/workspace";
import { ModelConfigSchema, type ModelConfig } from "@/contracts/schemas/model";
import { ExecutionHostRefSchema } from "@/contracts/schemas/execution-host";
import { getExecutionHostSourceId } from "@/shared/execution-host";
import { DEFAULT_CHAT_CONFIG } from "@/shared/chat";
import type { DirectToolInput } from "./control-tool-contracts";
import { directRecord, ControlToolContext } from "./control-tool-context";
import type { OperationResult } from "./clanky-operation-service";
import type { ConfirmedWriteExecutor } from "./control-actions";
import { createLogger } from "@pablozaiden/webapp/server";
import { createAgentSettings, getHarnessAdapterForProvider, isAgentProvider } from "@/shared/settings";

const log = createLogger("core:voice-direct-creation");
const ModelsSchema = z.array(z.object({
  providerID: z.string(),
  providerName: z.string(),
  modelID: z.string(),
  modelName: z.string(),
  connected: z.boolean(),
  variants: z.array(z.string()).optional(),
}));
type Models = z.infer<typeof ModelsSchema>;

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
  const model = preference
    ? models.find((entry) => entry.providerID === preference.providerID && entry.modelID === preference.modelID && entry.connected)
    : models.find((entry) => entry.connected);
  if (!model) throw new DomainError("voice_model_required", "No connected model is available for this target.");
  return {
    providerID: model.providerID,
    modelID: model.modelID,
    variant: preference?.variant || model.variants?.[0] || "",
  };
}

async function afterChatCreation(options: {
  context: ControlToolContext; input: DirectToolInput<"clanky_create_chat">;
  created: OperationResult; executeWrite: ConfirmedWriteExecutor;
}): Promise<OperationResult> {
  const { context, input, created, executeWrite } = options;
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
      }, executeWrite));
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

export async function directCreateChat(context: ControlToolContext, input: DirectToolInput<"clanky_create_chat">): Promise<unknown> {
  const workspaceTarget = input.workspace ?? (input.host ? null : context.options.origin?.workspaceId);
  if (Boolean(workspaceTarget) === Boolean(input.host)) {
    throw new DomainError("voice_creation_target_required", "Choose exactly one workspace or execution host.");
  }
  let operationId = "POST /api/chats";
  let parameters: Record<string, string> = {};
  let body: unknown;
  if (workspaceTarget) {
    const workspaceId = String((await context.resolve("workspace", workspaceTarget))["id"]);
    const [workspace, models, last] = await Promise.all([
      context.readExact("GET /api/workspaces/:id", { id: workspaceId }),
      context.readExact("GET /api/models", {}, { query: { workspaceId } }),
      context.options.origin
        ? Promise.resolve(context.options.origin.defaultModel ?? null)
        : context.readExact("GET /api/preferences/last-model"),
    ]);
    const owned = directRecord(workspace);
    const preference = input.model ?? (last ? ModelConfigSchema.parse(last) : null);
    const model = chooseModel(ModelsSchema.parse(models), preference);
    const worktreesAllowed = owned["workspaceType"] === "git" && owned["allowWorktrees"] !== false;
    if (input.useWorktree === true && !worktreesAllowed) {
      throw new DomainError("voice_worktree_unavailable", "Worktrees are unavailable for this workspace.");
    }
    const useWorktree = input.useWorktree ?? (worktreesAllowed && DEFAULT_CHAT_CONFIG.useWorktree);
    let baseBranch = input.baseBranch;
    if (useWorktree) {
      const branches = z.object({
        currentBranch: z.string(),
        branches: z.array(z.object({ name: z.string() })),
      }).parse(await context.readExact("GET /api/git/branches", {}, { query: { workspaceId } }));
      baseBranch ??= branches.currentBranch || null;
      if (!baseBranch || !branches.branches.some((branch) => branch.name === baseBranch)) {
        throw new DomainError("voice_branch_required", "Choose a valid branch on the workspace host.");
      }
    }
    body = CreateChatRequestSchema.parse({
      workspaceId, model, useWorktree, startWithPlan: input.startWithPlan, ...(input.name ? { name: input.name } : {}),
      ...(baseBranch ? { baseBranch } : {}), ...(input.directory ? { directory: input.directory } : {}),
    });
  } else {
    if (!input.directory) throw new DomainError("voice_directory_required", "Choose the directory on the selected execution host.");
    if (input.useWorktree || input.baseBranch) throw new DomainError("voice_host_chat_worktree_unsupported", "A direct-host chat has no workspace worktree settings.");
    const host = await context.host(input.host!);
    const ref = ExecutionHostRefSchema.parse(host["ref"]);
    parameters = { kind: ref.kind, id: getExecutionHostSourceId(ref) };
    const preferred = host["preferredModel"] ? ModelConfigSchema.parse(host["preferredModel"]) : null;
    const adapter = input.adapter ?? (preferred && isAgentProvider(preferred.providerID)
      ? getHarnessAdapterForProvider(preferred.providerID) : null);
    if (!adapter) throw new DomainError("voice_adapter_required", "Choose a native adapter or configure the host's preferred harness.");
    const { provider: providerID } = createAgentSettings(adapter);
    const models = ModelsSchema.parse(await context.readExact("POST /api/execution-hosts/:kind/:id/chat-models", parameters, {
      body: { providerID, directory: input.directory },
    }));
    const preferredModel = preferred && preferred.providerID === providerID
      ? { ...preferred, providerID: models.find((model) => model.modelID === preferred.modelID)?.providerID ?? preferred.providerID }
      : preferred;
    const preference = input.model ?? preferredModel;
    if (!preference) throw new DomainError("voice_model_required", "Choose a model or configure the host's preferred model.");
    body = CreateExecutionHostChatRequestSchema.parse({
      adapter, directory: input.directory, model: chooseModel(models, preference),
      startWithPlan: input.startWithPlan, ...(input.name ? { name: input.name } : {}),
    });
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
    ...(compound ? { afterConfirmed: async (created: OperationResult, executeWrite: ConfirmedWriteExecutor) =>
      await afterChatCreation({ context, input, created, executeWrite }) } : {}),
  });
}

export async function directCreateWorkspace(context: ControlToolContext, input: DirectToolInput<"clanky_create_workspace">): Promise<unknown> {
  const host = await context.host(input.host);
  const body = CreateWorkspaceRequestSchema.parse({
    name: input.name, directory: input.directory, executionHost: host["ref"],
    serverSettings: { agent: input.agent }, workspaceType: input.workspaceType,
    ...(input.allowWorktrees !== null ? { allowWorktrees: input.allowWorktrees } : {}),
    ...(input.allowClankyContext !== null ? { allowClankyContext: input.allowClankyContext } : {}),
  });
  return await context.execute({ operationId: "POST /api/workspaces", body, confirmationDescription: input.confirmationDescription });
}
