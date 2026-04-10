import { describe, expect, test } from "bun:test";
import {
  getPlanFilePath,
  getPlanningDirectoryPath,
  getStatusFilePath,
} from "../../src/lib/planning-files";

describe("planning file paths", () => {
  test("normalizes trailing slashes and backslashes before joining planning paths", () => {
    expect(getPlanningDirectoryPath("/tmp/worktree/")).toBe("/tmp/worktree/.ralph-planning");
    expect(getPlanningDirectoryPath("\\tmp\\worktree\\nested\\")).toBe("/tmp/worktree/nested/.ralph-planning");
    expect(getPlanFilePath("/tmp/worktree//")).toBe("/tmp/worktree/.ralph-planning/plan.md");
    expect(getStatusFilePath("\\tmp\\worktree\\nested\\")).toBe("/tmp/worktree/nested/.ralph-planning/status.md");
  });
});
