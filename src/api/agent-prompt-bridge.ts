/**
 * Internal agent-prompt bridge.
 *
 * Exposes a simple HTTP endpoint that the workspace-side deterministic agent
 * runner calls when user code invokes `ctx.workspace.prompt(message)`.  The
 * route forwards the message to the appropriate chat, waits for the ACP
 * session to become idle, and returns the last assistant response.
 *
 * Security: The endpoint is `auth: "user"` — the managed API key created for
 * the run is a normal user-scoped bearer token.  The caller must supply a
 * `chatId` that belongs to the authenticated user.
 */

import { defineRoutes, createLogger } from "@pablozaiden/webapp/server";
import { z } from "zod";
import { chatManager } from "../core/chat-manager";
import { errorResponse, internalErrorResponse } from "./helpers";

const log = createLogger("api:agent-prompt-bridge");

const AgentPromptRequestSchema = z.object({
  chatId: z.string().min(1),
  message: z.string().min(1),
});

async function getLastAssistantMessage(chatId: string): Promise<string> {
  const chat = await chatManager.getChat(chatId);
  if (!chat) {
    throw new Error(`Chat not found: ${chatId}`);
  }
  const message = [...chat.state.messages].reverse().find((m) => m.role === "assistant");
  if (!message) {
    throw new Error("Chat completed without an assistant response");
  }
  return message.content;
}

export const agentPromptBridgeRoutes = defineRoutes({
  "/api/internal/agent-prompt": {
    auth: "user",
    sameOrigin: "never",
    scopes: ["clanky:agent-prompt"],
    description: "Internal endpoint used by the workspace-side deterministic agent runner to forward workspace.prompt() calls to the authenticated user's chat.",
    async POST(req, ctx) {
      ctx.requireUser();
      ctx.server?.timeout(req, 0);

      let body: { chatId: string; message: string };
      try {
        const raw = await req.json();
        const parsed = AgentPromptRequestSchema.safeParse(raw);
        if (!parsed.success) {
          return errorResponse("invalid_request", "chatId and message are required", 400);
        }
        body = parsed.data;
      } catch {
        return errorResponse("invalid_request", "Invalid JSON body", 400);
      }

      const { chatId, message } = body;

      // The chat is automatically scoped to the authenticated user via runWithCurrentUser;
      // no explicit ownership check is needed.
      const chat = await chatManager.getChat(chatId);
      if (!chat) {
        return errorResponse("chat_not_found", "Chat not found", 404);
      }

      // Set up abort handling: if the client (runner) disconnects, stop waiting
      // immediately and interrupt the chat in the awaited catch path below.
      let abortHandler: (() => void) | undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        abortHandler = () => reject(new Error("Prompt cancelled"));
        req.signal.addEventListener("abort", abortHandler, { once: true });
      });

      try {
        await Promise.race([
          chatManager.sendMessage(chatId, { message }),
          abortPromise,
        ]);

        const completed = await Promise.race([
          chatManager.waitForChatIdle(chatId),
          abortPromise,
        ]);

        if (completed.state.status === "failed" || completed.state.error) {
          const errMsg = completed.state.error?.message ?? "Workspace prompt failed";
          log.warn("Workspace prompt chat failed", { chatId, error: errMsg });
          return internalErrorResponse(
            new Error(errMsg),
            { error: "prompt_failed", message: errMsg },
          );
        }

        const response = await getLastAssistantMessage(chatId);
        return Response.json({ response });
      } catch (error) {
        if (req.signal.aborted) {
          try {
            await chatManager.interruptChat(chatId, "Workspace prompt was cancelled");
          } catch (interruptError) {
            log.error("Failed to interrupt workspace prompt after client disconnect", {
              chatId,
              error: String(interruptError),
            });
          }
          return new Response(null, { status: 499 });
        }
        log.error("Workspace prompt bridge error", { chatId, error: String(error) });
        return internalErrorResponse(
          error instanceof Error ? error : new Error(String(error)),
          { error: "prompt_failed", message: "Workspace prompt bridge failed" },
        );
      } finally {
        if (abortHandler) {
          req.signal.removeEventListener("abort", abortHandler);
        }
      }
    },
  },
});
