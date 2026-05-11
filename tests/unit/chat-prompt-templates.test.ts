import { describe, expect, test } from "bun:test";
import {
  CHAT_PROMPT_TEMPLATES,
  getChatTemplateById,
} from "../../src/lib/chat-prompt-templates";

describe("chat prompt templates", () => {
  test("defines only the Project Analysis template with the required instructions", () => {
    expect(CHAT_PROMPT_TEMPLATES).toHaveLength(1);

    const template = getChatTemplateById("project-analysis");
    expect(template?.name).toBe("Project Analysis");
    expect(template?.prompt).toContain("Analyze this entire project in detail");
    expect(template?.prompt).toContain("detailed explanation");
    expect(template?.prompt).toContain("Architecture diagrams");
    expect(template?.prompt).toContain("State diagrams");
    expect(template?.prompt).toContain("Mermaid");
  });
});
