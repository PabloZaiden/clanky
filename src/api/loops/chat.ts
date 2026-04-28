import { chatManager } from "../../core/chat-manager";
import { loopManager } from "../../core/loop-manager";
import { createLogger } from "../../core/logger";
import { errorResponse } from "../helpers";

const log = createLogger("api:loops:chat");

export const loopsChatRoutes = {
  "/api/loops/:id/chat": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const loop = await loopManager.getLoop(req.params.id);
      if (!loop) {
        return errorResponse("not_found", "Loop not found", 404);
      }

      const chat = await chatManager.getLoopChat(req.params.id);
      if (!chat) {
        return errorResponse("not_found", "Loop chat not found", 404);
      }

      return Response.json(chat);
    },

    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const loop = await loopManager.getLoop(req.params.id);
      if (!loop) {
        return errorResponse("not_found", "Loop not found", 404);
      }

      try {
        const result = await chatManager.getOrCreateLoopChat(req.params.id, loop);
        return Response.json(result.chat, { status: result.created ? 201 : 200 });
      } catch (error) {
        log.error("Failed to get or create loop chat", {
          loopId: req.params.id,
          error: String(error),
        });
        return errorResponse("loop_chat_failed", String(error), 500);
      }
    },
  },
};
