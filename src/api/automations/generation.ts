import { workspaceOperation } from "../workspace-delegation";
/**
 * Scheduled-automation code generation API routes.
 */

import { defineRoutes } from "@/platform/server";
import { createLogger } from "@pablozaiden/webapp/server";
import type { Automation } from "@/shared/automation";
import type { Chat } from "@/shared/chat";
import type { Workspace } from "@/shared/workspace";
import { GenerateAutomationCodeRequestSchema, PrepareGenerateAutomationCodeRequestSchema } from "@/contracts/schemas";
import type { GenerateAutomationCodeRequest, PrepareGenerateAutomationCodeRequest } from "@/contracts/schemas";
import { automationManager } from "../../core/automation-manager";
import { generateDeterministicAutomationCode } from "../../core/deterministic-automation-generation";
import { isDomainError } from "../../domain/domain-error";
import { domainErrorResponse, errorResponse, requireWorkspace } from "../helpers";
import { resolveDomainErrorHttpMapping } from "../domain-error-policy";
import { parseAndValidate } from "../validation";
import { validateAutomationModel } from "./helpers";

const log = createLogger("api:automations");
const GENERATE_CODE_HEARTBEAT_INTERVAL_MS = 4_000;

interface PreparedGenerateAutomationCode {
  name: string;
  prompt: string;
  previousCode: string;
  workspaceId: string;
  directory: string;
  model: {
    providerID: string;
    modelID: string;
    variant: string;
  };
  chatId: string;
  message?: string;
  attachments: GenerateAutomationCodeRequest["attachments"];
}

interface GenerateAutomationCodeErrorPayload {
  error: string;
  message: string;
  diagnostics?: unknown;
  status?: number;
}

interface GenerationTarget {
  workspace: Workspace;
  model: {
    providerID: string;
    modelID: string;
    variant: string;
  };
}

async function resolveGenerationTarget(
  automation: Automation,
  requestedWorkspaceId: string | undefined,
  requestedModel: GenerateAutomationCodeRequest["model"] | PrepareGenerateAutomationCodeRequest["model"],
): Promise<GenerationTarget | Response> {
  const workspaceId = automation.config.workspaceId;
  if (requestedWorkspaceId && requestedWorkspaceId !== workspaceId) {
    return errorResponse("workspace_mismatch", "The generation workspace must match the saved automation", 400);
  }
  if (!workspaceId) {
    return errorResponse("workspace_required", "Select a workspace before generating code", 400);
  }
  const workspace = await requireWorkspace(workspaceId);
  if (workspace instanceof Response) {
    return workspace;
  }
  const model = requestedModel ?? automation.config.model;
  if (!model) {
    return errorResponse("model_required", "Select a model before generating code", 400);
  }
  const modelValidation = await validateAutomationModel(workspaceId, model);
  if (modelValidation) {
    return modelValidation;
  }
  return {
    workspace,
    model: {
      providerID: model.providerID,
      modelID: model.modelID,
      variant: model.variant ?? "",
    },
  };
}

async function resetGenerationChat(
  automation: Automation,
  model: GenerationTarget["model"],
): Promise<Chat | Response> {
  try {
    return await automationManager.resetGenerationChat(automation.config.id, { model });
  } catch (error) {
    log.error("Failed to reset the deterministic automation generation chat", {
      automationId: automation.config.id,
      error: String(error),
    });
    return domainErrorResponse(error, {
      policy: "automations",
      fallback: {
        error: "generation_chat_failed",
        message: "Failed to prepare the generation conversation",
        status: 500,
      },
    });
  }
}

async function prepareGenerateAutomationCode(
  req: Request,
  automation: Automation | null,
): Promise<PreparedGenerateAutomationCode | Response> {
  const validation = await parseAndValidate(GenerateAutomationCodeRequestSchema, req, { allowEmptyBody: true });
  if (!validation.success) {
    return validation.response;
  }
  if (!automation) {
    return errorResponse("automation_required", "Save the automation before generating code", 400);
  }

  const body = validation.data;
  const target = await resolveGenerationTarget(automation, body.workspaceId, body.model);
  if (target instanceof Response) {
    return target;
  }

  let chatId = body.chatId;
  if (chatId) {
    if (chatId !== automation.config.generationChatId) {
      return errorResponse("generation_chat_mismatch", "The generation conversation is no longer current", 409);
    }
    const chat = await automationManager.getGenerationChat(automation.config.id);
    if (!chat || chat.config.id !== chatId) {
      return errorResponse("generation_chat_not_found", "The generation conversation no longer exists", 404);
    }
    const hasFollowUpContent = body.message !== undefined || body.attachments.length > 0;
    if (body.generationMode === "initial" && hasFollowUpContent) {
      return errorResponse("generation_mode_invalid", "Initial generation cannot include a follow-up message", 400);
    }
    if (body.generationMode !== "initial" && !hasFollowUpContent) {
      return errorResponse("generation_message_required", "Enter a message to continue the generation conversation", 400);
    }
  } else {
    if (body.generationMode === "follow_up") {
      return errorResponse("generation_mode_invalid", "Follow-ups require an existing generation conversation", 400);
    }
    const chat = await resetGenerationChat(automation, target.model);
    if (chat instanceof Response) {
      return chat;
    }
    chatId = chat.config.id;
  }

  return {
    name: body.name ?? automation.config.name,
    workspaceId: automation.config.workspaceId,
    directory: target.workspace.directory,
    model: target.model,
    prompt: body.prompt ?? automation.config.prompt,
    previousCode: body.previousCode ?? automation.config.code ?? "",
    chatId,
    message: body.message,
    attachments: body.attachments,
  };
}

async function prepareGenerationChat(
  req: Request,
  automation: Automation | null,
): Promise<Response> {
  const validation = await parseAndValidate(
    PrepareGenerateAutomationCodeRequestSchema,
    req,
    { allowEmptyBody: true },
  );
  if (!validation.success) {
    return validation.response;
  }
  if (!automation) {
    return errorResponse("automation_required", "Save the automation before generating code", 400);
  }

  const body = validation.data;
  const target = await resolveGenerationTarget(automation, body.workspaceId, body.model);
  if (target instanceof Response) {
    return target;
  }
  const chat = await resetGenerationChat(automation, target.model);
  if (chat instanceof Response) {
    return chat;
  }
  return Response.json({ chatId: chat.config.id });
}

async function mapGenerateAutomationCodeError(
  error: unknown,
  automationId?: string,
): Promise<{ status: number; payload: GenerateAutomationCodeErrorPayload }> {
  if (isDomainError(error) && error.code === "automation_code_invalid") {
    const mapping = resolveDomainErrorHttpMapping(error, {
      policy: "automations",
      fallback: {
        message: "Automation code is invalid",
      },
    });
    return {
      status: mapping?.status ?? 400,
      payload: {
        error: mapping?.error ?? "automation_code_invalid",
        message: mapping?.message ?? "Automation code is invalid",
        diagnostics: mapping?.extra?.["diagnostics"] ?? [],
      },
    };
  }

  const response = domainErrorResponse(error, {
    policy: "automations",
    fallback: {
      error: "generate_automation_code_failed",
      message: "Failed to generate automation code",
      status: 500,
    },
  });
  if (response.status >= 500) {
    log.error("Failed to generate automation code", {
      automationId,
      error: String(error),
    });
  }
  return {
    status: response.status,
    payload: {
      ...(await response.json() as GenerateAutomationCodeErrorPayload),
      status: response.status,
    },
  };
}

function createGenerateAutomationCodeStream(
  req: Request,
  prepared: PreparedGenerateAutomationCode,
  automationId: string,
): Response {
  const encoder = new TextEncoder();
  const executionController = new AbortController();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let streamClosed = false;

  const abortExecution = () => {
    executionController.abort();
  };
  const cleanup = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    req.signal.removeEventListener("abort", abortExecution);
  };
  const closeStream = () => {
    if (streamClosed) {
      return;
    }
    streamClosed = true;
    cleanup();
    streamController?.close();
  };

  req.signal.addEventListener("abort", abortExecution, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(encoder.encode("\n"));
      heartbeatTimer = setInterval(() => {
        if (!streamClosed) {
          controller.enqueue(encoder.encode(" "));
        }
      }, GENERATE_CODE_HEARTBEAT_INTERVAL_MS);

      void (async () => {
        try {
          const generated = await generateDeterministicAutomationCode({
            ...prepared,
            signal: executionController.signal,
          });
          const chat = await automationManager.getGenerationChat(automationId);
          if (!chat || chat.config.id !== prepared.chatId) {
            throw new Error("Generation chat disappeared before the result was returned");
          }
          if (streamClosed) {
            return;
          }
          controller.enqueue(encoder.encode(JSON.stringify({ ...generated, chat })));
          closeStream();
        } catch (error) {
          if (streamClosed || executionController.signal.aborted) {
            closeStream();
            return;
          }
          const failure = await mapGenerateAutomationCodeError(error, automationId);
          if (streamClosed) {
            return;
          }
          controller.enqueue(encoder.encode(JSON.stringify(failure.payload)));
          closeStream();
        }
      })();
    },
    cancel() {
      streamClosed = true;
      cleanup();
      executionController.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Clanky-Generation-Chat-Id": prepared.chatId,
    },
  });
}

async function generateAutomationCodeResponse(
  req: Request,
  automation: Automation | null,
  automationId?: string,
): Promise<Response> {
  const prepared = await prepareGenerateAutomationCode(req, automation);
  if (prepared instanceof Response) {
    return prepared;
  }

  return createGenerateAutomationCodeStream(req, prepared, automationId ?? automation!.config.id);
}

export const generationRoutes = defineRoutes({
  "/api/automations/code/generate": {
    delegation: workspaceOperation("automation"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Reject generation for unsaved automations.",
    operations: {
      POST: {
        requestSchema: GenerateAutomationCodeRequestSchema,
        querySchema: undefined,
        automation: { policy: "excluded", reason: "Unsaved-automation compatibility endpoint always rejects generation; use a saved automation." },
      },
    },
    async POST(req: Request, ctx): Promise<Response> {
      ctx.server?.timeout(req, 0);
      return generateAutomationCodeResponse(req, null);
    },
  },

  "/api/automations/:id/code/generate/prepare": {
    delegation: workspaceOperation("automation"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Prepare the hidden deterministic-automation generation conversation before a long generation request.",
    operations: {
      POST: {
        requestSchema: PrepareGenerateAutomationCodeRequestSchema,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "Resets the automation's existing generation conversation." },
      },
    },
    async POST(req: Request, ctx): Promise<Response> {
      const automation = await automationManager.getAutomation(ctx.params["id"]!);
      if (!automation) {
        return errorResponse("automation_not_found", "Automation not found", 404);
      }
      return prepareGenerationChat(req, automation);
    },
  },

  "/api/automations/:id/code/generate": {
    delegation: workspaceOperation("automation"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Generate an editable deterministic automation program without saving it.",
    operations: {
      POST: {
        requestSchema: GenerateAutomationCodeRequestSchema,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "May reset the generation conversation and run automation code-generation work." },
      },
    },
    async POST(req: Request, ctx): Promise<Response> {
      ctx.server?.timeout(req, 0);
      const automation = await automationManager.getAutomation(ctx.params["id"]!);
      if (!automation) {
        return errorResponse("automation_not_found", "Automation not found", 404);
      }
      return generateAutomationCodeResponse(req, automation, ctx.params["id"]!);
    },
  },
});
