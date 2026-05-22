import { describe, expect, test } from "bun:test";
import {
  getPlanFilePath,
  getPlanningDirectoryPath,
  getStatusFilePath,
} from "../../src/lib/planning-files";

describe("planning file paths", () => {
  test("normalizes trailing slashes and backslashes before joining planning paths", () => {
    expect(getPlanningDirectoryPath("/tmp/worktree/")).toBe("/tmp/worktree/.clanky-planning");
    expect(getPlanningDirectoryPath("\\tmp\\worktree\\nested\\")).toBe("/tmp/worktree/nested/.clanky-planning");
    expect(getPlanFilePath("/tmp/worktree//")).toBe("/tmp/worktree/.clanky-planning/plan.md");
    expect(getStatusFilePath("\\tmp\\worktree\\nested\\")).toBe("/tmp/worktree/nested/.clanky-planning/status.md");
  });
});
