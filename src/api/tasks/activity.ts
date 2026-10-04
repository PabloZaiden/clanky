import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import { taskManager } from "../../core/task-manager";
import { domainErrorResponse, errorResponse, successResponse } from "../helpers";
import { isDomainError } from "../../domain/domain-error";

const log = createLogger("api:task-activity");

function activityErrorResponse(error: unknown): Response {
  if (isDomainError(error)) return domainErrorResponse(error, {
    policy: "tasks", fallback: { error: "activity_failed", message: "Native task activity could not be controlled.", status: 500 },
  });
  log.error("Native task activity failed", { error: String(error) });
  return errorResponse("activity_failed", "Native task activity could not be controlled.", 500);
}

export const tasksActivityRoutes = defineRoutes({
  "/api/tasks/:id/activity": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Observe owned native task work independently of logical task completion.",
    async GET(_req, ctx) {
      try { return successResponse({ activity: await taskManager.getActivity(ctx.params["id"]!) }); } catch (error) { return activityErrorResponse(error); }
    },
  },
  "/api/tasks/:id/activity/:activityId/stop": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Stop one owned native child or process without escalating to the principal or siblings.",
    async POST(_req, ctx) {
      try { return successResponse({ result: await taskManager.stopActivity(ctx.params["id"]!, ctx.params["activityId"]!) }); } catch (error) { return activityErrorResponse(error); }
    },
  },
});
