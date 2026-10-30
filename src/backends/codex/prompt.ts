/**
 * Inline native inputs avoid execution-host filesystem assumptions.
 */

import type { PromptInput } from "../types";
import type { UserInput } from "./generated/v2/UserInput";
import { HarnessError } from "../harness-errors";
import { AGENT_NOTIFICATION_INSTRUCTIONS } from "@/shared/agent-notifications";

export function toCodexInput(prompt: PromptInput): UserInput[] {
  const input = prompt.parts.map((part): UserInput => {
    if (part.type === "text") return { type: "text", text: part.text, text_elements: [] };
    if (part.type === "image") return { type: "image", url: `data:${part.mimeType};base64,${part.data}` };
    if ("text" in part.resource) return {
      type: "text", text: `${part.resource.uri}\n${part.resource.text}`, text_elements: [],
    };
    if (part.resource.mimeType?.startsWith("image/")) {
      return { type: "image", url: `data:${part.resource.mimeType};base64,${part.resource.blob}` };
    }
    throw new HarnessError("harness_unsupported_feature", "Codex does not accept this inline binary attachment.");
  });
  input.push({ type: "text", text: AGENT_NOTIFICATION_INSTRUCTIONS, text_elements: [] });
  return input;
}
