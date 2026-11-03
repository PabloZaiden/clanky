import { expect, test } from "bun:test";
import { E2EApplication } from "./support/application";
import { createGitFixture, gitStatus, readGitBranchFile } from "./support/git";
import { runProductionHttpSmoke } from "./support/http-smoke";
import { pollUntil } from "./support/polling";

interface Task {
  config: { id: string };
  state: {
    status: string;
    planMode: { isPlanReady: boolean };
    git?: { workingBranch: string; commits: Array<{ sha: string }> };
  };
}

interface Chat {
  config: { id: string };
  state: { status: string };
}

test("users create a workspace, chat, approve a task and accept its Git result", async () => {
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
    expect((await application.cli(["api"])).stdout).toContain("tasks");

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

    const task = (await application.json<Task>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        name: "Implement a project change", workspaceId: workspace.id,
        prompt: "[provider-write] Create the requested fixture change",
        attachments: [], model, cheapModel: { mode: "same-as-task" },
        maxIterations: 2, maxConsecutiveErrors: 2, activityTimeoutSeconds: null,
        stopPattern: "<promise>COMPLETE</promise>",
        git: { branchPrefix: "e2e/", commitScope: "" },
        baseBranch: git.branch, useWorktree: true, clearPlanningFolder: true,
        autoAcceptPlan: false, fullyAutonomous: false, draft: false,
      }),
    }, 201)).data;
    const readTask = async () => (await application.json<Task>(`/api/tasks/${task.config.id}`)).data;
    const planned = await pollUntil(readTask,
      (value) => value.state.planMode.isPlanReady || value.state.status === "failed",
      { description: "task plan awaiting approval", timeoutMs: 10_000, formatLastObserved: JSON.stringify });
    expect(planned.state.status).toBe("planning");
    expect((await application.json<{ content: string }>(`/api/tasks/${task.config.id}/plan`)).data.content)
      .toContain("Create the requested fixture change");
    await application.json(`/api/tasks/${task.config.id}/plan/accept`, {
      method: "POST", body: JSON.stringify({ mode: "start_task" }),
    });
    const completed = await pollUntil(readTask,
      (value) => ["completed", "failed", "max_iterations", "stopped"].includes(value.state.status),
      { description: "approved task completion", timeoutMs: 10_000, formatLastObserved: JSON.stringify });
    expect(completed.state.status).toBe("completed");
    expect(completed.state.git?.commits.length).toBeGreaterThan(0);
    await application.json(`/api/tasks/${task.config.id}/accept`, { method: "POST", body: "{}" });
    const accepted = await readTask();
    expect(accepted.state.status).toBe("accepted_local");
    if (!accepted.state.git) throw new Error("Accepted task did not retain its Git result");
    expect(await readGitBranchFile(git, accepted.state.git.workingBranch, "e2e-provider-change.txt"))
      .toBe("created by the external ACP provider");
    expect(await gitStatus(git)).toBe("");
  } catch (error) {
    console.error(await application.diagnostics());
    throw error;
  } finally {
    await application.cleanup();
  }
});
