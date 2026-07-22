import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Scheduled agents API routes.
 */

import type { Agent } from "@/shared/agent";
import type { AgentRunStatus } from "@/shared/agent";
import type { DeterministicAgentTestResult, DeterministicAgentTestStreamEvent } from "@/shared/deterministic-agent";
import type { TaskLogEntry } from "@/shared/task";
import type { Workspace } from "@/shared/workspace";
import { AgentRunsQuerySchema, CreateAgentRequestSchema, DeleteAgentRunsRequestSchema, GenerateAgentCodeRequestSchema, RunAgentRequestSchema, TestAgentCodeRequestSchema, UpdateAgentRequestSchema } from "@/contracts/schemas";
import type { TestAgentCodeRequest } from "@/contracts/schemas";
import { agentManager } from "../core/agent-manager";
import { createLogger } from "@pablozaiden/webapp/server";
import { isModelEnabled } from "../core/model-discovery";
import { domainErrorResponse, errorResponse, internalErrorResponse, requireWorkspace, successResponse } from "./helpers";
import { parseAndValidate, validateRequest } from "./validation";
import { generateDeterministicAgentCode } from "../core/deterministic-agent-generation";
import { testDeterministicAgentCode } from "../core/deterministic-agent-test";
import { isDomainError } from "../core/domain-error";

const log = createLogger("api:agents");
const GENERATE_CODE_HEARTBEAT_INTERVAL_MS = 4_000;
const TEST_CODE_HEARTBEAT_INTERVAL_MS = 4_000;

async function validateAgentModel(workspaceId: string, model: {
  providerID: string;
  modelID: string;
  variant?: string;
}): Promise<Response | null> {
  const workspace = await requireWorkspace(workspaceId);
  if (workspace instanceof Response) {
    return workspace;
  }
  const modelValidation = await isModelEnabled(
    workspace.id,
    model.providerID,
    model.modelID,
  );
  if (!modelValidation.enabled) {
    return errorResponse(
      modelValidation.errorCode ?? "model_not_enabled",
      modelValidation.error ?? "The selected model is not available",
    );
  }
  return null;
}

interface PreparedGenerateAgentCode {
  name: string;
  prompt: string;
  comments: string;
  previousCode: string;
  workspaceId: string;
  directory: string;
  model: {
    providerID: string;
    modelID: string;
    variant: string;
  };
}

interface GenerateAgentCodeErrorPayload {
  error: string;
  message: string;
  diagnostics?: unknown;
  status?: number;
}

async function prepareGenerateAgentCode(
  req: Request,
  agent: Agent | null,
): Promise<PreparedGenerateAgentCode | Response> {
  const validation = await parseAndValidate(GenerateAgentCodeRequestSchema, req, { allowEmptyBody: true });
  if (!validation.success) {
    return validation.response;
  }

  const body = validation.data;
  const workspaceId = body.workspaceId ?? agent?.config.workspaceId;
  if (!workspaceId) {
    return errorResponse("workspace_required", "Select a workspace before generating code", 400);
  }
  const workspace = await requireWorkspace(workspaceId);
  if (workspace instanceof Response) {
    return workspace;
  }
  const model = body.model ?? agent?.config.model;
  if (!model) {
    return errorResponse("model_required", "Select a model before generating code", 400);
  }
  const modelValidation = await validateAgentModel(workspaceId, model);
  if (modelValidation) {
    return modelValidation;
  }

  return {
    name: body.name ?? agent?.config.name ?? "Draft deterministic agent",
    workspaceId,
    directory: workspace.directory,
    model: {
      ...model,
      variant: model.variant ?? "",
    },
    prompt: body.prompt ?? agent?.config.prompt ?? "",
    comments: body.comments ?? "",
    previousCode: body.previousCode ?? agent?.config.code ?? "",
  };
}

async function mapGenerateAgentCodeError(
  error: unknown,
  agentId?: string,
): Promise<{ status: number; payload: GenerateAgentCodeErrorPayload }> {
  if (isDomainError(error) && error.code === "agent_code_invalid") {
    return {
      status: 400,
      payload: {
        error: "agent_code_invalid",
        message: error.message,
        diagnostics: error.details["diagnostics"] ?? [],
      },
    };
  }

  const response = domainErrorResponse(error, {
    mappings: {
      agent_code_generation_failed: {
        error: "agent_code_generation_failed",
        status: 502,
      },
    },
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
  agentId: string | undefined,
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
          if (streamClosed) {
            return;
          }
          controller.enqueue(encoder.encode(JSON.stringify(generated)));
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

  return createGenerateAgentCodeStream(req, prepared, agentId);
}

interface PreparedDeterministicAgentTest {
  body: TestAgentCodeRequest;
  workspace: Workspace;
}

async function prepareDeterministicAgentTest(
  req: Request,
): Promise<PreparedDeterministicAgentTest | Response> {
  const validation = await parseAndValidate(TestAgentCodeRequestSchema, req);
  if (!validation.success) {
    return validation.response;
  }

  const body = validation.data;
  const workspace = await requireWorkspace(body.workspaceId);
  if (workspace instanceof Response) {
    return workspace;
  }
  const modelValidation = await validateAgentModel(body.workspaceId, body.model);
  if (modelValidation) {
    return modelValidation;
  }
  return { body, workspace };
}

function testOptionsFromPrepared(
  prepared: PreparedDeterministicAgentTest,
  options: {
    signal?: AbortSignal;
    userId?: string;
    onOutput?: (entry: TaskLogEntry) => void;
  } = {},
) {
  const { body, workspace } = prepared;
  return {
    name: body.name ?? "Draft deterministic agent",
    prompt: body.prompt,
    code: body.code,
    workspaceId: body.workspaceId,
    directory: workspace.directory,
    model: body.model,
    baseBranch: body.baseBranch,
    useWorktree: body.useWorktree,
    testRunId: body.testRunId,
    ...options,
  };
}

function createDeterministicAgentTestJsonResponse(
  req: Request,
  prepared: PreparedDeterministicAgentTest,
  userId: string,
): Response {
  const encoder = new TextEncoder();
  const executionController = new AbortController();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let streamClosed = false;
  let clientDisconnected = false;

  const cleanup = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    req.signal.removeEventListener("abort", abortExecution);
  };
  const abortExecution = () => {
    clientDisconnected = true;
    executionController.abort();
    streamClosed = true;
    cleanup();
  };
  req.signal.addEventListener("abort", abortExecution, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (clientDisconnected) {
        streamClosed = true;
        cleanup();
        return;
      }
      controller.enqueue(encoder.encode("\n"));
      heartbeatTimer = setInterval(() => {
        if (!streamClosed && !clientDisconnected) {
          controller.enqueue(encoder.encode(" "));
        }
      }, TEST_CODE_HEARTBEAT_INTERVAL_MS);

      void (async () => {
        try {
          const result = await testDeterministicAgentCode({
            ...testOptionsFromPrepared(prepared),
            userId,
            signal: executionController.signal,
          });
          if (!streamClosed) {
            controller.enqueue(encoder.encode(JSON.stringify(result)));
          }
        } catch (error) {
          if (!streamClosed && !executionController.signal.aborted) {
            log.error("Failed to test deterministic agent code", {
              workspaceId: prepared.body.workspaceId,
              error: String(error),
            });
            controller.enqueue(encoder.encode(JSON.stringify({
              error: "test_agent_code_failed",
              message: "Failed to test agent code",
            })));
          }
        } finally {
          cleanup();
          if (!streamClosed && !clientDisconnected) {
            streamClosed = true;
            controller.close();
          }
        }
      })();
    },
    cancel() {
      abortExecution();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "application/json; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}

function createDeterministicAgentTestStream(
  req: Request,
  prepared: PreparedDeterministicAgentTest,
  userId: string,
): Response {
  const encoder = new TextEncoder();
  const executionController = new AbortController();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let streamClosed = false;
  let clientDisconnected = false;

  const cleanup = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    req.signal.removeEventListener("abort", abortExecution);
  };

  const abortExecution = () => {
    clientDisconnected = true;
    executionController.abort();
    streamClosed = true;
    cleanup();
  };
  req.signal.addEventListener("abort", abortExecution, { once: true });

  const enqueue = (event: DeterministicAgentTestStreamEvent): void => {
    if (streamClosed || clientDisconnected || !streamController) {
      return;
    }
    streamController.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (clientDisconnected) {
        streamClosed = true;
        cleanup();
        return;
      }
      controller.enqueue(encoder.encode("\n"));
      heartbeatTimer = setInterval(() => {
        if (!streamClosed && !clientDisconnected) {
          controller.enqueue(encoder.encode("\n"));
        }
      }, TEST_CODE_HEARTBEAT_INTERVAL_MS);

      void (async () => {
        try {
          const result = await testDeterministicAgentCode({
            ...testOptionsFromPrepared(prepared),
            userId,
            signal: executionController.signal,
            onOutput: (entry) => enqueue({ type: "log", log: entry }),
          });
          enqueue({ type: "result", result });
        } catch (error) {
          log.error("Failed to stream deterministic agent code test", {
            workspaceId: prepared.body.workspaceId,
            error: String(error),
          });
          const result: DeterministicAgentTestResult = {
            status: "failed",
            logs: [],
            error: "Failed to test agent code",
            diagnostics: [],
          };
          enqueue({ type: "result", result });
        } finally {
          cleanup();
          if (!clientDisconnected && !streamClosed) {
            streamClosed = true;
            controller.close();
          }
        }
      })();
    },
    cancel() {
      abortExecution();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}

function mapPurgeStatuses(body: {
  includeCompleted: boolean;
  includeFailed: boolean;
  includeSkipped: boolean;
  includeInterrupted: boolean;
  includeCancelled: boolean;
}): AgentRunStatus[] {
  const statuses: AgentRunStatus[] = [];
  if (body.includeCompleted) {
    statuses.push("completed");
  }
  if (body.includeFailed) {
    statuses.push("failed");
  }
  if (body.includeSkipped) {
    statuses.push("skipped");
  }
  if (body.includeInterrupted) {
    statuses.push("interrupted");
  }
  if (body.includeCancelled) {
    statuses.push("cancelled");
  }
  return statuses;
}

export const agentsRoutes = defineRoutes({
  "/api/agents": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List or create scheduled agents.",
    async GET(req: Request, _ctx): Promise<Response> {
      const url = new URL(req.url);
      const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
      const agents = await agentManager.getAgents(workspaceId);
      return Response.json(agents);
    },

    async POST(req: Request, _ctx): Promise<Response> {
      const validation = await parseAndValidate(CreateAgentRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      const body = validation.data;
      const modelValidation = await validateAgentModel(body.workspaceId, body.model);
      if (modelValidation) {
        return modelValidation;
      }

      try {
        const agent = await agentManager.createAgent(body);
        return Response.json(agent, { status: 201 });
      } catch (error) {
        const response = internalErrorResponse(error, {
          error: "create_agent_failed",
          message: "Failed to create agent",
          status: 500,
        }, {
          agent_code_invalid: {
            error: "agent_code_invalid",
            status: 400,
          },
        });
        if (response.status >= 500) {
          log.error("Failed to create agent", {
            workspaceId: body.workspaceId,
            error: String(error),
          });
        } else {
          log.warn("Rejected agent creation", {
            workspaceId: body.workspaceId,
            error: String(error),
          });
        }
        return response;
      }
    },
  },

  "/api/agents/code/generate": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Generate an editable deterministic agent program before saving an agent.",
    async POST(req: Request, ctx): Promise<Response> {
      ctx.server?.timeout(req, 0);
      return generateAgentCodeResponse(req, null);
    },
  },

  "/api/agents/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read, update, or delete a scheduled agent.",
    async GET(_req: Request, ctx): Promise<Response> {
      const agent = await agentManager.getAgent(ctx.params["id"]!);
      if (!agent) {
        return errorResponse("agent_not_found", "Agent not found", 404);
      }
      return Response.json(agent);
    },

    async PATCH(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(UpdateAgentRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      const existing = await agentManager.getAgent(ctx.params["id"]!);
      if (!existing) {
        return errorResponse("agent_not_found", "Agent not found", 404);
      }
      const body = validation.data;
      if (body.model) {
        const modelValidation = await validateAgentModel(existing.config.workspaceId, body.model);
        if (modelValidation) {
          return modelValidation;
        }
      }

      try {
        const agent = await agentManager.updateAgent(ctx.params["id"]!, body);
        if (!agent) {
          return errorResponse("agent_not_found", "Agent not found", 404);
        }
        return Response.json(agent);
      } catch (error) {
        const response = internalErrorResponse(error, {
          error: "update_agent_failed",
          message: "Failed to update agent",
          status: 500,
        }, {
          agent_code_invalid: {
            error: "agent_code_invalid",
            status: 400,
          },
        });
        if (response.status >= 500) {
          log.error("Failed to update agent", {
            agentId: ctx.params["id"]!,
            error: String(error),
          });
        } else {
          log.warn("Rejected agent update", {
            agentId: ctx.params["id"]!,
            error: String(error),
          });
        }
        return response;
      }
    },

    async DELETE(_req: Request, ctx): Promise<Response> {
      try {
        const deleted = await agentManager.deleteAgent(ctx.params["id"]!);
        if (!deleted) {
          return errorResponse("agent_not_found", "Agent not found", 404);
        }
        return successResponse();
      } catch (error) {
        log.error("Failed to delete agent", {
          agentId: ctx.params["id"]!,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "delete_agent_failed",
          message: "Failed to delete agent",
          status: 500,
        });
      }
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

  "/api/agents/code/test": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Test deterministic agent code without saving an agent or run.",
    async POST(req: Request, ctx): Promise<Response> {
      ctx.server?.timeout(req, 0);
      const prepared = await prepareDeterministicAgentTest(req);
      if (prepared instanceof Response) {
        return prepared;
      }
      return createDeterministicAgentTestJsonResponse(req, prepared, ctx.requireUser().id);
    },
  },

  "/api/agents/code/test/stream": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Stream deterministic agent code test output without saving an agent or run.",
    async POST(req: Request, ctx): Promise<Response> {
      ctx.server?.timeout(req, 0);
      const prepared = await prepareDeterministicAgentTest(req);
      if (prepared instanceof Response) {
        return prepared;
      }
      return createDeterministicAgentTestStream(req, prepared, ctx.requireUser().id);
    },
  },

  "/api/agents/:id/run": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Start an agent run immediately.",
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(RunAgentRequestSchema, req, { allowEmptyBody: true });
      if (!validation.success) {
        return validation.response;
      }

      try {
        const run = await agentManager.runNow(ctx.params["id"]!, validation.data.attachments);
        return Response.json(run, { status: 202 });
      } catch (error) {
        const response = domainErrorResponse(error, {
          mappings: {
            agent_not_found: {
              error: "agent_not_found",
              message: "Agent not found",
              status: 404,
            },
            agent_already_running: {
              error: "agent_already_running",
              status: 409,
            },
          },
          fallback: {
            error: "run_agent_failed",
            message: "Failed to run agent",
            status: 500,
          },
        });
        if (response.status >= 500) {
          log.error("Failed to run agent", {
            agentId: ctx.params["id"]!,
            error: String(error),
          });
        }
        return response;
      }
    },
  },

  "/api/agents/:id/interrupt": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Interrupt an active agent run.",
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const run = await agentManager.interruptAgent(ctx.params["id"]!, "Agent run interrupted by user");
        if (!run) {
          return errorResponse("no_active_agent_run", "Agent does not have an active run", 409);
        }
        return Response.json(run);
      } catch (error) {
        const response = domainErrorResponse(error, {
          mappings: {
            agent_run_not_ready: {
              error: "agent_run_not_ready",
              status: 409,
            },
            agent_chat_not_found: {
              error: "agent_run_not_ready",
              message: "Agent run chat is no longer available",
              status: 409,
            },
          },
          fallback: {
            error: "interrupt_agent_failed",
            message: "Failed to interrupt agent",
            status: 500,
          },
        });
        if (response.status >= 500) {
          log.error("Failed to interrupt agent", {
            agentId: ctx.params["id"]!,
            error: String(error),
          });
        }
        return response;
      }
    },
  },

  "/api/agents/:id/pause": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Pause a scheduled agent.",
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const agent = await agentManager.pauseAgent(ctx.params["id"]!);
        if (!agent) {
          return errorResponse("agent_not_found", "Agent not found", 404);
        }
        return Response.json(agent);
      } catch (error) {
        log.error("Failed to pause agent", {
          agentId: ctx.params["id"]!,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "pause_agent_failed",
          message: "Failed to pause agent",
          status: 500,
        });
      }
    },
  },

  "/api/agents/:id/resume": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Resume a paused scheduled agent.",
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const agent = await agentManager.resumeAgent(ctx.params["id"]!);
        if (!agent) {
          return errorResponse("agent_not_found", "Agent not found", 404);
        }
        return Response.json(agent);
      } catch (error) {
        log.error("Failed to resume agent", {
          agentId: ctx.params["id"]!,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "resume_agent_failed",
          message: "Failed to resume agent",
          status: 500,
        });
      }
    },
  },

  "/api/agents/:id/runs": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List or purge runs for an agent.",
    async GET(req: Request, ctx): Promise<Response> {
      const parsedQuery = validateRequest(
        AgentRunsQuerySchema,
        Object.fromEntries(new URL(req.url).searchParams),
      );
      if (!parsedQuery.success) {
        return parsedQuery.response;
      }
      const agent = await agentManager.getAgent(ctx.params["id"]!);
      if (!agent) {
        return errorResponse("agent_not_found", "Agent not found", 404);
      }
      const runs = await agentManager.listRuns(ctx.params["id"]!, parsedQuery.data);
      return Response.json(runs);
    },

    async DELETE(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(DeleteAgentRunsRequestSchema, req, { allowEmptyBody: true });
      if (!validation.success) {
        return validation.response;
      }
      const statuses = mapPurgeStatuses(validation.data);
      if (statuses.length === 0) {
        return successResponse({ deletedRunIds: [] });
      }
      const deletedRunIds = await agentManager.purgeRuns(ctx.params["id"]!, {
        before: validation.data.before,
        statuses,
      });
      return successResponse({ deletedRunIds });
    },
  },

  "/api/agent-runs/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read or delete an agent run.",
    async GET(_req: Request, ctx): Promise<Response> {
      const run = await agentManager.getRun(ctx.params["id"]!);
      if (!run) {
        return errorResponse("agent_run_not_found", "Agent run not found", 404);
      }
      return Response.json(run);
    },

    async DELETE(_req: Request, ctx): Promise<Response> {
      const deleted = await agentManager.deleteRun(ctx.params["id"]!);
      if (!deleted) {
        return errorResponse("agent_run_not_found", "Agent run not found", 404);
      }
      return successResponse();
    },
  },
});
