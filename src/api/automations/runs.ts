import { workspaceOperation } from "../workspace-delegation";
import { executionAutomation } from "../execution-automation";
/**
 * Scheduled-automation run and deterministic code-test API routes.
 */

import { defineRoutes } from "@/platform/server";
import { createLogger } from "@pablozaiden/webapp/server";
import type { AutomationRun, AutomationRunStatus } from "@/shared/automation";
import type { DeterministicAutomationTestResult, DeterministicAutomationTestStreamEvent } from "@/shared/deterministic-automation";
import type { ConversationLogEntry } from "@/shared/conversation";
import type { Workspace } from "@/shared/workspace";
import { AutomationRunsQuerySchema, DeleteAutomationRunsRequestSchema, RunAutomationRequestSchema, TestAutomationCodeRequestSchema } from "@/contracts/schemas";
import type { TestAutomationCodeRequest } from "@/contracts/schemas";
import { automationManager } from "../../core/automation-manager";
import { isDomainError } from "../../domain/domain-error";
import { testDeterministicAutomationCode } from "../../core/deterministic-automation-test";
import { assertWorktreesAllowed, isGitBackedWorkspace } from "../../core/workspace-capabilities";
import { domainErrorResponse, errorResponse, internalErrorResponse, requireWorkspace, successResponse } from "../helpers";
import { parseAndValidate, validateRequest } from "../validation";
import { validateAutomationModel } from "./helpers";
import { CollectionReadOptionsSchema } from "@/contracts/schemas/resource-read";
import { readWorkCollection, readWorkCollectionItem } from "../../core/work-read-service";
import { readScope } from "../../client-sdk/collaboration/resource-read";
import { resourcePageResponse, workMetadataResponse } from "../resource-reads";

const log = createLogger("api:automations");
export const TEST_CODE_HEARTBEAT_INTERVAL_MS = 4_000;

async function toLightweightAutomationRun(run: AutomationRun): Promise<AutomationRun> {
  const summary = await automationManager.getRunSummary(run.id);
  if (!summary) {
    throw new Error(`Automation run disappeared after mutation: ${run.id}`);
  }
  return summary;
}

interface PreparedDeterministicAutomationTest {
  body: TestAutomationCodeRequest;
  workspace: Workspace;
}

async function prepareDeterministicAutomationTest(
  req: Request,
): Promise<PreparedDeterministicAutomationTest | Response> {
  const validation = await parseAndValidate(TestAutomationCodeRequestSchema, req);
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
          policy: "automations",
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
  const modelValidation = await validateAutomationModel(body.workspaceId, body.model);
  if (modelValidation) {
    return modelValidation;
  }
  return { body, workspace };
}

function testOptionsFromPrepared(
  prepared: PreparedDeterministicAutomationTest,
  options: {
    signal?: AbortSignal;
    userId?: string;
    onOutput?: (entry: ConversationLogEntry) => void;
  } = {},
) {
  const { body, workspace } = prepared;
  return {
    name: body.name ?? "Draft deterministic automation",
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

function createDeterministicAutomationTestJsonResponse(
  req: Request,
  prepared: PreparedDeterministicAutomationTest,
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
          const result = await testDeterministicAutomationCode({
            ...testOptionsFromPrepared(prepared),
            userId,
            signal: executionController.signal,
          });
          if (!streamClosed) {
            controller.enqueue(encoder.encode(JSON.stringify(result)));
          }
        } catch (error) {
          if (!streamClosed && !executionController.signal.aborted) {
            log.error("Failed to test deterministic automation code", {
              workspaceId: prepared.body.workspaceId,
              error: String(error),
            });
            controller.enqueue(encoder.encode(JSON.stringify({
              error: "test_automation_code_failed",
              message: "Failed to test automation code",
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

function createDeterministicAutomationTestStream(
  req: Request,
  prepared: PreparedDeterministicAutomationTest,
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

  const enqueue = (event: DeterministicAutomationTestStreamEvent): void => {
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
          const result = await testDeterministicAutomationCode({
            ...testOptionsFromPrepared(prepared),
            userId,
            signal: executionController.signal,
            onOutput: (entry) => enqueue({ type: "log", log: entry }),
          });
          enqueue({ type: "result", result });
        } catch (error) {
          log.error("Failed to stream deterministic automation code test", {
            workspaceId: prepared.body.workspaceId,
            error: String(error),
          });
          const result: DeterministicAutomationTestResult = {
            status: "failed",
            logs: [],
            error: "Failed to test automation code",
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
}): AutomationRunStatus[] {
  const statuses: AutomationRunStatus[] = [];
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
  "/api/automations/code/test": {
    delegation: workspaceOperation("automation"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Test deterministic automation code without saving an automation or run.",
    operations: {
      POST: {
        requestSchema: TestAutomationCodeRequestSchema,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "Executes arbitrary deterministic automation code on the workspace host.", hiddenInputs: ["testRunId"] },
      },
    },
    async POST(req: Request, ctx): Promise<Response> {
      ctx.server?.timeout(req, 0);
      const prepared = await prepareDeterministicAutomationTest(req);
      if (prepared instanceof Response) {
        return prepared;
      }
      return createDeterministicAutomationTestJsonResponse(req, prepared, ctx.requireUser().id);
    },
  },

  "/api/automations/code/test/stream": {
    delegation: workspaceOperation("automation"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Stream deterministic automation code test output without saving an automation or run.",
    operations: {
      POST: {
        requestSchema: TestAutomationCodeRequestSchema,
        querySchema: undefined,
        automation: executionAutomation("confirm", "Runs deterministic code and saves its execution stream.", { responseFormat: "file" }),
      },
    },
    async POST(req: Request, ctx): Promise<Response> {
      ctx.server?.timeout(req, 0);
      const prepared = await prepareDeterministicAutomationTest(req);
      if (prepared instanceof Response) {
        return prepared;
      }
      return createDeterministicAutomationTestStream(req, prepared, ctx.requireUser().id);
    },
  },

  "/api/automations/:id/run": {
    delegation: workspaceOperation("automation"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Start an automation run immediately.",
    operations: {
      POST: {
        requestSchema: RunAutomationRequestSchema,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "Starts headless automation execution with the saved prompt or deterministic code.", completion: "admission" },
      },
    },
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(RunAutomationRequestSchema, req, { allowEmptyBody: true });
      if (!validation.success) {
        return validation.response;
      }

      try {
        const run = await automationManager.runNow(ctx.params["id"]!, validation.data.attachments);
        return Response.json(await toLightweightAutomationRun(run), { status: 202 });
      } catch (error) {
        const response = domainErrorResponse(error, {
          policy: "automations",
          fallback: {
            error: "run_automation_failed",
            message: "Failed to run automation",
            status: 500,
          },
        });
        if (response.status >= 500) {
          log.error("Failed to run automation", {
            automationId: ctx.params["id"]!,
            error: String(error),
          });
        }
        return response;
      }
    },
  },

  "/api/automations/:id/interrupt": {
    delegation: workspaceOperation("automation"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Interrupt an active automation run.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "write", completion: "admission" } },
    },
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const run = await automationManager.interruptAutomation(ctx.params["id"]!, "Automation run interrupted by user");
        if (!run) {
          return errorResponse("no_active_automation_run", "Automation does not have an active run", 409);
        }
        return Response.json(await toLightweightAutomationRun(run));
      } catch (error) {
        const response = domainErrorResponse(error, {
          policy: "automations",
          fallback: {
            error: "interrupt_automation_failed",
            message: "Failed to interrupt automation",
            status: 500,
          },
        });
        if (response.status >= 500) {
          log.error("Failed to interrupt automation", {
            automationId: ctx.params["id"]!,
            error: String(error),
          });
        }
        return response;
      }
    },
  },

  "/api/automations/:id/pause": {
    delegation: workspaceOperation("automation"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Pause a scheduled automation.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "write" } },
    },
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const automation = await automationManager.pauseAutomation(ctx.params["id"]!);
        if (!automation) {
          return errorResponse("automation_not_found", "Automation not found", 404);
        }
        return Response.json(automation);
      } catch (error) {
        log.error("Failed to pause automation", {
          automationId: ctx.params["id"]!,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "pause_automation_failed",
          message: "Failed to pause automation",
          status: 500,
        });
      }
    },
  },

  "/api/automations/:id/resume": {
    delegation: workspaceOperation("automation"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Resume a paused scheduled automation.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "confirm", reason: "Re-enables recurring headless automation execution." } },
    },
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const automation = await automationManager.resumeAutomation(ctx.params["id"]!);
        if (!automation) {
          return errorResponse("automation_not_found", "Automation not found", 404);
        }
        return Response.json(automation);
      } catch (error) {
        log.error("Failed to resume automation", {
          automationId: ctx.params["id"]!,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "resume_automation_failed",
          message: "Failed to resume automation",
          status: 500,
        });
      }
    },
  },

  "/api/automations/:id/runs": {
    delegation: workspaceOperation("automation", { collection: true }),
    partialResults: { header: "X-Clanky-Partial" },
    auth: "user",
    sameOrigin: "mutations",
    description: "List or purge runs for an automation.",
    operations: {
      GET: {
        description: "List a bounded page of automation runs.",
        requestSchema: undefined,
        querySchema: AutomationRunsQuerySchema.safeExtend(CollectionReadOptionsSchema.omit({ limit: true }).shape),
        automation: { policy: "read" },
      },
      DELETE: {
        description: "Purge eligible automation runs.",
        requestSchema: DeleteAutomationRunsRequestSchema,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "Permanently deletes matching automation run history.", completion: "admission" },
      },
    },
    async GET(req: Request, ctx): Promise<Response> {
      const parsedQuery = validateRequest(
        AutomationRunsQuerySchema,
        Object.fromEntries(new URL(req.url).searchParams),
      );
      if (!parsedQuery.success) {
        return parsedQuery.response;
      }
      const automation = await automationManager.getAutomation(ctx.params["id"]!);
      if (!automation) {
        return errorResponse("automation_not_found", "Automation not found", 404);
      }
      const url = new URL(req.url);
      if (url.searchParams.get("view") === "compact" && url.searchParams.get("section") === "details" && url.searchParams.has("item")) {
        return Response.json(await readWorkCollectionItem({
          resource: "automation_run", automationId: automation.config.id,
          options: CollectionReadOptionsSchema.parse(Object.fromEntries(url.searchParams)),
        }));
      }
      if (url.searchParams.get("view") === "compact" && !url.searchParams.has("section") && !url.searchParams.has("item")) {
        return resourcePageResponse(readWorkCollection({
          resource: "automation_run", automationId: automation.config.id, baseOffset: parsedQuery.data.offset,
          options: CollectionReadOptionsSchema.parse(Object.fromEntries(url.searchParams)),
          scope: readScope(ctx.requireUser().id, url),
        }));
      }
      const runs = await automationManager.listRuns(ctx.params["id"]!, parsedQuery.data);
      return Response.json(runs);
    },

    async DELETE(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(DeleteAutomationRunsRequestSchema, req, { allowEmptyBody: true });
      if (!validation.success) {
        return validation.response;
      }
      const statuses = mapPurgeStatuses(validation.data);
      if (statuses.length === 0) {
        return successResponse({ deletedRunIds: [] });
      }
      const deletedRunIds = await automationManager.purgeRuns(ctx.params["id"]!, {
        before: validation.data.before,
        statuses,
      });
      return successResponse({ deletedRunIds });
    },
  },

  "/api/automation-runs/:id": {
    delegation: workspaceOperation("automation-run"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read or delete an automation run.",
    operations: {
      GET: {
        description: "Read an automation run summary.",
        requestSchema: undefined,
        querySchema: CollectionReadOptionsSchema,
        automation: { policy: "read" },
      },
      DELETE: {
        description: "Delete an automation run.",
        requestSchema: undefined,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "Permanently deletes the automation run and its history.", completion: "admission" },
      },
    },
    async GET(_req: Request, ctx): Promise<Response> {
      const compact = workMetadataResponse(_req, { resource: "automation_run", id: ctx.params["id"]!, notFound: { code: "automation_run_not_found", message: "Automation run not found" } });
      if (compact) return compact;
      const run = await automationManager.getRunSummary(ctx.params["id"]!);
      if (!run) {
        return errorResponse("automation_run_not_found", "Automation run not found", 404);
      }
      return Response.json(run);
    },

    async DELETE(_req: Request, ctx): Promise<Response> {
      const deleted = await automationManager.deleteRun(ctx.params["id"]!);
      if (!deleted) {
        return errorResponse("automation_run_not_found", "Automation run not found", 404);
      }
      return successResponse();
    },
  },
});
