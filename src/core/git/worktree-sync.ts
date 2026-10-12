import type { GitService } from "../git";

interface SyncMainCheckoutBeforeWorktreeOptions {
  git: Pick<
    GitService,
    | "getCurrentBranch"
    | "checkoutBranch"
    | "pull"
    | "parseRemoteBranchReference"
  >;
  directory: string;
  baseBranch: string;
  onInfo?: (message: string) => void;
  onDebug?: (message: string) => void;
}

export async function syncMainCheckoutBeforeWorktree(
  options: SyncMainCheckoutBeforeWorktreeOptions,
): Promise<void> {
  const {
    git,
    directory,
    baseBranch,
    onInfo,
    onDebug,
  } = options;

  const remoteBase = await git.parseRemoteBranchReference(directory, baseBranch);
  if (remoteBase) {
    onInfo?.(`Using fetched remote branch as worktree base: ${remoteBase.ref}`);
    return;
  }

  const currentBranch = await git.getCurrentBranch(directory);
  if (currentBranch !== baseBranch) {
    onInfo?.(`Checking out base branch in main checkout: ${baseBranch}`);
    await git.checkoutBranch(directory, baseBranch);
  }

  onInfo?.(`Pulling latest changes from remote for branch: ${baseBranch}`);
  const pullSucceeded = await git.pull(directory, baseBranch);
  if (pullSucceeded) {
    onInfo?.(`Successfully pulled latest changes for ${baseBranch}`);
  } else {
    onDebug?.(`Skipped pull for ${baseBranch} (no remote or upstream configured)`);
  }
}
