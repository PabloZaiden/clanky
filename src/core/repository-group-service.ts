import type { ChatRepositoryWorktree, ChatWorktreeGroup, RepositoryBaseSelection, WorkspaceRepository } from "@/shared/repository-group";
import { RepositoryNameSchema } from "@/contracts/schemas/repository-group";
import { DomainError } from "../domain/domain-error";
import type { CommandExecutor } from "./command-executor";
import { resolveCommandExecutorDirectory } from "./command-executor";
import { executionPathsEqual, joinExecutionPath, normalizeExecutionRoot } from "./execution-path";
import { GitService } from "./git";
import { gitError, runGitCommand } from "./git/git-core";
import { ManagedPathService, MANAGED_WORKTREE_DIRECTORY_NAME } from "./managed-path-service";

type SourceRepository = Pick<WorkspaceRepository, "name" | "identity"> & { directory: string };

function failure(message: string, cause?: unknown) {
  return new DomainError("repository_group_unavailable", message, { cause });
}

function child(executor: CommandExecutor, parent: string, name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw failure("Invalid repository group directory entry.");
  }
  return joinExecutionPath(executor.pathStyle, parent, name);
}

async function gitRoot(executor: CommandExecutor, directory: string): Promise<string | null> {
  const args = ["rev-parse", "--show-toplevel"];
  const result = await runGitCommand(executor, directory, args, { allowFailure: true });
  if (result.success) return result.stdout.replace(/\n$/, "");
  if (/not a git repository/i.test(result.stderr)) return null;
  throw gitError("Could not read the Git root", result, args);
}

async function directoryIdentity(executor: CommandExecutor, directory: string, cwd: string): Promise<string> {
  const linux = await executor.exec("stat", ["-L", "-c", "%d:%i:%w", "--", directory], { cwd, logFailures: false });
  if (linux.success && linux.stdout.trim()) return linux.stdout.trim();
  const mac = await executor.exec("stat", ["-L", "-f", "%d:%i:%B", "--", directory], { cwd, logFailures: false });
  if (mac.success && mac.stdout.trim()) return mac.stdout.trim();
  throw failure("Could not verify the directory's identity.");
}

async function repositoryIdentity(executor: CommandExecutor, directory: string): Promise<string> {
  const commonDirectory = await GitService.withExecutor(executor).getCommonGitDirectory(directory);
  return directoryIdentity(executor, commonDirectory, directory);
}

async function discover(executor: CommandExecutor, directory: string) {
  const configured = await resolveCommandExecutorDirectory(executor, directory);
  const physical = await executor.exec("pwd", ["-P"], { cwd: configured, logFailures: false });
  if (!physical.success) throw failure("Could not resolve the workspace directory on its host.");
  const root = normalizeExecutionRoot(physical.stdout.replace(/\n$/, ""), executor.pathStyle);
  if (/[\r\n]/.test(root)) throw failure("Multirepository workspace paths cannot contain line breaks.");
  if (await gitRoot(executor, root)) {
    throw failure("A multirepository workspace must be outside a Git working tree.");
  }
  const entries = await executor.listDirectoryEntries(root, { includeHidden: true });
  const repositories: SourceRepository[] = [];
  const identities = new Set<string>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.kind !== "directory" || entry.isSymbolicLink || entry.name === MANAGED_WORKTREE_DIRECTORY_NAME) continue;
    const directory = child(executor, root, entry.name);
    try {
      if (!await executor.getFileMetadata(child(executor, directory, ".git"), { includeContentHash: false })) continue;
      const topLevel = await gitRoot(executor, directory);
      if (!topLevel || !executionPathsEqual(topLevel, directory, executor.pathStyle)) continue;
      const name = RepositoryNameSchema.parse(entry.name);
      const identity = await repositoryIdentity(executor, directory);
      if (identities.has(identity)) {
        throw failure("Two child directories use the same underlying Git repository.");
      }
      identities.add(identity);
      repositories.push({ name, directory, identity });
    } catch (error) {
      throw failure(`Could not discover repository "${entry.name}": ${String(error)}`, error);
    }
  }
  return { root, repositories };
}

async function readBranches(executor: CommandExecutor, directory: string) {
  const args = ["for-each-ref", "--format=%(refname)%09%(symref)%09%(upstream)%09%(upstream:remotename)%09%(upstream:remoteref)", "refs/heads", "refs/remotes"];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) throw gitError("Could not list repository branches", result, args);
  const refs: string[] = [];
  const defaults = new Map<string, string>();
  const upstreams = new Map<string, { ref: string; remote: string; remoteRef: string }>();
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const [ref = "", target, upstream, remote, remoteRef] = line.split("\t");
    if (target) {
      if (ref.startsWith("refs/remotes/") && ref.endsWith("/HEAD")) defaults.set(ref, target);
    } else if (ref) {
      refs.push(ref);
      if (ref.startsWith("refs/heads/") && upstream?.startsWith("refs/remotes/") && remote && remote !== "." && remoteRef?.startsWith("refs/heads/")) {
        upstreams.set(ref, { ref: upstream, remote, remoteRef });
      }
    }
  }
  const origin = defaults.get("refs/remotes/origin/HEAD");
  const remoteResult = await runGitCommand(executor, directory, ["remote"]);
  if (!remoteResult.success) throw gitError("Could not read repository remotes", remoteResult, ["remote"]);
  const remotes = remoteResult.stdout.trim().split("\n").filter(Boolean);
  const remoteRef = origin ?? (remotes.length === 1 ? defaults.get(`refs/remotes/${remotes[0]}/HEAD`) : undefined);
  const defaultRef = remoteRef && refs.includes(remoteRef)
    ? remoteRef
    : remotes.length === 0
      ? refs.find((ref) => ref === "refs/heads/main") ?? refs.find((ref) => ref === "refs/heads/master") ?? (refs.length === 1 ? refs[0] : null)
      : null;
  return { refs, defaultRef: defaultRef ?? null, remotes, upstreams, defaultRemote: remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined };
}

async function readBaseCommit(executor: CommandExecutor, directory: string, ref: string): Promise<string> {
  const result = await runGitCommand(executor, directory, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const commit = result.stdout.trim();
  if (!result.success || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw failure(`Base branch "${ref}" does not point to a commit.`);
  }
  return commit;
}

async function isAncestor(executor: CommandExecutor, directory: string, older: string, newer: string): Promise<boolean> {
  const args = ["merge-base", "--is-ancestor", older, newer];
  const result = await runGitCommand(executor, directory, args, { allowFailure: true });
  if (result.success) return true;
  if (result.exitCode === 1) return false;
  throw gitError("Could not compare base branch histories", result, args);
}

async function fastForwardLocalBase(
  executor: CommandExecutor, directory: string, localRef: string, upstreamCommit: string,
): Promise<string | undefined> {
  const branch = localRef.slice("refs/heads/".length);
  const localCommit = await readBaseCommit(executor, directory, localRef);
  if (localCommit === upstreamCommit) return;
  if (!await isAncestor(executor, directory, localCommit, upstreamCommit)) {
    return await isAncestor(executor, directory, upstreamCommit, localCommit)
      ? undefined
      : `"${branch}" has diverged from its upstream.`;
  }
  const git = GitService.withExecutor(executor);
  const worktrees = (await git.listWorktrees(directory)).filter((tree) => tree.branch === branch);
  if (worktrees.some((tree) => !executionPathsEqual(tree.path, directory, executor.pathStyle))) {
    return `"${branch}" is checked out in another worktree.`;
  }
  if (worktrees.length) {
    const status = await runGitCommand(executor, directory, ["status", "--porcelain", "--untracked-files=normal"]);
    if (!status.success) return `Could not verify whether "${branch}" is clean.`;
    if (status.stdout.trim()) return `"${branch}" has uncommitted changes.`;
    const head = await runGitCommand(executor, directory, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true });
    if (!head.success || head.stdout.trim() !== localRef) return `The active branch changed while checking "${branch}".`;
    const merge = await runGitCommand(executor, directory,
      ["merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", upstreamCommit], { allowFailure: true });
    if (!merge.success) return `Git could not fast-forward "${branch}" in the original checkout.`;
  } else {
    // Let Git refuse non-fast-forwards and branches that become checked out, without touching any checkout.
    const fetch = await runGitCommand(executor, directory, [
      "fetch", "--no-tags", "--no-prune", "--no-write-fetch-head", "--no-recurse-submodules",
      "--", ".", `${upstreamCommit}:${localRef}`,
    ], { allowFailure: true });
    if (!fetch.success) return `Git could not fast-forward "${branch}" without touching a checkout.`;
  }
}

async function readRemoteDefaultBranch(executor: CommandExecutor, directory: string, remote: string): Promise<string> {
  const result = await runGitCommand(executor, directory, ["ls-remote", "--symref", "--", remote, "HEAD"]);
  const branch = result.stdout.match(/^ref: refs\/heads\/([^\t\r\n]+)\tHEAD$/m)?.[1];
  if (!result.success || !branch) throw failure("The remote default branch could not be determined.");
  return branch;
}

export async function resolveRepositoryDefaultBranch(
  executor: CommandExecutor, directory: string, refresh = false,
): Promise<{ branch: string; remote?: string }> {
  const { defaultRef, defaultRemote } = await readBranches(executor, directory);
  if (refresh && defaultRemote) {
    return { branch: await readRemoteDefaultBranch(executor, directory, defaultRemote), remote: defaultRemote };
  }
  if (!defaultRef) throw failure("The default branch could not be determined.");
  if (defaultRemote) {
    return { branch: defaultRef.slice(`refs/remotes/${defaultRemote}/`.length), remote: defaultRemote };
  }
  return { branch: defaultRef.slice("refs/heads/".length) };
}

export async function listWorkspaceRepositories(executor: CommandExecutor, directory: string): Promise<WorkspaceRepository[]> {
  const { repositories } = await discover(executor, directory);
  const results: WorkspaceRepository[] = [];
  for (const { name, identity, directory } of repositories) {
    try {
      const { refs, defaultRef } = await readBranches(executor, directory);
      results.push({ name, identity, refs, defaultRef });
    } catch (error) {
      throw failure(`Could not read branches for "${name}".`, error);
    }
  }
  return results;
}

export async function bindWorkspaceRepositoryBases(
  executor: CommandExecutor,
  directory: string,
  bases: RepositoryBaseSelection[],
): Promise<RepositoryBaseSelection[]> {
  const repositories = await listWorkspaceRepositories(executor, directory);
  return bases.map((base) => {
    const repository = repositories.find(({ name }) => name === base.repository);
    if (!repository || (base.identity && base.identity !== repository.identity)) {
      throw failure(`Repository "${base.repository}" changed or no longer exists.`);
    }
    if (!repository.refs.includes(base.ref)) {
      throw failure(`Base branch "${base.ref}" does not exist in "${base.repository}".`);
    }
    return { ...base, identity: repository.identity };
  });
}

export async function resolveWorkspaceRepository(executor: CommandExecutor, directory: string, name: string): Promise<string> {
  const { repositories } = await discover(executor, directory);
  const repository = repositories.find((entry) => entry.name === name);
  if (!repository) throw failure(`Repository "${name}" is not available in this workspace.`);
  return repository.directory;
}

export async function planRepositoryGroup(
  executor: CommandExecutor,
  directory: string,
  chatId: string,
  options: { bases?: RepositoryBaseSelection[]; defaults?: RepositoryBaseSelection[]; refresh: boolean },
): Promise<ChatWorktreeGroup> {
  const { root, repositories } = await discover(executor, directory);
  for (const base of options.bases ?? []) {
    if (!repositories.some((repo) => repo.name === base.repository && (!base.identity || repo.identity === base.identity))) {
      throw failure(`Repository "${base.repository}" changed or no longer exists. Review the selected bases.`);
    }
  }
  const group: ChatWorktreeGroup = {
    ownerChatId: chatId,
    sourceDirectory: root,
    sourceIdentity: await directoryIdentity(executor, root, root),
    branch: `chat-${chatId}`,
    repositories: [],
  };
  for (const repository of repositories) {
    try {
      let branches = await readBranches(executor, repository.directory);
      const selected = options.bases?.find((base) => base.repository === repository.name)
        ?? options.defaults?.find((base) => base.repository === repository.name && base.identity === repository.identity);
      let baseRef = selected?.ref ?? branches.defaultRef;
      if (options.refresh && !selected && branches.defaultRemote) {
        const remote = branches.defaultRemote;
        const branch = await readRemoteDefaultBranch(executor, repository.directory, remote);
        baseRef = `refs/remotes/${remote}/${branch}`;
      }
      if (!baseRef) throw failure("The default branch could not be determined. Choose a base branch.");
      const remoteBase = baseRef.startsWith("refs/remotes/");
      const localUpstream = branches.upstreams.get(baseRef);
      const remote = remoteBase
        ? branches.remotes.toSorted((a, b) => b.length - a.length).find((name) => baseRef.startsWith(`refs/remotes/${name}/`))
        : localUpstream?.remote;
      const upstream = remoteBase && remote
        ? { ref: baseRef, remoteRef: `refs/heads/${baseRef.slice(`refs/remotes/${remote}/`.length)}` }
        : localUpstream;
      let baseSyncWarning: string | undefined;
      let refreshed = false;
      if (options.refresh) {
        if (remoteBase && !remote) throw failure("The selected remote is no longer configured.");
        if (remote && upstream) {
          // Ignore configured ref mappings so only the selected remote-tracking ref can move here.
          const fetch = await runGitCommand(executor, repository.directory, [
            "fetch", "--no-tags", "--no-prune", "--no-recurse-submodules", "--refmap=",
            "--", remote, `+${upstream.remoteRef}:${upstream.ref}`,
          ], { allowFailure: !remoteBase });
          if (!fetch.success) {
            if (remoteBase) throw failure(`Could not refresh branches from "${remote}".`);
            baseSyncWarning = `Could not refresh the upstream for "${baseRef.slice("refs/heads/".length)}".`;
          } else {
            refreshed = true;
            branches = await readBranches(executor, repository.directory);
          }
        }
      }
      if (!branches.refs.includes(baseRef)) throw failure(`Base branch "${baseRef}" does not exist.`);
      let baseCommit = await readBaseCommit(executor, repository.directory, baseRef);
      if (refreshed) {
        if (remoteBase && remote) {
          const matching = [...branches.upstreams].filter(([, upstream]) => upstream.ref === baseRef).map(([ref]) => ref);
          const sameName = `refs/heads/${baseRef.slice(`refs/remotes/${remote}/`.length)}`;
          const localRef = matching.includes(sameName) ? sameName : matching.length === 1 ? matching[0] : undefined;
          if (localRef) baseSyncWarning = await fastForwardLocalBase(executor, repository.directory, localRef, baseCommit);
          else if (matching.length > 1) baseSyncWarning = "More than one local branch tracks the selected remote branch.";
          else if (branches.refs.includes(sameName)) baseSyncWarning = `"${sameName.slice("refs/heads/".length)}" does not track the selected remote branch.`;
        } else if (localUpstream) {
          if (branches.refs.includes(localUpstream.ref)) {
            const upstreamCommit = await readBaseCommit(executor, repository.directory, localUpstream.ref);
            baseSyncWarning = await fastForwardLocalBase(executor, repository.directory, baseRef, upstreamCommit);
            baseCommit = await readBaseCommit(executor, repository.directory, baseRef);
          } else baseSyncWarning = `The upstream for "${baseRef.slice("refs/heads/".length)}" no longer exists.`;
        }
      }
      group.repositories.push({ name: repository.name, identity: repository.identity, baseCommit, baseRef, ...(baseSyncWarning ? { baseSyncWarning } : {}) });
    } catch (error) {
      throw failure(`Could not choose a base for "${repository.name}": ${String(error)}`, error);
    }
  }
  return group;
}

export function getRepositoryGroupDirectory(executor: CommandExecutor, group: ChatWorktreeGroup): string {
  return new ManagedPathService(executor.pathStyle).getManagedWorktreePath(group.sourceDirectory, group.ownerChatId);
}

async function assertGroupDirectories(executor: CommandExecutor, group: ChatWorktreeGroup): Promise<boolean> {
  const paths = new ManagedPathService(executor.pathStyle);
  const managed = paths.getManagedWorktreeRoot(group.sourceDirectory);
  const directory = getRepositoryGroupDirectory(executor, group);
  const [sourceInfo, managedInfo, directoryInfo] = await Promise.all([group.sourceDirectory, managed, directory].map(
    (path) => executor.getFileMetadata(path, { includeContentHash: false }),
  ));
  if ([sourceInfo, managedInfo, directoryInfo].some((info) => info && (info.kind !== "directory" || info.isSymbolicLink))) {
    throw failure("The managed repository group directory is not a real directory.");
  }
  if (!sourceInfo || await directoryIdentity(executor, group.sourceDirectory, group.sourceDirectory) !== group.sourceIdentity) {
    throw failure("The source workspace directory was removed or replaced.");
  }
  return directoryInfo !== null;
}

async function validateSource(executor: CommandExecutor, group: ChatWorktreeGroup, repo: ChatRepositoryWorktree) {
  const source = child(executor, group.sourceDirectory, repo.name);
  const info = await executor.getFileMetadata(source, { includeContentHash: false });
  if (!info || info.kind !== "directory" || info.isSymbolicLink) {
    throw failure(`Source repository "${repo.name}" is no longer available.`);
  }
  const root = await gitRoot(executor, source);
  if (!root || !executionPathsEqual(source, root, executor.pathStyle) || await repositoryIdentity(executor, source) !== repo.identity) {
    throw failure(`Source repository "${repo.name}" was removed or replaced.`);
  }
  return { source, path: child(executor, getRepositoryGroupDirectory(executor, group), repo.name) };
}

export async function requireRepositoryGroupDirectory(
  executor: CommandExecutor,
  group: ChatWorktreeGroup,
  recorded: string | undefined,
): Promise<string> {
  const directory = getRepositoryGroupDirectory(executor, group);
  if (recorded !== directory || !await assertGroupDirectories(executor, group)) {
    throw failure("The chat's repository group directory is not ready or no longer exists.");
  }
  return directory;
}

export async function requireGroupRepository(
  executor: CommandExecutor,
  group: ChatWorktreeGroup,
  repo: ChatRepositoryWorktree,
  expectedBranch?: string,
): Promise<string> {
  const { source, path } = await validateSource(executor, group, repo);
  const info = await executor.getFileMetadata(path, { includeContentHash: false });
  const trees = await GitService.withExecutor(executor).listWorktrees(source);
  const entry = trees.find((tree) => executionPathsEqual(tree.path, path, executor.pathStyle));
  const root = info?.kind === "directory" && !info.isSymbolicLink ? await gitRoot(executor, path) : null;
  if (!entry || !root || !executionPathsEqual(root, path, executor.pathStyle)
    || await repositoryIdentity(executor, path) !== repo.identity
    || (expectedBranch && entry.branch !== expectedBranch)) {
    throw failure(`The worktree for "${repo.name}" is missing or is no longer on the expected branch.`);
  }
  return path;
}

export async function cleanRepositoryGroup(executor: CommandExecutor, group: ChatWorktreeGroup): Promise<void> {
  const directoryExists = await assertGroupDirectories(executor, group);
  const git = GitService.withExecutor(executor);
  const errors: string[] = [];
  for (const repo of group.repositories) {
    try {
      const { source, path } = await validateSource(executor, group, repo);
      const entries = await git.listWorktrees(source);
      const registered = entries.some((tree) => executionPathsEqual(tree.path, path, executor.pathStyle));
      const info = await executor.getFileMetadata(path, { includeContentHash: false });
      if (info) {
        const root = info.kind === "directory" && !info.isSymbolicLink ? await gitRoot(executor, path) : null;
        if (!registered || !root || !executionPathsEqual(root, path, executor.pathStyle)
          || await repositoryIdentity(executor, path) !== repo.identity) {
          throw failure(`The worktree path for "${repo.name}" is no longer owned by this chat.`);
        }
      }
      if (registered) {
        const args = ["worktree", "remove", path, "--force"];
        const result = await runGitCommand(executor, source, args, { scope: "managedWorktrees" });
        if (!result.success) throw failure(`Could not remove the managed worktree for "${repo.name}".`);
      }
    } catch (error) {
      errors.push(`${repo.name}: ${String(error)}`);
    }
  }
  if (errors.length) throw failure(`Repository group cleanup needs attention: ${errors.join("; ")}`);
  if (directoryExists && !await executor.deletePath(getRepositoryGroupDirectory(executor, group), { kind: "directory", recursive: true })) {
    throw failure("Could not remove the chat's repository group directory.");
  }
}

export async function prepareRepositoryGroup(
  executor: CommandExecutor,
  group: ChatWorktreeGroup,
  signal?: AbortSignal,
): Promise<string> {
  const directory = getRepositoryGroupDirectory(executor, group);
  const managed = new ManagedPathService(executor.pathStyle).getManagedWorktreeRoot(group.sourceDirectory);
  const run = async (command: string, args: string[], message: string) => {
    if (!(await executor.exec(command, args, { cwd: group.sourceDirectory, signal, logFailures: false })).success) {
      throw failure(message);
    }
  };
  if (await assertGroupDirectories(executor, group)) await cleanRepositoryGroup(executor, group);
  signal?.throwIfAborted();
  await run("mkdir", ["-p", "-m", "700", "--", managed], "Could not create the managed worktrees directory.");
  await assertGroupDirectories(executor, group);
  await run("mkdir", ["-m", "700", "--", directory], "Could not create the private chat directory.");
  try {
    const files = await executor.listDirectoryEntries(group.sourceDirectory, { includeHidden: true, signal });
    for (const file of files) {
      signal?.throwIfAborted();
      if (file.kind !== "file") continue;
      const from = child(executor, group.sourceDirectory, file.name);
      const to = child(executor, directory, file.name);
      await run("test", ["-f", from], `Root file "${file.name}" is not readable as a regular file.`);
      await run("cp", ["-pL", "--", from, to], `Could not copy root file "${file.name}".`);
    }
    for (const repo of group.repositories) {
      signal?.throwIfAborted();
      const { source, path } = await validateSource(executor, group, repo);
      const git = GitService.withExecutor(executor);
      const existing = await git.branchExists(source, `refs/heads/${group.branch}`);
      if (existing) {
        const tip = await runGitCommand(executor, source, ["rev-parse", "--verify", `refs/heads/${group.branch}`]);
        if (!tip.success || tip.stdout.trim() !== repo.baseCommit) throw failure(`The chat branch for "${repo.name}" already exists.`);
      }
      const args = existing
        ? ["worktree", "add", path, group.branch]
        : ["worktree", "add", path, "-b", group.branch, repo.baseCommit];
      const result = await runGitCommand(executor, source, args, { scope: "managedWorktrees" });
      if (!result.success) throw gitError(`Could not create the worktree for "${repo.name}"`, result, args);
    }
    signal?.throwIfAborted();
    return directory;
  } catch (error) {
    try {
      await cleanRepositoryGroup(executor, group);
    } catch (cleanupError) {
      throw failure(`${String(error)} Cleanup remains pending: ${String(cleanupError)}`, cleanupError);
    }
    throw error;
  }
}
