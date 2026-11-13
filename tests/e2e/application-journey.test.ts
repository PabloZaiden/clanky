import { expect, test } from "bun:test";
import { E2EApplication } from "./support/application";
import { createGitFixture, gitStatus, readGitBranchFile } from "./support/git";
import { runProductionHttpSmoke } from "./support/http-smoke";
import { pollUntil } from "./support/polling";

interface Chat {
  config: { id: string };
  state: { status: string; worktree?: { workingBranch: string } };
}

test("users discuss a project, iterate on a plan and implement it in one chat", async () => {
  const application = await E2EApplication.create();
  try {
    const git = await createGitFixture(application.runDirectory);
    await application.start();
    await runProductionHttpSmoke({
      baseUrl: application.baseUrl,
      ensureProcessRunning() {
        if (!application.isRunning) throw new Error("Compiled Clanky exited during HTTP smoke");
      },
    });
    expect((await application.cli(["api"])).stdout).toContain("chats");

    const hosts = (await application.json<Array<{ ref: Record<string, string> }>>("/api/execution-hosts")).data;
    const host = hosts.find((entry) => entry.ref["kind"] === "local");
    if (!host) throw new Error("Local execution host unavailable");
    const workspace = (await application.json<{ id: string }>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({
        name: "Everyday project",
        directory: git.repositoryDirectory,
        executionHost: host.ref,
        allowClankyContext: false,
        serverSettings: { agent: { adapter: "acp", provider: "copilot" } },
      }),
    }, 201)).data;
    const models = (await application.json<Array<{
      providerID: string; modelID: string; connected: boolean;
    }>>(`/api/models?workspaceId=${workspace.id}`)).data;
    const connected = models.find((entry) => entry.connected && entry.providerID === "copilot");
    if (!connected) throw new Error("Deterministic ACP model unavailable");
    const model = { providerID: connected.providerID, modelID: connected.modelID, variant: "" };

    const chat = (await application.json<Chat>("/api/chats", {
      method: "POST",
      body: JSON.stringify({
        name: "Project discussion", workspaceId: workspace.id, model,
        useWorktree: false, baseBranch: git.branch,
      }),
    }, 201)).data;
    await application.json(`/api/chats/${chat.config.id}/messages`, {
      method: "POST", body: JSON.stringify({ message: "Explain this project." }),
    });
    const idle = await pollUntil(
      async () => (await application.json<Chat>(`/api/chats/${chat.config.id}`)).data,
      (value) => ["idle", "failed"].includes(value.state.status),
      { description: "ordinary chat response", timeoutMs: 10_000, formatLastObserved: JSON.stringify },
    );
    expect(idle.state.status).toBe("idle");
    const snapshot = (await application.json<{
      transcript: { messages: Array<{ role: string; content: string }> };
    }>(`/api/chats/${chat.config.id}/snapshot?full=1`)).data;
    expect(snapshot.transcript.messages.some((message) =>
      message.role === "assistant" && message.content.trim().length > 0)).toBe(true);

    const plannedChat = (await application.json<Chat>("/api/chats", {
      method: "POST",
      body: JSON.stringify({
        name: "Implement a project change", workspaceId: workspace.id, model,
        baseBranch: git.branch, useWorktree: true, startWithPlan: true,
      }),
    }, 201)).data;
    const path = `/api/chats/${plannedChat.config.id}`;
    await pollUntil(
      async () => (await application.json<Chat>(path)).data,
      (value) => !!value.state.worktree || value.state.status === "failed",
      { description: "chat working directory", timeoutMs: 10_000, formatLastObserved: JSON.stringify },
    );
    const document = async (name: string) =>
      (await application.json<{ exists: boolean; content: string }>(`${path}/${name}`)).data;
    expect((await document("plan")).exists).toBe(false);
    const send = async (message: string): Promise<Chat> => {
      await application.json(`${path}/messages`, { method: "POST", body: JSON.stringify({ message }) });
      return await pollUntil(
        async () => (await application.json<Chat>(path)).data,
        (value) => ["idle", "failed"].includes(value.state.status),
        { description: "planning conversation response", timeoutMs: 10_000, formatLastObserved: JSON.stringify },
      );
    };
    const requirements = "[plan-first] Create the requested fixture change.";
    expect((await send(requirements)).state.status).toBe("idle");
    expect((await document("plan")).content)
      .toContain("Create the requested fixture change");
    expect((await document("status-file")).content).toContain("Waiting for implementation");
    const planningSnapshot = (await application.json<{
      transcript: { messages: Array<{ role: string; content: string }> };
    }>(`${path}/snapshot?full=1`)).data;
    expect(planningSnapshot.transcript.messages.find((message) => message.role === "user")?.content)
      .toBe(requirements);
    expect((await send("Why this approach?")).state.status).toBe("idle");
    expect((await send("[revise-plan] Include documentation.")).state.status).toBe("idle");
    expect((await document("plan")).content).toContain("Include documentation");
    const implemented = await send("[provider-write] Implement the revised plan now.");
    expect(implemented.state.status).toBe("idle");
    const changes = await application.json<Array<{ path: string; patch?: string }>>(`${path}/diff`);
    const diff = changes.data;
    expect(diff.map((file) => file.path).sort())
      .toEqual(["README.md", "e2e-committed-change.txt", "e2e-provider-change.txt"]);
    expect(diff.every((file) => file.patch === undefined)).toBe(true);
    const base = changes.headers.get("X-Clanky-Diff-Base");
    if (!base) throw new Error("Chat Diff did not identify its comparison base");
    const selectedFile = (await application.json<{ patch: string }>(
      `${path}/diff/file?${new URLSearchParams({ base, path: "e2e-provider-change.txt" })}`,
    )).data;
    expect(selectedFile.patch)
      .toContain("+created by the external ACP provider");
    const repository = (await application.json<{
      branch: string | null; pullRequestLookup: string;
    }>(`${path}/repository-context`)).data;
    expect(repository.branch).toBe(implemented.state.worktree?.workingBranch ?? null);
    if (!repository.branch) throw new Error("Chat did not retain its working branch");
    expect(await readGitBranchFile(git, repository.branch, "e2e-committed-change.txt"))
      .toBe("committed implementation");
    expect((await document("status-file")).content).toContain("Implementation complete");
    expect(await gitStatus(git)).toBe("");
  } catch (error) {
    console.error(await application.diagnostics());
    throw error;
  } finally {
    await application.cleanup();
  }
});
