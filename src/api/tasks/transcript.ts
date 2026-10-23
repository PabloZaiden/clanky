import { workspaceOperation } from "../workspace-delegation";
import { defineRoutes } from "@pablozaiden/webapp/server";
import { TranscriptSnapshotQuerySchema } from "../route-schemas";
import { errorResponse, internalErrorResponse } from "../helpers";
import {
  getTaskTranscriptSnapshot,
  getTaskTranscriptToolCall,
} from "../../core/task-transcript-service";
import {
  getTranscriptSnapshotEtag,
} from "../../core/transcript-service";
import {
  parseTranscriptSnapshotOptions,
  transcriptSnapshotErrorResponse,
} from "../transcript-snapshot";
import { ConversationReadOptionsSchema } from "@/contracts/schemas/resource-read";
import { readConversationPage } from "../../core/conversation-read-service";
import { readScope } from "../../core/resource-read-service";

function transcriptResponseHeaders(revision: string): Headers {
  return new Headers({
    "Cache-Control": "private, no-cache",
    ETag: `"${revision}"`,
  });
}

function isNotModified(request: Request, revision: string): boolean {
  const ifNoneMatch = request.headers.get("If-None-Match");
  return ifNoneMatch === `"${revision}"` || ifNoneMatch === revision;
}

export const tasksTranscriptRoutes = defineRoutes({
  "/api/tasks/:id/snapshot": {
    delegation: workspaceOperation("task"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read the latest 100 task responses; use before for older history, since to refresh a loaded window, or full=1 for the complete transcript.",
    operations: {
      GET: {
        description: "Read one bounded page of task history; use before for older history.",
        requestSchema: undefined,
        querySchema: TranscriptSnapshotQuerySchema.extend(ConversationReadOptionsSchema.shape),
        automation: { policy: "read", hiddenQuery: ["full", "since"] },
      },
    },
    async GET(req: Request, ctx): Promise<Response> {
      if (new URL(req.url).searchParams.get("view") === "conversation") {
        const page = readConversationPage({
          resource: "task", id: ctx.params["id"]!,
          options: ConversationReadOptionsSchema.parse(Object.fromEntries(new URL(req.url).searchParams)),
          scope: readScope(ctx.requireUser().id, new URL(req.url)),
        });
        return page ? Response.json(page) : errorResponse("not_found", "Task not found", 404);
      }
      const options = parseTranscriptSnapshotOptions(req);
      if (options instanceof Response) {
        return options;
      }
      try {
        const snapshot = await getTaskTranscriptSnapshot(ctx.params["id"]!, options);
        if (!snapshot) {
          return errorResponse("not_found", "Task not found", 404);
        }
        const revision = getTranscriptSnapshotEtag(
          snapshot.transcript.revision,
          { task: snapshot.task },
          options,
        );
        if (isNotModified(req, revision)) {
          return new Response(null, {
            status: 304,
            headers: transcriptResponseHeaders(revision),
          });
        }
        return Response.json(snapshot, { headers: transcriptResponseHeaders(revision) });
      } catch (error) {
        const snapshotError = transcriptSnapshotErrorResponse(error);
        if (snapshotError) {
          return snapshotError;
        }
        return internalErrorResponse(error, {
          error: "snapshot_failed",
          message: "Failed to load task snapshot",
          status: 500,
        });
      }
    },
  },

  "/api/tasks/:id/tool-calls/:toolCallId": {
    delegation: workspaceOperation("task"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read one complete task tool-call payload.",
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "read" } },
    },
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        const toolCall = await getTaskTranscriptToolCall(ctx.params["id"]!, ctx.params["toolCallId"]!);
        return toolCall
          ? Response.json(toolCall)
          : errorResponse("tool_call_not_found", "Tool call not found", 404);
      } catch (error) {
        return internalErrorResponse(error, {
          error: "tool_call_failed",
          message: "Failed to load tool call details",
          status: 500,
        });
      }
    },
  },
});
