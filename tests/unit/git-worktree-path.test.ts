import { describe, expect, test } from "bun:test";
import {
  GitService,
  InvalidManagedWorktreePathError,
} from "../../src/core/git";
import type {
  CommandOptions,
  CommandResult,
} from "../../src/core/command-executor";
import { ManagedPathService } from "../../src/core/managed-path-service";
import { TestCommandExecutor } from "../mocks/mock-executor";

class RelativeGitPathExecutor extends TestCommandExecutor {
  override readonly pathStyle = "posix";
  readonly writes = new Map<string, string>();

  override async getExecutionDirectory(): Promise<string> {
    return "/remote/workspaces/repository";
  }

  override async exec(
    command: string,
    args: string[],
    _options?: CommandOptions,
  ): Promise<CommandResult> {
    if (
      command === "git"
      && args.slice(-4).join(" ") === "rev-parse --path-format=absolute --git-path info/exclude"
    ) {
      return {
        success: true,
        stdout: "/remote/workspaces/repository/.git/info/exclude\n",
        stderr: "",
        exitCode: 0,
      };
    }
    return {
      success: false,
      stdout: "",
      stderr: `Unexpected command: ${command} ${args.join(" ")}`,
      exitCode: 1,
    };
  }

  override async readFile(path: string): Promise<string | null> {
    return this.writes.get(path) ?? null;
  }

  override async writeFile(path: string, content: string): Promise<boolean> {
    this.writes.set(path, content);
    return true;
  }
}

describe("Managed worktree paths", () => {
  const paths = new ManagedPathService("posix");

  test("constructs paths from the explicit repository directory", () => {
    expect(paths.getManagedWorktreeRoot("/remote/workspaces/repository")).toBe(
      "/remote/workspaces/repository/.clanky-worktrees",
    );
    expect(paths.getManagedWorktreePath("/remote/workspaces/repository", "task-123")).toBe(
      "/remote/workspaces/repository/.clanky-worktrees/task-123",
    );
    expect(() =>
      paths.getManagedWorktreePath("remote/workspaces/repository", "chat-123")
    ).toThrow(InvalidManagedWorktreePathError);
  });

  test("normalizes safe identifiers and rejects path traversal", () => {
    expect(paths.normalizeManagedWorktreeIdentifier(" task-123 ")).toBe("task-123");

    for (const identifier of ["", ".", "..", "../outside", "task/child", "task\\child", "task\0"]) {
      expect(() => paths.normalizeManagedWorktreeIdentifier(identifier)).toThrow(InvalidManagedWorktreePathError);
    }
  });

  test("accepts only direct children of the managed root", () => {
    const repoDirectory = "/remote/workspaces/repository";
    const worktreePath = paths.getManagedWorktreePath(repoDirectory, "task-123");

    expect(paths.isManagedWorktreePath(repoDirectory, worktreePath)).toBe(true);
    expect(paths.isManagedWorktreePath(repoDirectory, `${worktreePath}/`)).toBe(true);
    expect(paths.assertManagedWorktreePath(repoDirectory, `${worktreePath}/`)).toBe(worktreePath);

    expect(paths.isManagedWorktreePath(repoDirectory, paths.getManagedWorktreeRoot(repoDirectory))).toBe(false);
    expect(paths.isManagedWorktreePath(repoDirectory, `${worktreePath}/nested`)).toBe(false);
    expect(paths.isManagedWorktreePath(repoDirectory, `${repoDirectory}/outside`)).toBe(false);
    expect(paths.isManagedWorktreePath(repoDirectory, `${repoDirectory}/.clanky-worktrees/../outside`)).toBe(false);
    expect(() => paths.assertManagedWorktreePath(repoDirectory, `${repoDirectory}/outside`)).toThrow(
      InvalidManagedWorktreePathError,
    );
  });

  test("requires persisted paths to match their identifier-specific canonical path", () => {
    const repoDirectory = "/remote/workspaces/repository";
    const canonicalPath = paths.getManagedWorktreePath(repoDirectory, "task-123");

    expect(paths.assertCanonicalManagedWorktreePath(repoDirectory, "task-123", canonicalPath)).toBe(canonicalPath);
    expect(() => paths.assertCanonicalManagedWorktreePath(repoDirectory, "task-123", `${canonicalPath}/`)).toThrow(
      InvalidManagedWorktreePathError,
    );
    expect(() => paths.assertCanonicalManagedWorktreePath(
      repoDirectory,
      "task-123",
      paths.getManagedWorktreePath(repoDirectory, "task-456"),
    )).toThrow(InvalidManagedWorktreePathError);
  });

  test("uses Windows separators and case-insensitive containment", () => {
    const windowsPaths = new ManagedPathService("windows");
    const repoDirectory = String.raw`C:\work\repository`;
    const canonicalPath = String.raw`C:\work\repository\.clanky-worktrees\task-123`;

    expect(windowsPaths.getManagedWorktreePath(repoDirectory, "task-123")).toBe(canonicalPath);
    expect(windowsPaths.isManagedWorktreePath(
      String.raw`c:\WORK\repository`,
      String.raw`C:\work\REPOSITORY\.clanky-worktrees\TASK-123`,
    )).toBe(true);
    expect(windowsPaths.assertCanonicalManagedWorktreePath(
      repoDirectory,
      "task-123",
      String.raw`c:\WORK\repository\.clanky-worktrees\task-123`,
    )).toBe(canonicalPath);
    expect(windowsPaths.getPlanFilePath(repoDirectory)).toBe(
      String.raw`C:\work\repository\.clanky-planning\plan.md`,
    );
  });

  test("rejects Windows reserved and unstable path components", () => {
    const windowsPaths = new ManagedPathService("windows");

    for (const identifier of ["CON", "task.", "task:stream"]) {
      expect(() => windowsPaths.normalizeManagedWorktreeIdentifier(identifier)).toThrow(
        InvalidManagedWorktreePathError,
      );
    }
  });

  test("rejects unsafe lookup and cleanup paths before executor operations", async () => {
    const git = new GitService(new TestCommandExecutor());
    const unsafePath = "/remote/workspaces/repository/outside";

    await expect(git.worktreeExists("/remote/workspaces/repository", unsafePath)).rejects.toThrow(
      InvalidManagedWorktreePathError,
    );
    await expect(git.ensureWorktreeRemoved("/remote/workspaces/repository", unsafePath)).rejects.toThrow(
      InvalidManagedWorktreePathError,
    );
  });

  test("resolves Git metadata from the executor's canonical absolute directory", async () => {
    const executor = new RelativeGitPathExecutor();
    const git = GitService.withExecutor(executor);

    await git.ensureWorktreeExcluded("relative/repository");

    expect(executor.writes.get(
      "/remote/workspaces/repository/.git/info/exclude",
    )).toContain(".clanky-worktrees");
  });
});
