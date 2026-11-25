import { expect, test } from "bun:test";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { E2EApplication } from "./support/application";
import { pollUntil } from "./support/polling";
import { requireCommand } from "./support/process";

interface Chat {
  config: { id: string };
  state: {
    status: string;
    error?: { message: string };
    worktree?: { worktreePath?: string; group?: { branch: string; repositories: Array<{
      name: string; baseRef: string; baseCommit: string; baseSyncWarning?: string;
    }> } };
  };
}

test("a workspace discovers new repositories and gives each chat its own repository group", async () => {
  const app = await E2EApplication.create();
  try {
    const root = join(app.runDirectory, "group");
    await mkdir(root);
    await app.start();
    const host = (await app.json<Array<{ ref: { kind: string } }>>("/api/execution-hosts"))
      .data.find(({ ref }) => ref.kind === "local")?.ref;
    if (!host) throw new Error("Local execution host unavailable");
    const workspace = (await app.json<{ id: string }>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({
        name: "Repository group", directory: root, executionHost: host, workspaceType: "multi-git",
        serverSettings: { agent: { adapter: "copilot", provider: "copilot" } },
      }),
    }, 201)).data;
    const readRepositories = async () => (await app.json<Array<{ name: string; defaultRef: string | null }>>(
      `/api/git/repositories?workspaceId=${workspace.id}`,
    )).data;
    expect(await readRepositories()).toEqual([]);

    const git = async (directory: string, ...args: string[]) =>
      (await requireCommand(["git", "-C", directory, ...args], { cwd: root })).stdout.trim();
    async function addRepository(name: string, branch: string) {
      const source = join(app.runDirectory, `source-${name}`);
      await mkdir(source);
      await git(source, "init", "-b", branch);
      await writeFile(join(source, "readme"), name);
      await git(source, "add", "readme");
      await git(source, "-c", "user.name=Clanky E2E", "-c", "user.email=e2e@clanky.test", "commit", "-m", "Create repository");
      const directory = join(root, name);
      await git(root, "clone", "--", source, directory);
      return directory;
    }
    async function commitFile(directory: string, file: string) {
      await writeFile(join(directory, file), file);
      await git(directory, "add", "--", file);
      await git(directory, "-c", "user.name=Clanky E2E", "-c", "user.email=e2e@clanky.test", "commit", "-m", file);
      return await git(directory, "rev-parse", "HEAD");
    }
    const first = await addRepository("first", "main");
    const second = await addRepository("second", "trunk");
    await git(second, "branch", "feature");
    await writeFile(join(root, ".settings"), "workspace copy", { mode: 0o600 });
    const repositories = await readRepositories();
    expect(repositories.map(({ name, defaultRef }) => ({ name, defaultRef }))).toEqual([
      { name: "first", defaultRef: "refs/remotes/origin/main" }, { name: "second", defaultRef: "refs/remotes/origin/trunk" },
    ]);

    const model = (await app.json<Array<{ providerID: string; modelID: string; connected: boolean }>>(
      `/api/models?workspaceId=${workspace.id}`,
    )).data.find(({ connected }) => connected);
    if (!model) throw new Error("No fixture model available");
    const request = {
      workspaceId: workspace.id, useWorktree: true,
      repositoryBases: [{ repository: "second", ref: "refs/heads/feature" }],
      model: { providerID: model.providerID, modelID: model.modelID, variant: "" },
    };
    const saveBases = await app.json<{ repositoryBases: Array<{ identity: string }> }>(`/api/workspaces/${workspace.id}`, {
      method: "PUT",
      body: JSON.stringify({ repositoryBases: [{ repository: "first", ref: "refs/remotes/origin/main" }] }),
    });
    expect(saveBases.data.repositoryBases[0]?.identity).toBeTruthy();
    const hook = join(second, ".git", "hooks", "post-checkout");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const failed = (await app.json<Chat>("/api/chats", {
      method: "POST",
      body: JSON.stringify(request),
    }, 201)).data;
    const failure = await pollUntil(async () => (await app.json<Chat>(`/api/chats/${failed.config.id}`)).data,
      (entry) => entry.state.status === "failed", {
        description: "failed group preparation to finish", timeoutMs: 10_000, formatLastObserved: JSON.stringify,
      });
    expect(failure.state.error?.message).toContain("second");
    expect(failure.state.worktree?.worktreePath).toBeUndefined();
    for (const repo of [first, second]) expect(await git(repo, "worktree", "list")).not.toContain(failed.config.id);
    await app.json(`/api/chats/${failed.config.id}`, { method: "DELETE" });
    await app.json(`/api/trash/${failed.config.id}`, { method: "DELETE" });
    await unlink(hook);

    const updatedMain = await commitFile(join(app.runDirectory, "source-first"), "remote-update");
    const chat = (await app.json<Chat>("/api/chats", {
      method: "POST", body: JSON.stringify(request),
    }, 201)).data;
    const path = `/api/chats/${chat.config.id}`;
    const prepared = await pollUntil(async () => (await app.json<Chat>(path)).data,
      (entry) => Boolean(entry.state.worktree?.worktreePath) || entry.state.status === "failed", {
        description: "repository group to be prepared", timeoutMs: 10_000, formatLastObserved: JSON.stringify,
      });
    const worktree = prepared.state.worktree?.worktreePath;
    const group = prepared.state.worktree?.group;
    if (!worktree || !group) throw new Error(prepared.state.error?.message ?? "Missing repository group");
    expect(group.repositories.map(({ baseRef }) => baseRef)).toEqual(["refs/remotes/origin/main", "refs/heads/feature"]);
    expect(await git(first, "rev-parse", "HEAD")).toBe(updatedMain);
    expect(await git(first, "branch", "--show-current")).toBe("main");
    expect(await readFile(join(first, "remote-update"), "utf8")).toBe("remote-update");
    expect(await git(join(worktree, "first"), "branch", "--show-current")).toBe(group.branch);
    expect(await readFile(join(worktree, ".settings"), "utf8")).toBe("workspace copy");
    expect((await stat(join(worktree, ".settings"))).mode & 0o777).toBe(0o600);
    await writeFile(join(worktree, ".settings"), "chat copy");
    await writeFile(join(worktree, "second", "readme"), "changed");
    expect(await readFile(join(root, ".settings"), "utf8")).toBe("workspace copy");
    expect(await git(second, "branch", "--show-current")).toBe("trunk");
    const changes = (await app.json<Array<{ path: string }>>(`${path}/diff?repository=second`)).data;
    expect(changes.map(({ path }) => path)).toEqual(["readme"]);
    expect((await app.json(`${path}/diff?repository=first`)).data).toEqual([]);
    await app.json(`${path}/diff`, {}, 409);
    const third = await addRepository("third", "main");
    expect((await readRepositories()).map(({ name }) => name)).toEqual(["first", "second", "third"]);
    expect((await app.json<Chat>(path)).data.state.worktree?.group?.repositories).toHaveLength(2);
    const shared = (await app.json<Chat>(`${path}/new-here`, { method: "POST" }, 201)).data;
    expect(shared.state.worktree?.worktreePath).toBe(worktree);
    await app.json(`/api/workspaces/${workspace.id}`, { method: "DELETE" }, 409);
    await app.json(path, { method: "DELETE" });
    await app.json(`/api/trash/${chat.config.id}`, { method: "DELETE" }, 409);
    await app.json(`/api/chats/${shared.config.id}`, { method: "DELETE" });
    await app.json(`/api/trash/${shared.config.id}`, { method: "DELETE" });
    expect(await readFile(join(worktree, ".settings"), "utf8")).toBe("chat copy");
    await app.json(`/api/trash/${chat.config.id}/restore`, { method: "POST" });
    expect(await readFile(join(worktree, ".settings"), "utf8")).toBe("chat copy");
    await app.json(path, { method: "DELETE" });
    await app.json(`/api/trash/${chat.config.id}`, { method: "DELETE" });
    expect(await Bun.file(join(worktree, ".settings")).exists()).toBe(false);
    expect(await git(first, "worktree", "list")).not.toContain(chat.config.id);

    const code = `export default async function run(ctx) {
      const read = await ctx.workspace.exec("cat", [".settings", "second/readme"]);
      if (read.exitCode !== 0 || !read.stdout.includes("workspace copysecond")) throw new Error("Missing isolated files");
      const branch = await ctx.workspace.exec("git", ["-C", "second", "branch", "--show-current"]);
      if (branch.exitCode !== 0 || !branch.stdout.startsWith("chat-")) throw new Error("Missing worktree branch");
    }`;
    const testResult = (await app.json<{ status: string; error?: string }>("/api/automations/code/test", {
      method: "POST", body: JSON.stringify({ ...request, code }),
    })).data;
    expect(testResult.status, testResult.error).toBe("completed");
    const automation = (await app.json<{ config: { id: string; repositoryBases: { identity: string }[] } }>("/api/automations", {
      method: "POST",
      body: JSON.stringify({
        ...request, code, name: "Read a group", prompt: "Read the worktree group", enabled: false,
        schedule: { startAtLocal: "2025-01-01T00:00", timezone: "UTC", interval: { value: 1, unit: "days" } },
      }),
    }, 201)).data;
    expect(automation.config.repositoryBases[0]?.identity).toBeTruthy();
    const run = (await app.json<{ id: string }>(`/api/automations/${automation.config.id}/run`, { method: "POST" }, 202)).data;
    const runPath = `/api/automation-runs/${run.id}`;
    const finished = await pollUntil(async () => (await app.json<{ status: string }>(runPath)).data,
      (entry) => ["completed", "failed", "skipped"].includes(entry.status), {
        description: "automation run to complete", timeoutMs: 15_000, formatLastObserved: JSON.stringify,
      });
    expect(finished.status, JSON.stringify(finished)).toBe("completed");
    await app.json(`/api/automations/${automation.config.id}`, { method: "DELETE" });

      await writeFile(join(first, "readme"), "dirty source edit");
      const dirtyRemoteTip = await commitFile(join(app.runDirectory, "source-first"), "remote-while-dirty");
      await git(second, "switch", "feature");
      const inactiveRemoteTip = await commitFile(join(app.runDirectory, "source-second"), "remote-while-inactive");
      await git(third, "switch", "-c", "original-active");
      const thirdCheckout = join(app.runDirectory, "third-other-worktree");
      await git(third, "worktree", "add", thirdCheckout, "main");
      const occupiedTip = await git(thirdCheckout, "rev-parse", "HEAD");
      const occupiedRemoteTip = await commitFile(join(app.runDirectory, "source-third"), "remote-while-occupied");
      async function prepareWithLocalTrunk(quick = false) {
        const { data } = await app.json<Chat>("/api/chats", {
          method: "POST",
          body: JSON.stringify({ ...request, quick, repositoryBases: [{ repository: "second", ref: "refs/heads/trunk" }] }),
        }, 201);
        const route = `/api/chats/${data.config.id}`;
        const ready = await pollUntil(async () => (await app.json<Chat>(route)).data,
          (entry) => Boolean(entry.state.worktree?.worktreePath) || entry.state.status === "failed", {
            description: "chat ready after base synchronization", timeoutMs: 10_000, formatLastObserved: JSON.stringify,
          });
        if (!ready.state.worktree?.worktreePath || !ready.state.worktree.group) {
          throw new Error(ready.state.error?.message ?? "Missing repository group");
        }
        const repositories = ready.state.worktree.group.repositories;
        await app.json(route, { method: "DELETE" });
        await app.json(`/api/trash/${data.config.id}`, { method: "DELETE" });
        return repositories;
      }

      const bases = await prepareWithLocalTrunk();
      expect(await git(first, "rev-parse", "HEAD")).toBe(updatedMain);
      expect(await readFile(join(first, "readme"), "utf8")).toBe("dirty source edit");
      expect(bases[0]).toMatchObject({ name: "first", baseCommit: dirtyRemoteTip, baseSyncWarning: expect.stringContaining("uncommitted changes") });
      expect(await git(second, "rev-parse", "trunk")).toBe(inactiveRemoteTip);
      expect(await git(second, "branch", "--show-current")).toBe("feature");
      expect(await Bun.file(join(second, "remote-while-inactive")).exists()).toBe(false);
      expect(bases[1]).toMatchObject({ name: "second", baseCommit: inactiveRemoteTip });
      expect(bases[1]?.baseSyncWarning).toBeUndefined();
      expect(await git(thirdCheckout, "rev-parse", "HEAD")).toBe(occupiedTip);
      expect(bases[2]).toMatchObject({ name: "third", baseCommit: occupiedRemoteTip, baseSyncWarning: expect.stringContaining("another worktree") });

      await git(first, "restore", "readme");
      const divergentTip = await commitFile(first, "local-only");
      const divergentBases = await prepareWithLocalTrunk();
      expect(await git(first, "rev-parse", "HEAD")).toBe(divergentTip);
      expect(divergentBases[0]).toMatchObject({ baseCommit: dirtyRemoteTip, baseSyncWarning: expect.stringContaining("diverged") });

      await app.json("/api/preferences/quick-chat", {
        method: "PUT", body: JSON.stringify({ workspaceId: workspace.id, useWorktree: true, model: request.model }),
      });
      await commitFile(join(app.runDirectory, "source-second"), "after-last-fetch");
      const quickBases = await prepareWithLocalTrunk(true);
      expect(await git(second, "rev-parse", "trunk")).toBe(inactiveRemoteTip);
      expect(quickBases.every(({ baseSyncWarning }) => baseSyncWarning === undefined)).toBe(true);

    await app.json(`/api/workspaces/${workspace.id}`, { method: "DELETE" });
      expect(await git(second, "branch", "--show-current")).toBe("feature");
  } catch (error) {
    console.error(await app.diagnostics());
    throw error;
  } finally {
    await app.cleanup();
  }
}, 120_000);
