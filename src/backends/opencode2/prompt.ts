/**
 * Native inline inputs; workspace attachments never assume a controller file.
 */

import type { SessionPromptInput } from "@opencode/client";
import type { PromptInput } from "../types";

export function toOpenCodePrompt(prompt: PromptInput): Pick<SessionPromptInput, "text" | "files"> {
  const text: string[] = [];
  const files: NonNullable<SessionPromptInput["files"]>[number][] = [];
  for (const part of prompt.parts) {
    if (part.type === "text") text.push(part.text);
    else if (part.type === "image") files.push({ uri: `data:${part.mimeType};base64,${part.data}` });
    else if ("text" in part.resource) text.push(`${part.resource.uri}\n${part.resource.text}`);
    else files.push({ uri: `data:${part.resource.mimeType ?? "application/octet-stream"};base64,${part.resource.blob}`, name: part.resource.uri });
  }
  return { text: text.join("\n"), files: files.length ? files : undefined };
}
