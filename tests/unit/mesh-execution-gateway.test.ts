import { describe, expect, test } from "bun:test";
import {
  assertMeshExecutionCwd,
  assertMeshExecutionPath,
} from "../../src/core/mesh-execution-gateway";

describe("mesh execution path validation", () => {
  test("accepts arbitrary absolute host paths", () => {
    expect(assertMeshExecutionCwd("/workspaces/repo", "/workspaces/repo"))
      .toBe("/workspaces/repo");
    expect(assertMeshExecutionCwd("/workspaces/repo", "/workspaces/repo/.clanky-worktrees/task-1"))
      .toBe("/workspaces/repo/.clanky-worktrees/task-1");
    expect(assertMeshExecutionCwd("/workspaces/repo", "/tmp/other"))
      .toBe("/tmp/other");
    expect(assertMeshExecutionPath("/workspaces/repo", "/workspaces/repo/../other"))
      .toBe("/workspaces/other");
  });

  test("rejects non-absolute paths and NUL bytes", () => {
    expect(() => assertMeshExecutionPath("/workspaces/repo", "relative/path"))
      .toThrow();
    expect(() => assertMeshExecutionCwd("/workspaces/repo", "/tmp/invalid\0path"))
      .toThrow();
  });
});
