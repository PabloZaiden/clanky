import { workspaceOperation } from "../workspace-delegation";
/**
 * Scheduled-automation transcript API routes.
 */

import { defineRoutes } from "@/platform/server";
import { executionAutomation } from "../execution-automation";
import { getTranscriptAttachment } from "../../core/transcript-attachment-service";
import { projectTranscriptAttachments } from "@/shared";
import { TranscriptSnapshotQuerySchema } from "../route-schemas";
import { getAutomationRunTranscriptSnapshot, getAutomationRunTranscriptToolCall } from "../../core/automation-run-transcript-service";
import { getTranscriptSnapshotEtag } from "../../core/transcript-service";
import { errorResponse, internalErrorResponse } from "../helpers";
import { parseTranscriptSnapshotOptions, transcriptSnapshotErrorResponse, transcriptAttachmentResponse } from "../transcript-snapshot";
import { ConversationReadOptionsSchema } from "@/contracts/schemas/resource-read";
import { readConversationPage } from "../../core/conversation-read-service";
import { readScope } from "../../client-sdk/collaboration/resource-read";

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
  "/api/automation-runs/:id/snapshot": {
    delegation: workspaceOperation("automation-run"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read the latest 100 automation-run responses; use before for older history, since to refresh a loaded window, or full=1 for the complete transcript.",
    operations: {
      GET: {
        description: "Read one bounded page of automation-run history; use before for older history.",
        requestSchema: undefined,
        querySchema: TranscriptSnapshotQuerySchema.extend(ConversationReadOptionsSchema.shape),
        automation: { policy: "read", hiddenQuery: ["full", "since"] },
      },
    },
    async GET(req: Request, ctx): Promise<Response> {
      if (new URL(req.url).searchParams.get("view") === "conversation") {
        const page = readConversationPage({
          resource: "automation_run", id: ctx.params["id"]!,
          options: ConversationReadOptionsSchema.parse(Object.fromEntries(new URL(req.url).searchParams)),
          scope: readScope(ctx.requireUser().id, new URL(req.url)),
        });
        return page ? Response.json(page) : errorResponse("automation_run_not_found", "Automation run not found", 404);
      }
      const options = parseTranscriptSnapshotOptions(req);
      if (options instanceof Response) {
        return options;
      }
      try {
        const snapshot = await getAutomationRunTranscriptSnapshot(ctx.params["id"]!, options);
        if (!snapshot) {
          return errorResponse("automation_run_not_found", "Automation run not found", 404);
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
        return Response.json({
          ...snapshot,
          transcript: projectTranscriptAttachments(snapshot.transcript, `/api/automation-runs/${encodeURIComponent(ctx.params["id"]!)}`),
        }, {
          headers: transcriptResponseHeaders(revision),
        });
      } catch (error) {
        const snapshotError = transcriptSnapshotErrorResponse(error);
        if (snapshotError) {
          return snapshotError;
        }
        return internalErrorResponse(error, {
          error: "snapshot_failed",
          message: "Failed to load automation-run snapshot",
          status: 500,
        });
      }
    },
  },

  "/api/automation-runs/:id/messages/:messageId/attachments/:attachmentId": {
    delegation: workspaceOperation("automation-run"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read one original attachment from an owned automation run; non-image files download without rendering.",
    operations: { GET: { requestSchema: undefined, querySchema: undefined, automation: executionAutomation("read", "Attachments require file delivery.", { responseFormat: "file" }) } },
    async GET(req: Request, ctx): Promise<Response> {
      try {
        return transcriptAttachmentResponse(req, await getTranscriptAttachment(
          { kind: "automation-run", id: ctx.params["id"]! }, ctx.params["messageId"]!, ctx.params["attachmentId"]!,
        ));
      } catch (error) {
        return internalErrorResponse(error, { error: "attachment_failed", message: "Failed to load attachment", status: 500 });
      }
    },
  },

  "/api/automation-runs/:id/tool-calls/:toolCallId": {
    delegation: workspaceOperation("automation-run"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read one complete automation-run tool-call payload.",
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "read" } },
    },
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        const toolCall = await getAutomationRunTranscriptToolCall(ctx.params["id"]!, ctx.params["toolCallId"]!);
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
