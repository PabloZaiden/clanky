import { defineRoutes } from "@pablozaiden/webapp/server";
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
    auth: "user",
    sameOrigin: "mutations",
    description: "Read the latest page of up to 100 assistant responses for a task; use before for older history or full=1 for the complete transcript.",
    async GET(req: Request, ctx): Promise<Response> {
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
    auth: "user",
    sameOrigin: "mutations",
    description: "Read one complete task tool-call payload.",
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
