/**
 * Inline SDK attachments preserve execution-host independence.
 */

import type { MessageOptions } from "@github/copilot-sdk";
import type { PromptInput } from "@/shared/harness-input";

export function toCopilotMessage(input: PromptInput): MessageOptions {
  const text: string[] = [];
  const attachments: NonNullable<MessageOptions["attachments"]> = [];
  for (const part of input.parts) {
    if (part.type === "text") {
      text.push(part.text);
    } else if (part.type === "image") {
      attachments.push({ type: "blob", data: part.data, mimeType: part.mimeType, displayName: part.filename });
    } else if ("text" in part.resource) {
      text.push(part.resource.text);
    } else {
      attachments.push({
        type: "blob",
        data: part.resource.blob,
        mimeType: part.resource.mimeType ?? "application/octet-stream",
        displayName: part.resource.uri,
      });
    }
  }
  return { prompt: text.join("\n\n"), attachments };
}
