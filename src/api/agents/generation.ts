/**
 * Scheduled-agent code generation API routes.
 */

import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import type { Agent } from "@/shared/agent";
import type { Chat } from "@/shared/chat";
import type { Workspace } from "@/shared/workspace";
import { GenerateAgentCodeRequestSchema, PrepareGenerateAgentCodeRequestSchema } from "@/contracts/schemas";
import type { GenerateAgentCodeRequest, PrepareGenerateAgentCodeRequest } from "@/contracts/schemas";
import { agentManager } from "../../core/agent-manager";
import { generateDeterministicAgentCode } from "../../core/deterministic-agent-generation";
import { isDomainError } from "../../core/domain-error";
import { domainErrorResponse, errorResponse, requireWorkspace } from "../helpers";
import { resolveDomainErrorHttpMapping } from "../domain-error-policy";
import { parseAndValidate } from "../validation";
import { validateAgentModel } from "./helpers";

const log = createLogger("api:agents");
const GENERATE_CODE_HEARTBEAT_INTERVAL_MS = 4_000;

interface PreparedGenerateAgentCode {
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
  attachments: GenerateAgentCodeRequest["attachments"];
}

interface GenerateAgentCodeErrorPayload {
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
  agent: Agent,
  requestedWorkspaceId: string | undefined,
  requestedModel: GenerateAgentCodeRequest["model"] | PrepareGenerateAgentCodeRequest["model"],
): Promise<GenerationTarget | Response> {
  const workspaceId = agent.config.workspaceId;
  if (requestedWorkspaceId && requestedWorkspaceId !== workspaceId) {
    return errorResponse("workspace_mismatch", "The generation workspace must match the saved agent", 400);
  }
  if (!workspaceId) {
    return errorResponse("workspace_required", "Select a workspace before generating code", 400);
  }
  const workspace = await requireWorkspace(workspaceId);
  if (workspace instanceof Response) {
    return workspace;
  }
  const model = requestedModel ?? agent.config.model;
  if (!model) {
    return errorResponse("model_required", "Select a model before generating code", 400);
  }
  const modelValidation = await validateAgentModel(workspaceId, model);
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
  agent: Agent,
  model: GenerationTarget["model"],
): Promise<Chat | Response> {
  try {
    return await agentManager.resetGenerationChat(agent.config.id, { model });
  } catch (error) {
    log.error("Failed to reset the deterministic agent generation chat", {
      agentId: agent.config.id,
      error: String(error),
    });
    return domainErrorResponse(error, {
      policy: "agents",
      fallback: {
        error: "generation_chat_failed",
        message: "Failed to prepare the generation conversation",
        status: 500,
      },
    });
  }
}

async function prepareGenerateAgentCode(
  req: Request,
  agent: Agent | null,
): Promise<PreparedGenerateAgentCode | Response> {
  const validation = await parseAndValidate(GenerateAgentCodeRequestSchema, req, { allowEmptyBody: true });
  if (!validation.success) {
    return validation.response;
  }
  if (!agent) {
    return errorResponse("agent_required", "Save the agent before generating code", 400);
  }

  const body = validation.data;
  const target = await resolveGenerationTarget(agent, body.workspaceId, body.model);
  if (target instanceof Response) {
    return target;
  }

  let chatId = body.chatId;
  if (chatId) {
    if (chatId !== agent.config.generationChatId) {
      return errorResponse("generation_chat_mismatch", "The generation conversation is no longer current", 409);
    }
    const chat = await agentManager.getGenerationChat(agent.config.id);
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
    const chat = await resetGenerationChat(agent, target.model);
    if (chat instanceof Response) {
      return chat;
    }
    chatId = chat.config.id;
  }

  return {
    name: body.name ?? agent.config.name,
    workspaceId: agent.config.workspaceId,
    directory: target.workspace.directory,
    model: target.model,
    prompt: body.prompt ?? agent.config.prompt,
    previousCode: body.previousCode ?? agent.config.code ?? "",
    chatId,
    message: body.message,
    attachments: body.attachments,
  };
}

async function prepareGenerationChat(
  req: Request,
  agent: Agent | null,
): Promise<Response> {
  const validation = await parseAndValidate(
    PrepareGenerateAgentCodeRequestSchema,
    req,
    { allowEmptyBody: true },
  );
  if (!validation.success) {
    return validation.response;
  }
  if (!agent) {
    return errorResponse("agent_required", "Save the agent before generating code", 400);
  }

  const body = validation.data;
  const target = await resolveGenerationTarget(agent, body.workspaceId, body.model);
  if (target instanceof Response) {
    return target;
  }
  const chat = await resetGenerationChat(agent, target.model);
  if (chat instanceof Response) {
    return chat;
  }
  return Response.json({ chatId: chat.config.id });
}

async function mapGenerateAgentCodeError(
  error: unknown,
  agentId?: string,
): Promise<{ status: number; payload: GenerateAgentCodeErrorPayload }> {
  if (isDomainError(error) && error.code === "agent_code_invalid") {
    const mapping = resolveDomainErrorHttpMapping(error, {
      policy: "agents",
      fallback: {
        message: "Agent code is invalid",
      },
    });
    return {
      status: mapping?.status ?? 400,
      payload: {
        error: mapping?.error ?? "agent_code_invalid",
        message: mapping?.message ?? "Agent code is invalid",
        diagnostics: mapping?.extra?.["diagnostics"] ?? [],
      },
    };
  }

  const response = domainErrorResponse(error, {
    policy: "agents",
    fallback: {
      error: "generate_agent_code_failed",
      message: "Failed to generate agent code",
      status: 500,
    },
  });
  if (response.status >= 500) {
    log.error("Failed to generate agent code", {
      agentId,
      error: String(error),
    });
  }
  return {
    status: response.status,
    payload: {
      ...(await response.json() as GenerateAgentCodeErrorPayload),
      status: response.status,
    },
  };
}

function createGenerateAgentCodeStream(
  req: Request,
  prepared: PreparedGenerateAgentCode,
  agentId: string,
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
          const generated = await generateDeterministicAgentCode({
            ...prepared,
            signal: executionController.signal,
          });
          const chat = await agentManager.getGenerationChat(agentId);
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
          const failure = await mapGenerateAgentCodeError(error, agentId);
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

async function generateAgentCodeResponse(
  req: Request,
  agent: Agent | null,
  agentId?: string,
): Promise<Response> {
  const prepared = await prepareGenerateAgentCode(req, agent);
  if (prepared instanceof Response) {
    return prepared;
  }

  return createGenerateAgentCodeStream(req, prepared, agentId ?? agent!.config.id);
}

export const generationRoutes = defineRoutes({
  "/api/agents/code/generate": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Reject generation for unsaved agents.",
    async POST(req: Request, ctx): Promise<Response> {
      ctx.server?.timeout(req, 0);
      return generateAgentCodeResponse(req, null);
    },
  },

  "/api/agents/:id/code/generate/prepare": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Prepare the hidden deterministic-agent generation conversation before a long generation request.",
    async POST(req: Request, ctx): Promise<Response> {
      const agent = await agentManager.getAgent(ctx.params["id"]!);
      if (!agent) {
        return errorResponse("agent_not_found", "Agent not found", 404);
      }
      return prepareGenerationChat(req, agent);
    },
  },

  "/api/agents/:id/code/generate": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Generate an editable deterministic agent program without saving it.",
    async POST(req: Request, ctx): Promise<Response> {
      ctx.server?.timeout(req, 0);
      const agent = await agentManager.getAgent(ctx.params["id"]!);
      if (!agent) {
        return errorResponse("agent_not_found", "Agent not found", 404);
      }
      return generateAgentCodeResponse(req, agent, ctx.params["id"]!);
    },
  },
});
