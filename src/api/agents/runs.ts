/**
 * Scheduled-agent run and deterministic code-test API routes.
 */

import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import type { AgentRun, AgentRunStatus } from "@/shared/agent";
import type { DeterministicAgentTestResult, DeterministicAgentTestStreamEvent } from "@/shared/deterministic-agent";
import type { TaskLogEntry } from "@/shared/task";
import type { Workspace } from "@/shared/workspace";
import { AgentRunsQuerySchema, DeleteAgentRunsRequestSchema, RunAgentRequestSchema, TestAgentCodeRequestSchema } from "@/contracts/schemas";
import type { TestAgentCodeRequest } from "@/contracts/schemas";
import { agentManager } from "../../core/agent-manager";
import { isDomainError } from "../../core/domain-error";
import { testDeterministicAgentCode } from "../../core/deterministic-agent-test";
import { assertWorktreesAllowed, isGitBackedWorkspace } from "../../core/workspace-capabilities";
import { domainErrorResponse, errorResponse, internalErrorResponse, requireWorkspace, successResponse } from "../helpers";
import { parseAndValidate, validateRequest } from "../validation";
import { validateAgentModel } from "./helpers";

const log = createLogger("api:agents");
export const TEST_CODE_HEARTBEAT_INTERVAL_MS = 4_000;

async function toLightweightAgentRun(run: AgentRun): Promise<AgentRun> {
  const summary = await agentManager.getRunSummary(run.id);
  if (!summary) {
    throw new Error(`Agent run disappeared after mutation: ${run.id}`);
  }
  return summary;
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
  if (
    !isGitBackedWorkspace(workspace)
    && (body.useWorktree || body.baseBranch !== undefined)
  ) {
    return errorResponse(
      "workspace_git_required",
      "Directory workspaces do not support branches or worktrees.",
      409,
    );
  }
  if (body.useWorktree) {
    try {
      assertWorktreesAllowed(workspace);
    } catch (error) {
      if (isDomainError(error)) {
        return domainErrorResponse(error, {
          policy: "agents",
          fallback: {
            error: error.code,
            message: "The workspace configuration is not valid for this operation.",
            status: 409,
          },
        });
      }
      throw error;
    }
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

export const runsRoutes = defineRoutes({
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
        return Response.json(await toLightweightAgentRun(run), { status: 202 });
      } catch (error) {
        const response = domainErrorResponse(error, {
          policy: "agents",
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
        return Response.json(await toLightweightAgentRun(run));
      } catch (error) {
        const response = domainErrorResponse(error, {
          policy: "agents",
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
      const run = await agentManager.getRunSummary(ctx.params["id"]!);
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
