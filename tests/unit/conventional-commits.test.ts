/**
 * Unit tests for the conventional commits utility module.
 */

import { test, expect, describe } from "bun:test";
import {
  CONVENTIONAL_COMMIT_TYPES,
  formatConventionalCommit,
  parseConventionalCommit,
  normalizeAiCommitMessage,
} from "../../src/core/conventional-commits";

describe("formatConventionalCommit", () => {
  test("formats with scope", () => {
    const result = formatConventionalCommit("feat", "auth", "add auth endpoint");
    expect(result).toBe("feat(auth): add auth endpoint");
  });

  test("formats without scope", () => {
    const result = formatConventionalCommit("fix", undefined, "resolve null pointer");
    expect(result).toBe("fix: resolve null pointer");
  });

  test("omits generic clanky scope", () => {
    const result = formatConventionalCommit("feat", "clanky", "add auth endpoint");
    expect(result).toBe("feat: add auth endpoint");
  });

  test("formats with empty string scope (treated as no scope)", () => {
    const result = formatConventionalCommit("chore", "", "update deps");
    expect(result).toBe("chore: update deps");
  });

  test("formats with body", () => {
    const result = formatConventionalCommit("feat", "auth", "add login", "Detailed explanation\nof the change");
    expect(result).toBe("feat(auth): add login\n\nDetailed explanation\nof the change");
  });

  test("formats with empty body (ignored)", () => {
    const result = formatConventionalCommit("fix", "api", "fix bug", "");
    expect(result).toBe("fix(api): fix bug");
  });

  test("formats with whitespace-only body (ignored)", () => {
    const result = formatConventionalCommit("fix", "api", "fix bug", "   \n  ");
    expect(result).toBe("fix(api): fix bug");
  });

  test("trims description whitespace", () => {
    const result = formatConventionalCommit("chore", "deps", "  update deps  ");
    expect(result).toBe("chore(deps): update deps");
  });
});

describe("parseConventionalCommit", () => {
  test("parses basic conventional commit", () => {
    const result = parseConventionalCommit("feat: add auth endpoint");
    expect(result).toEqual({
      type: "feat",
      scope: undefined,
      description: "add auth endpoint",
      body: undefined,
    });
  });

  test("parses with scope", () => {
    const result = parseConventionalCommit("feat(auth): add auth endpoint");
    expect(result).toEqual({
      type: "feat",
      scope: "auth",
      description: "add auth endpoint",
      body: undefined,
    });
  });

  test("parses with body", () => {
    const result = parseConventionalCommit("feat(auth): add auth\n\nDetailed body here");
    expect(result).toEqual({
      type: "feat",
      scope: "auth",
      description: "add auth",
      body: "Detailed body here",
    });
  });

  test("parses with multi-line body", () => {
    const result = parseConventionalCommit("fix: resolve crash\n\nLine 1\nLine 2\nLine 3");
    expect(result).toEqual({
      type: "fix",
      scope: undefined,
      description: "resolve crash",
      body: "Line 1\nLine 2\nLine 3",
    });
  });

  test("parses breaking change indicator", () => {
    const result = parseConventionalCommit("feat!: drop support for Node 12");
    expect(result).toEqual({
      type: "feat",
      scope: undefined,
      description: "drop support for Node 12",
      body: undefined,
    });
  });

  test("parses all valid types", () => {
    for (const type of CONVENTIONAL_COMMIT_TYPES) {
      const result = parseConventionalCommit(`${type}: some description`);
      expect(result).not.toBeNull();
      expect(result!.type).toBe(type);
    }
  });

  test("returns null for empty string", () => {
    expect(parseConventionalCommit("")).toBeNull();
  });

  test("returns null for non-conventional message", () => {
    expect(parseConventionalCommit("Add auth endpoint")).toBeNull();
  });

  test("returns null for unknown type", () => {
    expect(parseConventionalCommit("unknown: some description")).toBeNull();
  });

  test("returns null for missing colon", () => {
    expect(parseConventionalCommit("feat add auth endpoint")).toBeNull();
  });

  test("returns null for missing space after colon", () => {
    expect(parseConventionalCommit("feat:missing space")).toBeNull();
  });

  test("returns null for empty description after colon", () => {
    // The regex requires at least one char after ": "
    expect(parseConventionalCommit("feat: ")).toBeNull();
  });
});

describe("normalizeAiCommitMessage", () => {
  test("normalizes valid conventional commit without configured scope", () => {
    const result = normalizeAiCommitMessage("feat: add auth endpoint", undefined);
    expect(result).toBe("feat: add auth endpoint");
  });

  test("replaces existing scope with configured meaningful one", () => {
    const result = normalizeAiCommitMessage("feat(wrong-scope): add auth", "api");
    expect(result).toBe("feat(api): add auth");
  });

  test("handles undefined scope (no scope in output)", () => {
    const result = normalizeAiCommitMessage("feat: add auth endpoint", undefined);
    expect(result).toBe("feat: add auth endpoint");
  });

  test("handles empty scope", () => {
    const result = normalizeAiCommitMessage("feat: add auth endpoint", "");
    expect(result).toBe("feat: add auth endpoint");
  });

  test("preserves meaningful AI scope when no configured scope exists", () => {
    const result = normalizeAiCommitMessage("feat(auth): add auth endpoint", undefined);
    expect(result).toBe("feat(auth): add auth endpoint");
  });

  test("drops generic AI scope when no configured scope exists", () => {
    const result = normalizeAiCommitMessage("feat(clanky): add auth endpoint", undefined);
    expect(result).toBe("feat: add auth endpoint");
  });

  test("preserves body from AI output", () => {
    const result = normalizeAiCommitMessage("feat(auth): add auth\n\nDetailed body", undefined);
    expect(result).toBe("feat(auth): add auth\n\nDetailed body");
  });

  test("falls back to chore for non-conventional message", () => {
    const result = normalizeAiCommitMessage("Add auth endpoint", undefined);
    expect(result).toBe("chore: add auth endpoint");
  });

  test("falls back for empty input", () => {
    const result = normalizeAiCommitMessage("", undefined);
    expect(result).toBe("chore: update code");
  });

  test("falls back for whitespace-only input", () => {
    const result = normalizeAiCommitMessage("   ", undefined);
    expect(result).toBe("chore: update code");
  });

  test("strips markdown code fences", () => {
    const result = normalizeAiCommitMessage("```\nfeat: add auth endpoint\n```", undefined);
    expect(result).toBe("feat: add auth endpoint");
  });

  test("strips markdown code fences with language tag", () => {
    const result = normalizeAiCommitMessage("```text\nfix: resolve crash\n```", "api");
    expect(result).toBe("fix(api): resolve crash");
  });

  test("handles case-insensitive type in loose match", () => {
    const result = normalizeAiCommitMessage("Fix: resolve crash", undefined);
    expect(result).toBe("fix: resolve crash");
  });

  test("treats configured generic scope as no scope", () => {
    const result = normalizeAiCommitMessage("fix: resolve crash", "clanky");
    expect(result).toBe("fix: resolve crash");
  });

  test("truncates very long fallback messages", () => {
    const longMessage = "A".repeat(200);
    const result = normalizeAiCommitMessage(longMessage, undefined);
    // Should be a valid conventional commit and not exceed reasonable length
    expect(result).toMatch(/^chore: /);
    expect(result.split("\n")[0]!.length).toBeLessThanOrEqual(72);
  });

  test("handles all valid types from AI", () => {
    for (const type of CONVENTIONAL_COMMIT_TYPES) {
      const result = normalizeAiCommitMessage(`${type}: some change`, undefined);
      expect(result).toBe(`${type}: some change`);
    }
  });
});

describe("GitConfigSchema commitScope sanitization", () => {
  // Import the schema for validation tests
  const { GitConfigSchema } = require("../../src/types/schemas/task");

  test("passes through meaningful commitScope", () => {
    const result = GitConfigSchema.parse({ branchPrefix: "", commitScope: "auth" });
    expect(result.commitScope).toBe("auth");
  });

  test("trims whitespace from commitScope", () => {
    const result = GitConfigSchema.parse({ branchPrefix: "", commitScope: "  auth  " });
    expect(result.commitScope).toBe("auth");
  });

  test("maps generic commitScope to empty string", () => {
    const result = GitConfigSchema.parse({ branchPrefix: "", commitScope: "clanky" });
    expect(result.commitScope).toBe("");
  });

  test("maps whitespace-only commitScope to empty string", () => {
    const result = GitConfigSchema.parse({ branchPrefix: "", commitScope: "   " });
    expect(result.commitScope).toBe("");
  });

  test("maps empty string commitScope to empty string", () => {
    const result = GitConfigSchema.parse({ branchPrefix: "", commitScope: "" });
    expect(result.commitScope).toBe("");
  });

  test("requires an explicit commitScope string", () => {
    expect(GitConfigSchema.safeParse({ branchPrefix: "" }).success).toBe(false);
  });

  test("keeps branchPrefix and commitScope explicit", () => {
    const result = GitConfigSchema.parse({ branchPrefix: "feature/", commitScope: "custom" });
    expect(result.branchPrefix).toBe("feature/");
    expect(result.commitScope).toBe("custom");
  });
});
