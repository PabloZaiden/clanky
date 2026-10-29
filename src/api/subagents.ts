import { defineRoutes, type RouteContext } from "@pablozaiden/webapp/server";
import { SubagentListQuerySchema } from "@/contracts/schemas/subagent";
import { getSavedSubagentAssistantMessage, getSavedSubagents, getSavedSubagentSnapshot, getSavedSubagentTool } from "../core/subagent-service";
import { getTranscriptSnapshotEtag } from "../core/transcript-service";
import { workspaceOperation } from "./workspace-delegation";
import { domainErrorResponse, errorResponse } from "./helpers";
import { TranscriptSnapshotQuerySchema } from "./route-schemas";
import { parseTranscriptSnapshotOptions, transcriptSnapshotErrorResponse } from "./transcript-snapshot";
import { assistantMessageSpeechResponse } from "./voice";

export function createSubagentRoutes(kind: "chat" | "task") {
  const base = `/api/${kind === "chat" ? "chats" : "tasks"}/:id/subagents`;
  const parent = workspaceOperation(kind);
  const common = {
    auth: "user" as const,
    sameOrigin: "mutations" as const,
    delegation: { ...parent, bindings: [...parent.bindings!, { source: "param" as const, name: "subagentId", resource: "subagent" }] },
  };
  const context = (ctx: RouteContext) => ({ kind, id: ctx.params["id"]! });
  const failure = (error: unknown) => transcriptSnapshotErrorResponse(error) ?? domainErrorResponse(error, {
    fallback: { error: "subagent_read_failed", message: "The saved subagent conversation could not be read.", status: 500 },
  });
  return defineRoutes({
    [base]: {
      ...common,
      description: "List saved subagents belonging to this conversation, including completed and disconnected children.",
      operations: { GET: { requestSchema: undefined, querySchema: SubagentListQuerySchema, automation: { policy: "read" as const } } },
      async GET(req: Request, ctx: RouteContext) {
        try {
          const { before } = SubagentListQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
          const page = await getSavedSubagents(context(ctx), before);
          return page ? Response.json(page) : errorResponse("not_found", "Conversation not found", 404);
        } catch (error) { return failure(error); }
      },
    },
    [`${base}/:subagentId/snapshot`]: {
      ...common,
      description: "Read a saved subagent conversation with the shared bounded transcript pagination.",
      operations: { GET: {
        requestSchema: undefined, querySchema: TranscriptSnapshotQuerySchema,
        automation: { policy: "read" as const, hiddenQuery: ["full", "since"] },
      } },
      async GET(req: Request, ctx: RouteContext) {
        const options = parseTranscriptSnapshotOptions(req);
        if (options instanceof Response) return options;
        try {
          const snapshot = await getSavedSubagentSnapshot(context(ctx), ctx.params["subagentId"]!, options);
          if (!snapshot) return errorResponse("not_found", "Subagent conversation not found", 404);
          const revision = getTranscriptSnapshotEtag(snapshot.transcript.revision, snapshot.subagent, options);
          const headers = { "Cache-Control": "private, no-cache", ETag: `"${revision}"` };
          return req.headers.get("If-None-Match") === `"${revision}"`
            ? new Response(null, { status: 304, headers }) : Response.json(snapshot, { headers });
        } catch (error) { return failure(error); }
      },
    },
    [`${base}/:subagentId/tool-calls/:toolCallId`]: {
      ...common,
      description: "Read a full saved tool payload from one owned subagent.",
      operations: { GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "read" as const } } },
      async GET(_req: Request, ctx: RouteContext) {
        try {
          const tool = await getSavedSubagentTool(context(ctx), ctx.params["subagentId"]!, ctx.params["toolCallId"]!);
          return tool ? Response.json(tool) : errorResponse("not_found", "Tool call not found", 404);
        } catch (error) { return failure(error); }
      },
    },
    [`${base}/:subagentId/messages/:messageId/speech`]: {
      ...common,
      delegation: { ...common.delegation, action: "saved-message-speech" },
      description: "Read an existing assistant message from this subagent aloud.",
      operations: { POST: {
        requestSchema: undefined, querySchema: undefined,
        automation: { policy: "excluded" as const, reason: "Raw synthesized audio is coordinated by the browser audio owner." },
      } },
      async POST(req: Request, ctx: RouteContext) {
        return assistantMessageSpeechResponse(req, () => getSavedSubagentAssistantMessage(
          context(ctx), ctx.params["subagentId"]!, ctx.params["messageId"]!,
        ));
      },
    },
  });
}
