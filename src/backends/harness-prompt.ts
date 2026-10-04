/**
 * Bounded synchronous response consumption shared by native protocol adapters.
 */

import type { AgentResponse, Backend, PromptInput } from "./types";
import { createLogger } from "@pablozaiden/webapp/server";
import { HarnessError } from "./harness-errors";

const log = createLogger("harness-prompt");

export async function consumeHarnessPrompt(
  backend: Pick<Backend, "subscribeToEvents" | "sendPromptAsync">,
  id: string,
  prompt: PromptInput,
): Promise<AgentResponse> {
  const stream = await backend.subscribeToEvents(id);
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(new HarnessError("harness_request_failed", "The native principal response timed out."));
    stream.close();
  }, 120_000);
  const consume = async (): Promise<AgentResponse> => {
    await backend.sendPromptAsync(id, prompt);
    let content = "";
    let messageId = "";
    for (let event = await stream.next(); event !== null; event = await stream.next()) {
      if (event.scope.kind !== "principal") continue;
      if (event.type === "message.start") messageId = event.messageId;
      if (event.type === "message.complete") content = event.content;
      if (event.type === "request.error") log.warn("Native request failed before execution completion", { code: event.code, error: event.message });
      if (event.type === "error") throw new HarnessError("harness_request_failed", event.message);
      if (event.type === "prompt.complete") {
        if (event.outcome !== "completed") throw new HarnessError("harness_request_failed", "The native prompt was interrupted.");
        return { id: messageId, content, parts: [{ type: "text", text: content }] };
      }
    }
    throw new HarnessError("harness_event_gap", "The native stream closed before principal completion.");
  };
  try { return await Promise.race([consume(), timeout.promise]); } finally {
    clearTimeout(timer);
    stream.close();
  }
}
