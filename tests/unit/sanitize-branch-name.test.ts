/**
 * Unit tests for sanitizeBranchName utility.
 */

import { describe, test, expect } from "bun:test";
import { sanitizeBranchName } from "../../src/utils";

describe("sanitizeBranchName", () => {
  // ========================================================================
  // Normal input
  // ========================================================================

  test("passes through simple lowercase alphanumeric names", () => {
    expect(sanitizeBranchName("feature123")).toBe("feature123");
  });

  test("converts to lowercase", () => {
    expect(sanitizeBranchName("MyFeature")).toBe("myfeature");
  });

  test("preserves existing hyphens", () => {
    expect(sanitizeBranchName("my-feature")).toBe("my-feature");
  });

  // ========================================================================
  // Special character replacement
  // ========================================================================

  test("replaces spaces with hyphens", () => {
    expect(sanitizeBranchName("my feature branch")).toBe("my-feature-branch");
  });

  test("replaces underscores with hyphens", () => {
    expect(sanitizeBranchName("my_feature_branch")).toBe("my-feature-branch");
  });

  test("replaces slashes with hyphens", () => {
    expect(sanitizeBranchName("feature/new/thing")).toBe("feature-new-thing");
  });

  test("replaces dots with hyphens", () => {
    expect(sanitizeBranchName("v1.2.3")).toBe("v1-2-3");
  });

  test("replaces mixed special characters", () => {
    expect(sanitizeBranchName("feat: add @new $feature!")).toBe("feat-add-new-feature");
  });

  // ========================================================================
  // Hyphen collapsing
  // ========================================================================

  test("collapses multiple consecutive hyphens", () => {
    expect(sanitizeBranchName("a---b")).toBe("a-b");
  });

  test("collapses hyphens from multiple special chars", () => {
    expect(sanitizeBranchName("a   b")).toBe("a-b");
  });

  // ========================================================================
  // Leading/trailing hyphen trimming
  // ========================================================================

  test("removes leading hyphens", () => {
    expect(sanitizeBranchName("-feature")).toBe("feature");
  });

  test("removes trailing hyphens", () => {
    expect(sanitizeBranchName("feature-")).toBe("feature");
  });

  test("removes both leading and trailing hyphens", () => {
    expect(sanitizeBranchName("--feature--")).toBe("feature");
  });

  test("removes leading special characters that become hyphens", () => {
    expect(sanitizeBranchName("  feature")).toBe("feature");
  });

  // ========================================================================
  // Length limiting
  // ========================================================================

  test("limits output to 40 characters", () => {
    const longName = "a".repeat(50);
    expect(sanitizeBranchName(longName).length).toBe(40);
  });

  test("trims trailing hyphen introduced by truncation", () => {
    // 39 a's + space + "b..." => after sanitization becomes "aaa...a-b..."
    // Truncation at 40 chars lands right after the hyphen separator
    const name = "a".repeat(39) + " bbbbb";
    const result = sanitizeBranchName(name);
    expect(result).not.toMatch(/-$/);
    expect(result).toBe("a".repeat(39));
  });

  test("trims leading hyphen introduced by truncation edge case", () => {
    // This shouldn't happen with normal input since leading hyphens are trimmed
    // before truncation, but ensures robustness
    const result = sanitizeBranchName("a".repeat(40) + "-tail");
    expect(result).not.toMatch(/^-/);
    expect(result).not.toMatch(/-$/);
  });

  test("preserves names under 40 characters", () => {
    const shortName = "short-name";
    expect(sanitizeBranchName(shortName)).toBe("short-name");
  });

  test("handles exactly 40 characters", () => {
    const exact = "a".repeat(40);
    expect(sanitizeBranchName(exact)).toBe(exact);
  });

  // ========================================================================
  // Edge cases
  // ========================================================================

  test("returns 'unnamed' for empty input", () => {
    expect(sanitizeBranchName("")).toBe("unnamed");
  });

  test("returns 'unnamed' for all-special-character input", () => {
    expect(sanitizeBranchName("!!!@@@###$$$")).toBe("unnamed");
  });

  test("returns 'unnamed' for whitespace-only input", () => {
    expect(sanitizeBranchName("   ")).toBe("unnamed");
  });

  test("handles single character input", () => {
    expect(sanitizeBranchName("a")).toBe("a");
  });

  test("returns 'unnamed' for single special character input", () => {
    expect(sanitizeBranchName("!")).toBe("unnamed");
  });

  test("handles unicode characters by replacing with hyphens", () => {
    expect(sanitizeBranchName("feature-\u00e9")).toBe("feature");
  });

  test("handles emoji by replacing with hyphens", () => {
    const result = sanitizeBranchName("fix-bug-\ud83d\udc1b");
    expect(result).toBe("fix-bug");
  });

  test("handles numbers at start", () => {
    expect(sanitizeBranchName("123-feature")).toBe("123-feature");
  });

  test("realistic branch name from task name", () => {
    expect(sanitizeBranchName("Fix the login page CSS issue")).toBe("fix-the-login-page-css-issue");
  });

  test("realistic long branch name gets truncated", () => {
    const name = "implement the new user authentication system with oauth2 support";
    const result = sanitizeBranchName(name);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toBe("implement-the-new-user-authentication-sy");
  });
});
