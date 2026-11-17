import { defineRoutes } from "@/platform/server";
import { workspaceOperation } from "../workspace-delegation";
import { executionAutomation } from "../execution-automation";
import { readHtmlRender } from "../../persistence/html-renders";
import { errorResponse, internalErrorResponse } from "../helpers";

export const chatsHtmlRenderRoutes = defineRoutes({
  "/api/chats/:id/html-renders/:artifactId": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read one persistent HTML artifact from an owned chat.",
    operations: { GET: {
      requestSchema: undefined, querySchema: undefined,
      automation: executionAutomation("read", "HTML artifacts require file delivery.", { responseFormat: "file" }),
    } },
    GET(_req: Request, ctx): Response {
      try {
        const html = readHtmlRender(ctx.params["id"]!, ctx.params["artifactId"]!);
        if (html === null) return errorResponse("not_found", "HTML artifact not found", 404);
        return new Response(html, { headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": "attachment; filename=\"artifact.html\"",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox allow-scripts allow-forms",
        } });
      } catch (error) {
        return internalErrorResponse(error, { error: "html_render_failed", message: "Failed to load HTML artifact", status: 500 });
      }
    },
  },
});
