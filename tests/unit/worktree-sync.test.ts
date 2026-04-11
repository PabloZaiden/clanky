import { describe, expect, test } from "bun:test";
import { syncMainCheckoutBeforeWorktree } from "../../src/core/git/worktree-sync";
import type { GitService } from "../../src/core/git-service";

describe("syncMainCheckoutBeforeWorktree", () => {
  test("checks out the base branch before pulling", async () => {
    const calls: string[] = [];

    await syncMainCheckoutBeforeWorktree({
      git: {
        getCurrentBranch: async () => "feature/current",
        checkoutBranch: async (_directory: string, branch: string) => {
          calls.push(`checkout:${branch}`);
        },
        pull: async (_directory: string, branch?: string) => {
          calls.push(`pull:${branch}`);
          return true;
        },
      } as Pick<GitService, "getCurrentBranch" | "checkoutBranch" | "pull">,
      directory: "/repo",
      baseBranch: "main",
    });

    expect(calls).toEqual([
      "checkout:main",
      "pull:main",
    ]);
  });

  test("skips checkout when already on the base branch and reports skipped pull", async () => {
    const infoMessages: string[] = [];
    const debugMessages: string[] = [];

    await syncMainCheckoutBeforeWorktree({
      git: {
        getCurrentBranch: async () => "main",
        checkoutBranch: async () => {
          throw new Error("checkout should not be called");
        },
        pull: async () => false,
      } as Pick<GitService, "getCurrentBranch" | "checkoutBranch" | "pull">,
      directory: "/repo",
      baseBranch: "main",
      onInfo: (message: string) => {
        infoMessages.push(message);
      },
      onDebug: (message: string) => {
        debugMessages.push(message);
      },
    });

    expect(infoMessages).toEqual([
      "Pulling latest changes from remote for branch: main",
    ]);
    expect(debugMessages).toEqual([
      "Skipped pull for main (no remote or upstream configured)",
    ]);
  });
});
