import { describe, expect, test } from "bun:test";
import { getTemplateById } from "@/lib/prompt-templates";

describe("prompt templates", () => {
  test("registers dependency update template with stable-update guidance", () => {
    const template = getTemplateById("update-project-dependencies");

    expect(template).toBeDefined();
    expect(template?.name).toBe("Update all project dependencies to the latest stable version");
    expect(template?.description).toBe(
      "Updates project dependencies to the latest stable versions across detected package ecosystems and verifies the result.",
    );
    expect(template?.defaults?.planMode).toBe(true);
    expect(template?.prompt).toContain("latest stable non-prerelease versions");
    expect(template?.prompt).toContain("package.json");
    expect(template?.prompt).toContain("go.mod");
    expect(template?.prompt).toContain("Cargo.toml");
    expect(template?.prompt).toContain("document why");
  });
});
