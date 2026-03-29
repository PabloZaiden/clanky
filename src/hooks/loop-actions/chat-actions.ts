/**
 * Chat loop actions: create chat, send message, convert chat to loop.
 */

import type { Loop, CreateChatRequest, ConvertChatToLoopRequest, SendChatMessageResponse } from "../../types";
import type { MessageImageAttachment } from "../../types/message-attachments";
import { apiCall } from "./helpers";

/**
 * Create a new interactive chat via the API.
 */
export async function createChatApi(request: CreateChatRequest): Promise<Loop> {
  return apiCall<Loop>(
    "/api/loops/chat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
    "Create chat",
  );
}

/**
 * Send a message to an interactive chat via the API.
 * Returns after the backend has safely accepted the message and coordinated
 * any required chat-turn restart, but does not wait for the AI response.
 */
export async function sendChatMessageApi(
  loopId: string,
  message: string,
  model?: { providerID: string; modelID: string },
  attachments?: MessageImageAttachment[],
): Promise<SendChatMessageResponse> {
  return apiCall<SendChatMessageResponse>(
    `/api/loops/${loopId}/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, model, attachments }),
    },
    "Send chat message",
  );
}

export async function convertChatToLoopApi(
  loopId: string,
  request: ConvertChatToLoopRequest = {},
): Promise<Loop> {
  return apiCall<Loop>(
    `/api/loops/${loopId}/chat/convert-to-loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
    "Convert chat to loop",
  );
}
