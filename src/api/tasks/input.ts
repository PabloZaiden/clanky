/**
 * Explicit native steering and exact-conversation input recovery.
 */

import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import { taskManager } from "../../core/task-manager";
import { domainErrorResponse, successResponse } from "../helpers";
import type { TaskInputAdmissionResponse } from "@/contracts";

const log = createLogger("api:task-input");

async function inputResponse(operation: () => Promise<TaskInputAdmissionResponse>): Promise<Response> {
  try {
    return successResponse({ ...await operation() });
  } catch (error) {
    const response = domainErrorResponse(error, {
      policy: "tasks",
      fallback: { error: "task_input_failed", message: "Native task input could not be admitted or recovered.", status: 500 },
    });
    if (response.status >= 500) log.error("Native task input failed", { error: String(error) });
    else log.warn("Native task input refused", { error: String(error) });
    return response;
  }
}

export const tasksInputRoutes = defineRoutes({
  "/api/tasks/:id/pending-inputs/:inputId/steer": {
    auth: "user",
    sameOrigin: "mutations",
    tags: ["tasks"],
    description: "Admit the current queued task message into the native execution without interrupting it.",
    async POST(_req, ctx) {
      return await inputResponse(() => taskManager.steerPendingInput(ctx.params["id"]!, ctx.params["inputId"]!));
    },
  },
  "/api/tasks/:id/pending-inputs/:inputId/reconcile": {
    auth: "user",
    sameOrigin: "mutations",
    tags: ["tasks"],
    description: "Recover an input receipt from its exact owned native conversation without resending it.",
    async POST(_req, ctx) {
      return await inputResponse(() => taskManager.reconcilePendingInput(ctx.params["id"]!, ctx.params["inputId"]!));
    },
  },
});
