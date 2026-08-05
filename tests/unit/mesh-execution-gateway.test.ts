import { describe, expect, test } from "bun:test";
import {
  assertMeshExecutionCwd,
  assertMeshExecutionPath,
} from "../../src/core/mesh-execution-gateway";

describe("mesh execution path validation", () => {
  test("accepts the workspace root and direct managed worktrees", () => {
    expect(assertMeshExecutionCwd("/workspaces/repo", "/workspaces/repo"))
      .toBe("/workspaces/repo");
    expect(assertMeshExecutionCwd("/workspaces/repo", "/workspaces/repo/.clanky-worktrees/task-1"))
      .toBe("/workspaces/repo/.clanky-worktrees/task-1");
  });

  test("rejects traversal, sibling paths, and nested managed paths", () => {
    expect(() => assertMeshExecutionPath("/workspaces/repo", "/workspaces/repo/../other"))
      .toThrow();
    expect(() => assertMeshExecutionCwd("/workspaces/repo", "/workspaces/repo-sibling"))
      .toThrow();
    expect(() => assertMeshExecutionCwd("/workspaces/repo", "/workspaces/repo/.clanky-worktrees/task/nested"))
      .toThrow();
  });
});
