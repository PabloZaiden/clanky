import { expect, test } from "bun:test";
import { join } from "node:path";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import { pollUntil } from "./support/polling";
import { requireCommand } from "./support/process";

interface ExecutionHost {
  ref: Record<string, string>;
}

interface Workspace {
  id: string;
}

interface Model {
  connected: boolean;
  modelID: string;
  providerID: string;
}

interface Chat {
  config: {
    id: string;
  };
  state: {
    error?: { message: string };
    status: string;
    worktree?: {
      workingBranch: string;
      worktreePath?: string;
    };
  };
}

async function git(directory: string, args: string[]): Promise<string> {
  return (await requireCommand(["git", ...args], { cwd: directory })).stdout.trim();
}

async function waitForChatWorktree(
  application: E2EApplication,
  chatId: string,
): Promise<Chat> {
  return await pollUntil(
    async () => (await application.json<Chat>(`/api/chats/${chatId}`)).data,
    (chat) => Boolean(chat.state.worktree?.worktreePath) || chat.state.status === "failed",
    {
      description: `chat ${chatId} worktree preparation`,
      timeoutMs: 10_000,
      formatLastObserved: (chat) => JSON.stringify({
        status: chat.state.status,
        error: chat.state.error,
        worktree: chat.state.worktree,
      }),
    },
  );
}

async function createWorktreeChat(
  application: E2EApplication,
  workspaceId: string,
  model: { providerID: string; modelID: string; variant: string },
  options: {
    name: string;
    baseBranch: string;
    useSelectedBranchForWorktree?: boolean;
  },
): Promise<Chat> {
  const chat = (await application.json<Chat>(
    "/api/chats",
    {
      method: "POST",
      body: JSON.stringify({
        name: options.name,
        workspaceId,
        model,
        useWorktree: true,
        ...(options.useSelectedBranchForWorktree
          ? { useSelectedBranchForWorktree: true }
          : {}),
        autoApprovePermissions: true,
        baseBranch: options.baseBranch,
      }),
    },
    201,
  )).data;
  return await waitForChatWorktree(application, chat.config.id);
}

async function assertWorktreeUsesBranch(
  worktreePath: string,
  branchName: string,
): Promise<void> {
  expect(await git(worktreePath, ["symbolic-ref", "--short", "HEAD"])).toBe(branchName);
}

async function waitForManagedWorktreesRemoved(
  repositoryDirectory: string,
  worktreePaths: string[],
): Promise<void> {
  await pollUntil(
    async () => await git(repositoryDirectory, ["worktree", "list", "--porcelain"]),
    (listing) => worktreePaths.every((worktreePath) => !listing.includes(`worktree ${worktreePath}`)),
    {
      description: "deleted chats' managed worktrees to be removed",
      timeoutMs: 10_000,
      formatLastObserved: (listing) => listing,
    },
  );
}

test("users can create chats on the selected branch in shared worktrees", async () => {
  const application = await E2EApplication.create();
  try {
    const fixture = await createGitFixture(application.runDirectory);
    const selectedBranch = "shared-feature";
    await git(fixture.repositoryDirectory, ["checkout", "-b", selectedBranch]);
    await Bun.write(join(fixture.repositoryDirectory, "feature.txt"), "shared branch\n");
    await git(fixture.repositoryDirectory, ["add", "feature.txt"]);
    await git(fixture.repositoryDirectory, ["commit", "-m", "Create shared feature branch"]);
    await git(fixture.repositoryDirectory, ["push", "--set-upstream", "origin", selectedBranch]);
    await git(fixture.repositoryDirectory, ["checkout", fixture.branch]);
    await git(fixture.repositoryDirectory, ["branch", "-D", selectedBranch]);
    await git(fixture.repositoryDirectory, ["fetch", "origin", selectedBranch]);
    expect(await git(
      fixture.repositoryDirectory,
      ["for-each-ref", "--format=%(refname:short)", `refs/heads/${selectedBranch}`],
    )).toBe("");
    expect(await git(
      fixture.repositoryDirectory,
      ["for-each-ref", "--format=%(refname:short)", `refs/remotes/origin/${selectedBranch}`],
    )).toBe(`origin/${selectedBranch}`);

    await application.start();
    const hosts = (await application.json<ExecutionHost[]>("/api/execution-hosts")).data;
    const localHost = hosts.find((host) => host.ref["kind"] === "local");
    expect(localHost).toBeDefined();
    const workspace = (await application.json<Workspace>(
      "/api/workspaces",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Shared chat worktree",
          directory: fixture.repositoryDirectory,
          executionHost: localHost!.ref,
          serverSettings: {
            agent: {
              adapter: "acp",
              provider: "copilot",
            },
          },
        }),
      },
      201,
    )).data;
    const models = (await application.json<Model[]>(
      `/api/models?workspaceId=${encodeURIComponent(workspace.id)}`,
    )).data;
    const availableModel = models.find((model) => model.providerID === "copilot" && model.connected);
    expect(availableModel).toBeDefined();
    const model = {
      providerID: availableModel!.providerID,
      modelID: availableModel!.modelID,
      variant: "",
    };

    const defaultChat = await createWorktreeChat(
      application,
      workspace.id,
      model,
      { name: "Default branch behavior", baseBranch: fixture.branch },
    );
    const defaultWorktree = defaultChat.state.worktree;
    expect(defaultWorktree?.worktreePath).toBeDefined();
    expect(defaultWorktree?.workingBranch).not.toBe(fixture.branch);
    await assertWorktreeUsesBranch(defaultWorktree!.worktreePath!, defaultWorktree!.workingBranch);
    await application.json(`/api/chats/${defaultChat.config.id}`, { method: "DELETE" });
    await waitForManagedWorktreesRemoved(
      fixture.repositoryDirectory,
      [defaultWorktree!.worktreePath!],
    );

    const firstChat = await createWorktreeChat(
      application,
      workspace.id,
      model,
      {
        name: "First shared branch chat",
        baseBranch: `origin/${selectedBranch}`,
        useSelectedBranchForWorktree: true,
      },
    );
    const firstWorktree = firstChat.state.worktree;
    expect(firstWorktree?.worktreePath).toBeDefined();
    expect(firstWorktree?.workingBranch).toBe(selectedBranch);
    await assertWorktreeUsesBranch(firstWorktree!.worktreePath!, selectedBranch);
    expect(await git(
      firstWorktree!.worktreePath!,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    )).toBe(`origin/${selectedBranch}`);

    const secondChat = await createWorktreeChat(
      application,
      workspace.id,
      model,
      {
        name: "Second shared branch chat",
        baseBranch: `origin/${selectedBranch}`,
        useSelectedBranchForWorktree: true,
      },
    );
    const secondWorktree = secondChat.state.worktree;
    expect(secondWorktree?.worktreePath).toBeDefined();
    expect(secondWorktree?.worktreePath).not.toBe(firstWorktree?.worktreePath);
    expect(secondWorktree?.workingBranch).toBe(selectedBranch);
    await assertWorktreeUsesBranch(secondWorktree!.worktreePath!, selectedBranch);
    const worktrees = await git(fixture.repositoryDirectory, ["worktree", "list", "--porcelain"]);
    expect(worktrees.split(/\r?\n/).filter(
      (line) => line === `branch refs/heads/${selectedBranch}`,
    )).toHaveLength(2);

    await application.json(`/api/chats/${firstChat.config.id}`, { method: "DELETE" });
    await application.json(`/api/chats/${secondChat.config.id}`, { method: "DELETE" });
    await waitForManagedWorktreesRemoved(
      fixture.repositoryDirectory,
      [firstWorktree!.worktreePath!, secondWorktree!.worktreePath!],
    );
    expect(await git(
      fixture.repositoryDirectory,
      ["for-each-ref", "--format=%(refname:short)", `refs/heads/${selectedBranch}`],
    )).toBe(selectedBranch);
  } catch (error) {
    const diagnostics = await application.diagnostics();
    if (diagnostics.length > 0) {
      console.error(diagnostics);
    }
    throw error;
  } finally {
    await application.cleanup();
  }
});
