import { describe, expect, test } from "bun:test";
import { PROMPT_TEMPLATES, getTemplateById } from "@/lib/prompt-templates";

describe("prompt templates", () => {
  test("defines one shared template registry with unique IDs", () => {
    const ids = PROMPT_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getTemplateById("project-analysis")?.prompt).toContain(
      "Analyze this entire project in detail",
    );
    expect(getTemplateById("fix-failing-tests")?.prompt).toContain(
      "Run the full test suite",
    );
  });

  test("registers dependency update template with stable-update guidance", () => {
    const template = getTemplateById("update-project-dependencies");

    expect(template).toBeDefined();
    expect(template?.name).toBe("Update all project dependencies to the latest stable version");
    expect(template?.description).toBe(
      "Updates project dependencies to the latest stable versions across detected package ecosystems and verifies the result.",
    );
    expect(template?.loopDefaults?.planMode).toBe(true);
    expect(template?.prompt).toContain("latest stable non-prerelease versions");
    expect(template?.prompt).toContain("package.json");
    expect(template?.prompt).toContain("go.mod");
    expect(template?.prompt).toContain("Cargo.toml");
    expect(template?.prompt).toContain("document why");
  });
});
