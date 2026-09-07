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

  test("resolves relative paths against the execution root", () => {
    expect(assertMeshExecutionPath("/workspaces/repo", "relative/path"))
      .toBe("/workspaces/repo/relative/path");
    expect(assertMeshExecutionCwd("/workspaces/repo", "."))
      .toBe("/workspaces/repo");
    expect(assertMeshExecutionCwd("/workspaces/repo", "subdir"))
      .toBe("/workspaces/repo/subdir");
  });

  test("rejects NUL bytes", () => {
    expect(() => assertMeshExecutionCwd("/workspaces/repo", "/tmp/invalid\0path"))
      .toThrow();
    expect(() => assertMeshExecutionPath("/workspaces/repo\0invalid", "path"))
      .toThrow();
    expect(() => assertMeshExecutionPath("relative-root", "path"))
      .toThrow();
  });
});
