import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import { chatManager } from "../../core/chat-manager";
import { errorResponse, successResponse } from "../helpers";
import { chatActionErrorResponse } from "./helpers";

const log = createLogger("api:chat-activity");

export const chatsActivityRoutes = defineRoutes({
  "/api/chats/:id/activity": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Observe owned native work independently of the principal prompt.",
    async GET(_req, ctx) {
      try {
        return successResponse({ activity: await chatManager.getActivity(ctx.params["id"]!) });
      } catch (error) {
        const known = chatActionErrorResponse(error);
        if (known) return known;
        log.error("Native activity lookup failed", { chatId: ctx.params["id"], error: String(error) });
        return errorResponse("activity_failed", "Native activity could not be observed.", 500);
      }
    },
  },
  "/api/chats/:id/activity/:activityId/stop": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Stop one owned child execution or process without interrupting the principal or siblings.",
    async POST(_req, ctx) {
      try {
        return successResponse({ result: await chatManager.stopActivity(ctx.params["id"]!, ctx.params["activityId"]!) });
      } catch (error) {
        const known = chatActionErrorResponse(error);
        if (known) return known;
        log.error("Native activity stop failed", { chatId: ctx.params["id"], error: String(error) });
        return errorResponse("activity_stop_failed", "Native activity termination could not be confirmed.", 500);
      }
    },
  },
});
