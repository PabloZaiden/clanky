import { describe, expect, test } from "bun:test";
import {
  CHAT_PROMPT_TEMPLATES,
  getChatTemplateById,
} from "../../src/lib/chat-prompt-templates";
import {
  PROMPT_TEMPLATES,
  getTemplateById,
} from "../../src/lib/prompt-templates";

describe("chat prompt templates", () => {
  test("uses the shared prompt template registry", () => {
    expect(CHAT_PROMPT_TEMPLATES).toBe(PROMPT_TEMPLATES);
    expect(getChatTemplateById("project-analysis")).toBe(
      getTemplateById("project-analysis"),
    );
    expect(getChatTemplateById("fix-failing-tests")).toBe(
      getTemplateById("fix-failing-tests"),
    );
  });

  test("includes the Project Analysis template with the required instructions", () => {
    const template = getChatTemplateById("project-analysis");
    expect(template?.name).toBe("Project Analysis");
    expect(template?.prompt).toContain("Analyze this entire project in detail");
    expect(template?.prompt).toContain("detailed explanation");
    expect(template?.prompt).toContain("Architecture diagrams");
    expect(template?.prompt).toContain("State diagrams");
    expect(template?.prompt).toContain("Mermaid");
  });
});
