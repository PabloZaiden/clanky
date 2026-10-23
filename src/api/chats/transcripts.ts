import { workspaceOperation } from "../workspace-delegation";
import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import { chatManager } from "../../core/chat-manager";
import { TranscriptDownloadQuerySchema, TranscriptSnapshotQuerySchema } from "../route-schemas";
import { getTranscriptSnapshotEtag } from "../../core/transcript-service";
import { buildChatTranscriptHtml, buildChatTranscriptMarkdown } from "../../lib/chat-transcript-export";
import { errorResponse, internalErrorResponse } from "../helpers";
import {
  parseTranscriptSnapshotOptions,
  transcriptSnapshotErrorResponse,
} from "../transcript-snapshot";
import { ConversationReadOptionsSchema } from "@/contracts/schemas/resource-read";
import { readConversationPage } from "../../core/conversation-read-service";
import { readScope } from "../../core/resource-read-service";

const log = createLogger("api:chats");

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

export const chatsTranscriptRoutes = defineRoutes({
  "/api/chats/:id/snapshot": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read the latest 100 chat responses; use before for older history, since to refresh a loaded window, or full=1 for the complete transcript.",
    operations: {
      GET: {
        description: "Read one bounded page of chat history; use before to load older history.",
        requestSchema: undefined,
        querySchema: TranscriptSnapshotQuerySchema.extend(ConversationReadOptionsSchema.shape),
        automation: { policy: "read", hiddenQuery: ["full", "since"] },
      },
    },
    async GET(req: Request, ctx): Promise<Response> {
      if (new URL(req.url).searchParams.get("view") === "conversation") {
        const page = readConversationPage({
          resource: "chat", id: ctx.params["id"]!,
          options: ConversationReadOptionsSchema.parse(Object.fromEntries(new URL(req.url).searchParams)),
          scope: readScope(ctx.requireUser().id, new URL(req.url)),
        });
        return page ? Response.json(page) : errorResponse("not_found", "Chat not found", 404);
      }
      const options = parseTranscriptSnapshotOptions(req);
      if (options instanceof Response) {
        return options;
      }
      try {
        const snapshot = await chatManager.getChatSnapshot(ctx.params["id"]!, options);
        if (!snapshot) {
          return errorResponse("not_found", "Chat not found", 404);
        }

        const revision = getTranscriptSnapshotEtag(
          snapshot.transcript.revision,
          { config: snapshot.config, state: snapshot.state },
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
        log.error("Failed to load chat snapshot", {
          chatId: ctx.params["id"]!,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "snapshot_failed",
          message: "Failed to load chat snapshot",
          status: 500,
        }, undefined, "chats");
      }
    },
  },

  "/api/chats/:id/tool-calls/:toolCallId": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read the full details for one chat tool call.",
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "read" } },
    },
    async GET(_req: Request, ctx): Promise<Response> {
      const toolCall = await chatManager.getChatToolCall(
        ctx.params["id"]!,
        ctx.params["toolCallId"]!,
      );
      if (!toolCall) {
        return errorResponse("not_found", "Tool call not found", 404);
      }
      return Response.json(toolCall);
    },
  },

  "/api/chats/:id/transcript.md": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Download a chat transcript as Markdown.",
    operations: {
      GET: {
        requestSchema: undefined,
        querySchema: TranscriptDownloadQuerySchema,
        automation: { policy: "excluded", reason: "Raw Markdown transcript download; use the paged JSON snapshot operation." },
      },
    },
    async GET(req: Request, ctx): Promise<Response> {
      const chat = await chatManager.getChat(ctx.params["id"]!);
      if (!chat) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      const transcript = buildChatTranscriptMarkdown(chat);
      if (!transcript) {
        return errorResponse("empty_transcript", "Chat transcript is empty. Send at least one message before exporting.", 400);
      }

      const url = new URL(req.url);
      const headers = new Headers({
        "Content-Type": "text/markdown; charset=utf-8",
      });
      if (url.searchParams.get("download") === "1") {
        headers.set("Content-Disposition", `attachment; filename="${transcript.filename}"`);
      }

      return new Response(transcript.markdown, { headers });
    },
  },

  "/api/chats/:id/transcript.html": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Open a chat transcript as a standalone HTML document.",
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "excluded", reason: "Raw HTML transcript document; use the paged JSON snapshot operation." } },
    },
    async GET(_req: Request, ctx): Promise<Response> {
      const chat = await chatManager.getChat(ctx.params["id"]!);
      if (!chat) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      const html = buildChatTranscriptHtml(chat);
      if (!html) {
        return errorResponse("empty_transcript", "Chat transcript is empty. Send at least one message before exporting.", 400);
      }

      return new Response(html, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
          "Content-Type": "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  },
});
