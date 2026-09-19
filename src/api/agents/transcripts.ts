/**
 * Scheduled-agent transcript API routes.
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import { getAgentRunTranscriptSnapshot, getAgentRunTranscriptToolCall } from "../../core/agent-run-transcript-service";
import { getTranscriptSnapshotEtag } from "../../core/transcript-service";
import { errorResponse, internalErrorResponse } from "../helpers";
import { parseTranscriptSnapshotOptions, transcriptSnapshotErrorResponse } from "../transcript-snapshot";

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

export const transcriptRoutes = defineRoutes({
  "/api/agent-runs/:id/snapshot": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read the latest page of up to 100 assistant responses for an agent run; use before for older history or full=1 for the complete transcript.",
    async GET(req: Request, ctx): Promise<Response> {
      const options = parseTranscriptSnapshotOptions(req);
      if (options instanceof Response) {
        return options;
      }
      try {
        const snapshot = await getAgentRunTranscriptSnapshot(ctx.params["id"]!, options);
        if (!snapshot) {
          return errorResponse("agent_run_not_found", "Agent run not found", 404);
        }
        const revision = getTranscriptSnapshotEtag(
          snapshot.transcript.revision,
          { run: snapshot.run },
          options,
        );
        if (isNotModified(req, revision)) {
          return new Response(null, {
            status: 304,
            headers: transcriptResponseHeaders(revision),
          });
        }
        return Response.json(snapshot, {
          headers: transcriptResponseHeaders(revision),
        });
      } catch (error) {
        const snapshotError = transcriptSnapshotErrorResponse(error);
        if (snapshotError) {
          return snapshotError;
        }
        return internalErrorResponse(error, {
          error: "snapshot_failed",
          message: "Failed to load agent-run snapshot",
          status: 500,
        });
      }
    },
  },

  "/api/agent-runs/:id/tool-calls/:toolCallId": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read one complete agent-run tool-call payload.",
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        const toolCall = await getAgentRunTranscriptToolCall(ctx.params["id"]!, ctx.params["toolCallId"]!);
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
