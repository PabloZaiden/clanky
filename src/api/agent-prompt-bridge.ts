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
import type { Chat } from "@/shared/chat";
import { chatManager } from "../core/chat-manager";
import {
  createInterruptibleOperationCoordinator,
  INTERRUPTIBLE_OPERATION_SETTLE_TIMEOUT_MS,
} from "../core/interruptible-operation";
import { errorResponse, internalErrorResponse } from "./helpers";

const log = createLogger("api:agent-prompt-bridge");

const AgentPromptRequestSchema = z.object({
  chatId: z.string().min(1),
  message: z.string().min(1),
});

function getPromptAssistantMessage(
  chat: Chat,
  previousMessageIds: ReadonlySet<string>,
  promptStartedAt?: string,
): string {
  const message = [...chat.state.messages].reverse().find((candidate) =>
    candidate.role === "assistant"
      && candidate.content.trim().length > 0
      && !previousMessageIds.has(candidate.id)
      && (!promptStartedAt || candidate.timestamp >= promptStartedAt),
  );
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

      const previousMessageIds = new Set(chat.state.messages.map((candidate) => candidate.id));
      const coordinator = createInterruptibleOperationCoordinator({
        signal: req.signal,
        interrupt: async () => {
          await chatManager.interruptChat(chatId, "Workspace prompt was cancelled");
        },
        settlementTimeoutMs: INTERRUPTIBLE_OPERATION_SETTLE_TIMEOUT_MS,
        createAbortError: () => new Error("Prompt cancelled"),
        onInterruptError: (error, phase) => {
          log.error("Failed to interrupt workspace prompt", {
            chatId,
            phase,
            error: String(error),
          });
        },
        onSettlementTimeout: (phaseName) => {
          const message = phaseName === "send"
            ? "Workspace prompt send did not settle after cancellation"
            : "Workspace prompt wait did not settle after cancellation";
          log.warn(message, { chatId });
        },
      });

      try {
        if (req.signal.aborted) {
          return new Response(null, { status: 499 });
        }

        const sent = await coordinator.runPhase(
          () => chatManager.sendMessage(chatId, { message }),
          "send",
        );
        const sentUserMessage = [...sent.state.messages].reverse().find((candidate) =>
          candidate.role === "user"
            && !previousMessageIds.has(candidate.id)
            && candidate.content === message,
        );

        const completed = await coordinator.runPhase(
          () => chatManager.waitForChatIdle(chatId),
          "wait",
          { allowLateInterrupt: false },
        );

        if (completed.state.status === "failed" || completed.state.error) {
          const errMsg = completed.state.error?.message ?? "Workspace prompt failed";
          log.warn("Workspace prompt chat failed", { chatId, error: errMsg });
          return internalErrorResponse(
            new Error(errMsg),
            { error: "prompt_failed", message: errMsg },
          );
        }

        const response = getPromptAssistantMessage(
          completed,
          previousMessageIds,
          sentUserMessage?.timestamp,
        );
        return Response.json({ response });
      } catch (error) {
        if (req.signal.aborted) {
          return new Response(null, { status: 499 });
        }
        log.error("Workspace prompt bridge error", { chatId, error: String(error) });
        return internalErrorResponse(
          error instanceof Error ? error : new Error(String(error)),
          { error: "prompt_failed", message: "Workspace prompt bridge failed" },
        );
      } finally {
        await coordinator.dispose();
      }
    },
  },
});
