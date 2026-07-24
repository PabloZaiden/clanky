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
import { errorResponse, internalErrorResponse } from "./helpers";

const log = createLogger("api:agent-prompt-bridge");
const PROMPT_INTERRUPT_SETTLE_TIMEOUT_MS = 5_000;

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

async function waitForPromiseSettlement(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function awaitRequestOrAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new Error("Prompt cancelled");
  }
  let abortHandler: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortHandler = () => reject(new Error("Prompt cancelled"));
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
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
      let sendPromise: Promise<Chat> | undefined;
      let waitPromise: Promise<Chat> | undefined;
      let sendSettled = true;
      let waitSettled = true;
      let interruptPromise: Promise<void> | undefined;
      let lateInterruptScheduled = false;
      let clientAborted = false;
      const interruptChatSafely = async (): Promise<void> => {
        try {
          await chatManager.interruptChat(chatId, "Workspace prompt was cancelled");
        } catch (error) {
          log.error("Failed to interrupt workspace prompt", {
            chatId,
            error: String(error),
          });
        }
      };
      const requestInterrupt = (): Promise<void> => {
        if (interruptPromise) {
          return interruptPromise;
        }
        interruptPromise = (async () => {
          await interruptChatSafely();
          if (sendPromise && !sendSettled) {
            if (!lateInterruptScheduled) {
              lateInterruptScheduled = true;
              void sendPromise.then(
                () => {
                  void interruptChatSafely();
                },
                () => {
                  void interruptChatSafely();
                },
              );
            }
            await waitForPromiseSettlement(sendPromise, PROMPT_INTERRUPT_SETTLE_TIMEOUT_MS);
            if (sendSettled) {
              await interruptChatSafely();
            } else {
              log.warn("Workspace prompt send did not settle after cancellation", { chatId });
            }
          }
          if (waitPromise && !waitSettled) {
            await waitForPromiseSettlement(waitPromise, PROMPT_INTERRUPT_SETTLE_TIMEOUT_MS);
          }
        })().finally(() => {
          interruptPromise = undefined;
        });
        return interruptPromise;
      };
      const abortHandler = (): void => {
        clientAborted = true;
        void requestInterrupt();
      };
      req.signal.addEventListener("abort", abortHandler, { once: true });

      try {
        if (req.signal.aborted) {
          await requestInterrupt();
          return new Response(null, { status: 499 });
        }

        sendSettled = false;
        sendPromise = chatManager.sendMessage(chatId, { message });
        void sendPromise.then(
          () => {
            sendSettled = true;
          },
          () => {
            sendSettled = true;
          },
        );
        if (req.signal.aborted) {
          await requestInterrupt();
          return new Response(null, { status: 499 });
        }
        const sent = await awaitRequestOrAbort(sendPromise, req.signal);
        const sentUserMessage = [...sent.state.messages].reverse().find((candidate) =>
          candidate.role === "user"
            && !previousMessageIds.has(candidate.id)
            && candidate.content === message,
        );

        waitSettled = false;
        waitPromise = chatManager.waitForChatIdle(chatId);
        void waitPromise.then(
          () => {
            waitSettled = true;
          },
          () => {
            waitSettled = true;
          },
        );
        const completed = await awaitRequestOrAbort(waitPromise, req.signal);

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
        if (clientAborted || req.signal.aborted) {
          await requestInterrupt();
          return new Response(null, { status: 499 });
        }
        log.error("Workspace prompt bridge error", { chatId, error: String(error) });
        return internalErrorResponse(
          error instanceof Error ? error : new Error(String(error)),
          { error: "prompt_failed", message: "Workspace prompt bridge failed" },
        );
      } finally {
        req.signal.removeEventListener("abort", abortHandler);
        if (clientAborted || req.signal.aborted) {
          await requestInterrupt();
        }
      }
    },
  },
});
