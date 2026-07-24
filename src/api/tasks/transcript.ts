import { defineRoutes } from "@pablozaiden/webapp/server";
import { errorResponse, internalErrorResponse } from "../helpers";
import {
  getTaskTranscriptPage,
  getTaskTranscriptSnapshot,
  getTaskTranscriptToolCall,
  normalizeTranscriptPageSize,
} from "../../core/task-transcript-service";
import {
  getTranscriptPageEtag,
  getTranscriptSnapshotEtag,
  InvalidTranscriptCursorError,
} from "../../core/transcript-service";

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

function parseLimit(req: Request): number | Response {
  try {
    return normalizeTranscriptPageSize(new URL(req.url).searchParams.get("limit"));
  } catch (error) {
    return errorResponse("invalid_transcript_limit", String(error), 400);
  }
}

export const tasksTranscriptRoutes = defineRoutes({
  "/api/tasks/:id/snapshot": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read the complete lightweight transcript snapshot for a task.",
    async GET(req: Request, ctx): Promise<Response> {
      try {
        const snapshot = await getTaskTranscriptSnapshot(ctx.params["id"]!);
        if (!snapshot) {
          return errorResponse("not_found", "Task not found", 404);
        }
        const revision = getTranscriptSnapshotEtag(
          snapshot.transcript.revision,
          { task: snapshot.task },
        );
        if (isNotModified(req, revision)) {
          return new Response(null, {
            status: 304,
            headers: transcriptResponseHeaders(revision),
          });
        }
        return Response.json(snapshot, { headers: transcriptResponseHeaders(revision) });
      } catch (error) {
        if (error instanceof InvalidTranscriptCursorError) {
          return errorResponse(error.code, error.message, error.status);
        }
        return internalErrorResponse(error, {
          error: "snapshot_failed",
          message: "Failed to load task snapshot",
          status: 500,
        });
      }
    },
  },

  "/api/tasks/:id/transcript": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read an older page of a task transcript.",
    async GET(req: Request, ctx): Promise<Response> {
      const limit = parseLimit(req);
      if (limit instanceof Response) {
        return limit;
      }
      const before = new URL(req.url).searchParams.get("before") ?? undefined;
      try {
        const page = await getTaskTranscriptPage(ctx.params["id"]!, limit, before);
        if (!page) {
          return errorResponse("not_found", "Task not found", 404);
        }
        const revision = getTranscriptPageEtag(page.revision, before, limit);
        if (isNotModified(req, revision)) {
          return new Response(null, {
            status: 304,
            headers: transcriptResponseHeaders(revision),
          });
        }
        return Response.json(page, { headers: transcriptResponseHeaders(revision) });
      } catch (error) {
        if (error instanceof InvalidTranscriptCursorError) {
          return errorResponse(error.code, error.message, error.status);
        }
        return internalErrorResponse(error, {
          error: "transcript_page_failed",
          message: "Failed to load task transcript page",
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
