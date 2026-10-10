import { expect, test } from "bun:test";
import { E2EApplication } from "./support/application";
import {
  commitAndPushFile,
  configureGitHubRemote,
  createGitFixture,
  gitStatus,
  readGitBranchFile,
  readRemoteBranchFile,
  restoreLocalRemote,
} from "./support/git";
import { runProductionHttpSmoke } from "./support/http-smoke";
import { pollUntil } from "./support/polling";

interface ExecutionHost {
  ref: Record<string, string>;
}

interface Workspace {
  archived?: boolean;
  id: string;
  name: string;
  scratchpad: string;
}

interface Model {
  providerID: string;
  modelID: string;
  connected: boolean;
}

interface Task {
  config: {
    id: string;
  };
  state: {
    status: string;
    planMode: {
      feedbackRounds: number;
      isPlanReady: boolean;
    };
    git?: {
      workingBranch: string;
      commits: Array<{ sha: string }>;
    };
    currentIteration?: number;
    automaticPrFlow?: {
      activeBatch?: {
        items: Array<{
          id: string;
          source: string;
        }>;
      };
      enabled: boolean;
      handledItems: Array<{
        id: string;
        outcome: string;
        source: string;
      }>;
      pullRequestNumber?: number;
      pullRequestUrl?: string;
      status: string;
    };
    pullRequestMonitoring?: {
      pullRequestNumber?: number;
      pullRequestUrl?: string;
      status: string;
    };
    reviewMode?: {
      reviewCycles: number;
    };
  };
}

interface TaskSnapshot {
  transcript: {
    messages: Array<{
      content: string;
      role: string;
    }>;
  };
}

interface Chat {
  config: {
    id: string;
    name?: string;
    scope?: string;
    taskId?: string;
  };
  state: {
    status: string;
    harness?: {
      questions?: Array<{
        requestId: string;
        status: string;
        answers?: string[][];
      }>;
    };
    pendingPermissionRequests?: Array<{
      requestId: string;
      status: string;
      decision?: string;
    }>;
    queuedMessages?: Array<{
      id: string;
      content: string;
    }>;
  };
}

interface ChatSnapshot {
  transcript: {
    messages: Array<{
      role: string;
      content: string;
    }>;
  };
}

interface JourneyModel {
  modelID: string;
  providerID: string;
  variant: string;
}

interface JourneyTaskOptions {
  application: E2EApplication;
  autoAcceptPlan?: boolean;
  baseBranch: string;
  draft?: boolean;
  fullyAutonomous?: boolean;
  maxIterations?: number;
  model: JourneyModel;
  name: string;
  prompt: string;
  workspaceId: string;
}

interface ApiKey {
  key: {
    id: string;
  };
  token: string;
}

interface Agent {
  config: {
    enabled: boolean;
    id: string;
    name: string;
  };
  state: {
    status: string;
  };
}

interface AgentRun {
  id: string;
  status: string;
  trigger: string;
}

interface AgentRunSnapshot {
  transcript: {
    messages: Array<{
      role: string;
      content: string;
    }>;
  };
}

async function waitForTask(
  application: E2EApplication,
  taskId: string,
  predicate: (task: Task) => boolean,
  description: string,
): Promise<Task> {
  return await pollUntil(
    async () => (await application.json<Task>(`/api/tasks/${taskId}`)).data,
    predicate,
    {
      description,
      timeoutMs: 10_000,
      formatLastObserved: (task) => JSON.stringify({
        status: task.state.status,
        planReady: task.state.planMode.isPlanReady,
      }),
    },
  );
}

async function createJourneyTask(options: JourneyTaskOptions): Promise<Task> {
  return (
    await options.application.json<Task>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        name: options.name,
        prompt: options.prompt,
        attachments: [],
        workspaceId: options.workspaceId,
        baseBranch: options.baseBranch,
        maxIterations: options.maxIterations ?? 2,
        maxConsecutiveErrors: 2,
        activityTimeoutSeconds: null,
        stopPattern: "<promise>COMPLETE</promise>",
        git: {
          branchPrefix: "e2e/",
          commitScope: "",
        },
        useWorktree: true,
        clearPlanningFolder: true,
        autoAcceptPlan: options.autoAcceptPlan ?? false,
        fullyAutonomous: options.fullyAutonomous ?? false,
        draft: options.draft ?? false,
        model: options.model,
        cheapModel: { mode: "same-as-task" },
      }),
    }, 201)
  ).data;
}

async function discardAndPurgeTask(
  application: E2EApplication,
  taskId: string,
  apiKey?: string,
): Promise<void> {
  await application.json(
    `/api/tasks/${taskId}/discard`,
    { method: "POST", body: "{}", apiKey },
  );
  await application.json(
    `/api/tasks/${taskId}/purge`,
    { method: "POST", body: "{}", apiKey },
  );
  expect((await application.request(`/api/tasks/${taskId}`, { apiKey })).status).toBe(404);
}

async function waitForTaskMessage(
  application: E2EApplication,
  taskId: string,
  content: string,
): Promise<void> {
  await pollUntil(
    async () => (
      await application.json<TaskSnapshot>(`/api/tasks/${taskId}/snapshot?full=1`)
    ).data,
    (snapshot) => snapshot.transcript.messages.some(
      (message) => message.role === "user" && message.content === content,
    ),
    {
      description: `task transcript message ${JSON.stringify(content)}`,
      timeoutMs: 10_000,
      formatLastObserved: (snapshot) => JSON.stringify(
        snapshot.transcript.messages.map((message) => ({
          content: message.content,
          role: message.role,
        })),
      ),
    },
  );
}

async function waitForChat(
  application: E2EApplication,
  chatId: string,
  predicate: (chat: Chat) => boolean,
  description: string,
): Promise<Chat> {
  return await pollUntil(
    async () => (await application.json<Chat>(`/api/chats/${chatId}`)).data,
    predicate,
    {
      description,
      timeoutMs: 10_000,
      formatLastObserved: (chat) => JSON.stringify({
        status: chat.state.status,
        permissions: chat.state.pendingPermissionRequests,
        questions: chat.state.harness?.questions,
        queuedMessages: chat.state.queuedMessages,
      }),
    },
  );
}

async function waitForChatIdle(
  application: E2EApplication,
  chatId: string,
): Promise<Chat> {
  return await waitForChat(
    application,
    chatId,
    (chat) => chat.state.status === "idle" || chat.state.status === "failed",
    `chat ${chatId} to settle`,
  );
}

async function waitForAgentRun(
  application: E2EApplication,
  agentId: string,
  predicate: (run: AgentRun) => boolean,
  description: string,
): Promise<AgentRun> {
  return await pollUntil(
    async () => {
      const runs = (await application.json<AgentRun[]>(
        `/api/agents/${agentId}/runs`,
      )).data;
      return runs.find(predicate);
    },
    (run) => run !== undefined,
    {
      description,
      timeoutMs: 10_000,
      formatLastObserved: (run) => JSON.stringify(run),
    },
  ) as AgentRun;
}

test("compiled Clanky completes its principal local user journey", async () => {
  const application = await E2EApplication.create();
  try {
    const git = await createGitFixture(application.runDirectory);
    await application.start();

    await runProductionHttpSmoke({
      baseUrl: application.baseUrl,
      ensureProcessRunning: () => {
        if (!application.isRunning) {
          throw new Error("Compiled Clanky process exited during the web smoke check");
        }
      },
    });

    const routeCatalog = await application.cli(["api"]);
    expect(routeCatalog.stdout).toContain("tasks");
    expect((await application.cli(["schema", "tasks"])).stdout.length).toBeGreaterThan(0);

    const apiKey = (await application.json<ApiKey>(
      "/api/api-keys",
      {
        method: "POST",
        body: JSON.stringify({ name: "E2E journey", scopes: ["*"] }),
      },
    )).data;
    expect(apiKey.token).toStartWith("wapp_");

    const hosts = (await application.json<ExecutionHost[]>("/api/execution-hosts")).data;
    const localHost = hosts.find((host) => host.ref["kind"] === "local");
    expect(localHost).toBeDefined();

    const workspacePayload = {
      name: "E2E workspace",
      directory: git.repositoryDirectory,
      executionHost: localHost!.ref,
      serverSettings: {
        agent: {
          adapter: "acp",
          provider: "copilot",
        },
      },
    };
    const rejectedCrossOriginMutation = await application.request("/api/workspaces", {
      method: "POST",
      body: JSON.stringify(workspacePayload),
      includeOrigin: false,
    });
    expect(rejectedCrossOriginMutation.status).toBe(403);

    const workspace = (await application.json<Workspace>(
      "/api/workspaces",
      {
        method: "POST",
        body: JSON.stringify(workspacePayload),
      },
      201,
    )).data;

    const models = (await application.json<Model[]>(
      `/api/models?workspaceId=${encodeURIComponent(workspace.id)}`,
    )).data;
    const discoveredModel = models.find(
      (model) => model.providerID === "copilot" && model.connected,
    );
    expect(discoveredModel?.modelID).toBe("mock-model");
    const model = {
      providerID: discoveredModel!.providerID,
      modelID: discoveredModel!.modelID,
      variant: "",
    };

    const scratchpad = "# E2E notes\n\nPersisted through the public CLI.";
    await application.cli(
      [
        "api",
        `workspaces/${workspace.id}`,
        "--method",
        "PUT",
        "--payload",
        JSON.stringify({ scratchpad }),
      ],
      { apiKey: apiKey.token },
    );
    expect(
      (await application.json<Workspace>(`/api/workspaces/${workspace.id}`)).data.scratchpad,
    ).toBe(scratchpad);

    const createdTask = (await application.json<Task>(
      "/api/tasks",
      {
        method: "POST",
        body: JSON.stringify({
          name: "External provider task",
          workspaceId: workspace.id,
          prompt: "[provider-write] Implement the requested fixture change",
          attachments: [],
          model,
          cheapModel: { mode: "same-as-task" },
          maxIterations: 4,
          maxConsecutiveErrors: 2,
          activityTimeoutSeconds: null,
          stopPattern: "<promise>COMPLETE</promise>",
          git: {
            branchPrefix: "e2e/",
            commitScope: "",
          },
          baseBranch: git.branch,
          useWorktree: true,
          clearPlanningFolder: true,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
        }),
      },
      201,
    )).data;

    const plannedTask = await waitForTask(
      application,
      createdTask.config.id,
      (task) => task.state.planMode.isPlanReady || task.state.status === "failed",
      "external provider to finish task planning",
    );
    expect(plannedTask.state.status).toBe("planning");
    const plan = (await application.json<{ content: string; exists: boolean }>(
      `/api/tasks/${createdTask.config.id}/plan`,
    )).data;
    expect(plan.exists).toBe(true);
    expect(plan.content).toContain("Create the requested fixture change");

    for (const [index, feedback] of [
      "Keep the plan focused on the externally observable file change",
      "Confirm the final Git state remains reviewable",
    ].entries()) {
      await application.json(
        `/api/tasks/${createdTask.config.id}/plan/feedback`,
        {
          method: "POST",
          body: JSON.stringify({ feedback, attachments: [] }),
        },
      );
      const refinedTask = await waitForTask(
        application,
        createdTask.config.id,
        (task) => (
          task.state.planMode.feedbackRounds >= index + 1
          && task.state.planMode.isPlanReady
        ),
        `plan feedback round ${String(index + 1)} to complete`,
      );
      expect(refinedTask.state.planMode.feedbackRounds).toBe(index + 1);
    }

    await application.json(
      `/api/tasks/${createdTask.config.id}/plan/accept`,
      {
        method: "POST",
        body: JSON.stringify({ mode: "start_task" }),
      },
    );
    const completedTask = await waitForTask(
      application,
      createdTask.config.id,
      (task) => ["completed", "failed", "max_iterations", "stopped"].includes(task.state.status),
      "external provider task to complete",
    );
    expect(completedTask.state.status).toBe("completed");
    expect(completedTask.state.git?.commits.length).toBeGreaterThan(0);

    const diff = (await application.json<Array<{
      path: string;
      status: string;
    }>>(`/api/tasks/${createdTask.config.id}/diff`)).data;
    expect(diff).toContainEqual(expect.objectContaining({
      path: "e2e-provider-change.txt",
      status: "added",
    }));

    const pendingMessage = "Recheck the result before final acceptance";
    await application.json(
      `/api/tasks/${createdTask.config.id}/pending`,
      {
        method: "POST",
        body: JSON.stringify({
          message: pendingMessage,
          model: null,
          attachments: [],
        }),
      },
    );
    await waitForTaskMessage(application, createdTask.config.id, pendingMessage);
    await waitForTask(
      application,
      createdTask.config.id,
      (task) => task.state.status === "stopped",
      "pending task input to settle",
    );
    const followUpMessage = "Perform one final verification turn";
    await application.json(
      `/api/tasks/${createdTask.config.id}/follow-up`,
      {
        method: "POST",
        body: JSON.stringify({
          message: followUpMessage,
          model: null,
          attachments: [],
        }),
      },
    );
    await waitForTaskMessage(application, createdTask.config.id, followUpMessage);
    await waitForTask(
      application,
      createdTask.config.id,
      (task) => task.state.status === "stopped",
      "terminal task follow-up to settle",
    );
    await application.json(
      `/api/tasks/${createdTask.config.id}/manual-complete`,
      { method: "POST", body: "{}" },
    );

    await application.json(
      `/api/tasks/${createdTask.config.id}/accept`,
      { method: "POST", body: "{}" },
    );
    const acceptedTask = (await application.json<Task>(
      `/api/tasks/${createdTask.config.id}`,
    )).data;
    expect(acceptedTask.state.status).toBe("accepted_local");
    expect(
      await readGitBranchFile(
        git,
        acceptedTask.state.git!.workingBranch,
        "e2e-provider-change.txt",
      ),
    ).toBe("created by the external ACP provider");
    expect(await gitStatus(git)).toBe("");

    const reviewResponse = (await application.json<{
      commentIds: string[];
      reviewCycle: number;
      success: boolean;
    }>(
      `/api/tasks/${createdTask.config.id}/address-comments`,
      {
        method: "POST",
        body: JSON.stringify({
          comments: "Verify the fixture file and preserve the clean source checkout",
          attachments: [],
        }),
      },
    )).data;
    expect(reviewResponse).toEqual(expect.objectContaining({
      success: true,
      reviewCycle: 1,
    }));
    const reviewedTask = await waitForTask(
      application,
      createdTask.config.id,
      (task) => (
        task.state.status === "completed"
        && (task.state.reviewMode?.reviewCycles ?? 0) >= 1
      ),
      "review feedback cycle to complete",
    );
    expect(reviewedTask.state.reviewMode?.reviewCycles).toBe(1);
    const reviewHistory = (await application.json<{
      success: boolean;
      history: { reviewCycles: number };
    }>(`/api/tasks/${createdTask.config.id}/review-history`)).data;
    expect(reviewHistory).toEqual(expect.objectContaining({
      success: true,
      history: expect.objectContaining({ reviewCycles: 1 }),
    }));

    const pushed = (await application.json<{
      remoteBranch: string;
      success: boolean;
    }>(
      `/api/tasks/${createdTask.config.id}/push`,
      { method: "POST", body: "{}" },
    )).data;
    expect(pushed.success).toBe(true);
    expect(
      await readRemoteBranchFile(git, pushed.remoteBranch, "e2e-provider-change.txt"),
    ).toBe("created by the external ACP provider");
    await commitAndPushFile(git, "base-update.txt", "base branch update\n");
    const branchUpdate = (await application.json<{
      success: boolean;
      syncStatus: string;
    }>(
      `/api/tasks/${createdTask.config.id}/update-branch`,
      { method: "POST", body: "{}" },
    )).data;
    expect(branchUpdate.success).toBe(true);
    expect(
      await readRemoteBranchFile(git, pushed.remoteBranch, "base-update.txt"),
    ).toBe("base branch update");
    await application.json(
      `/api/tasks/${createdTask.config.id}/mark-merged`,
      { method: "POST", body: "{}" },
    );
    expect(
      (await application.json<Task>(
        `/api/tasks/${createdTask.config.id}`,
      )).data.state.status,
    ).toBe("merged");

    const blockedTask = await createJourneyTask({
      application,
      baseBranch: git.branch,
      model,
      name: "Blocked recovery task",
      prompt: "[blocked] Wait for an external prerequisite and recover",
      workspaceId: workspace.id,
    });
    await waitForTask(
      application,
      blockedTask.config.id,
      (task) => task.state.planMode.isPlanReady,
      "blocked task plan to become ready",
    );
    await application.json(
      `/api/tasks/${blockedTask.config.id}/plan/accept`,
      {
        method: "POST",
        body: JSON.stringify({ mode: "start_task" }),
      },
    );
    await waitForTask(
      application,
      blockedTask.config.id,
      (task) => task.state.status === "stopped",
      "blocked task to stop",
    );
    const recoveryMessage = "The prerequisite is now available";
    await application.json(
      `/api/tasks/${blockedTask.config.id}/follow-up`,
      {
        method: "POST",
        body: JSON.stringify({
          message: recoveryMessage,
          model: null,
          attachments: [],
        }),
      },
    );
    await waitForTaskMessage(application, blockedTask.config.id, recoveryMessage);
    await waitForTask(
      application,
      blockedTask.config.id,
      (task) => task.state.status === "stopped",
      "blocked task follow-up to settle",
    );
    await application.json(
      `/api/tasks/${blockedTask.config.id}/manual-complete`,
      { method: "POST", body: "{}" },
    );
    await discardAndPurgeTask(application, blockedTask.config.id);

    const iterationLimitedTask = await createJourneyTask({
      application,
      autoAcceptPlan: true,
      baseBranch: git.branch,
      maxIterations: 1,
      model,
      name: "Iteration limit task",
      prompt: "[no-complete] Exercise the iteration limit",
      workspaceId: workspace.id,
    });
    await waitForTask(
      application,
      iterationLimitedTask.config.id,
      (task) => task.state.status === "max_iterations",
      "task to reach its iteration limit",
    );
    await discardAndPurgeTask(application, iterationLimitedTask.config.id);

    const providerErrorTask = await createJourneyTask({
      application,
      autoAcceptPlan: true,
      baseBranch: git.branch,
      model,
      name: "Provider failure task",
      prompt: "[provider-error] Surface an external provider failure",
      workspaceId: workspace.id,
    });
    await waitForTask(
      application,
      providerErrorTask.config.id,
      (task) => task.state.status === "failed",
      "external provider failure to become observable",
    );
    await discardAndPurgeTask(application, providerErrorTask.config.id);

    const interruptedDraft = await createJourneyTask({
      application,
      baseBranch: git.branch,
      draft: true,
      model,
      name: "Interrupted draft task",
      prompt: "[slow] Stop an in-flight draft task",
      workspaceId: workspace.id,
    });
    expect(interruptedDraft.state.status).toBe("draft");
    await application.json(
      `/api/tasks/${interruptedDraft.config.id}/draft/start`,
      {
        method: "POST",
        body: JSON.stringify({ attachments: [] }),
      },
    );
    await waitForTask(
      application,
      interruptedDraft.config.id,
      (task) => task.state.status === "planning",
      "draft task to begin planning",
    );
    await application.json(
      `/api/tasks/${interruptedDraft.config.id}/stop`,
      { method: "POST", body: "{}" },
    );
    await waitForTask(
      application,
      interruptedDraft.config.id,
      (task) => task.state.status === "stopped",
      "draft task to stop",
    );
    await discardAndPurgeTask(application, interruptedDraft.config.id);

    const discardedPlanTask = await createJourneyTask({
      application,
      baseBranch: git.branch,
      model,
      name: "Discarded plan task",
      prompt: "Prepare a plan that the user will discard",
      workspaceId: workspace.id,
    });
    await waitForTask(
      application,
      discardedPlanTask.config.id,
      (task) => task.state.planMode.isPlanReady,
      "discardable task plan to become ready",
    );
    await application.json(
      `/api/tasks/${discardedPlanTask.config.id}/plan/discard`,
      { method: "POST", body: "{}" },
    );
    expect(
      (await application.json<Task>(
        `/api/tasks/${discardedPlanTask.config.id}`,
      )).data.state.status,
    ).toBe("deleted");
    await application.json(
      `/api/tasks/${discardedPlanTask.config.id}/purge`,
      { method: "POST", body: "{}" },
    );
    expect(
      (await application.request(`/api/tasks/${discardedPlanTask.config.id}`)).status,
    ).toBe(404);

    const disposableWorkspace = (await application.json<Workspace>(
      "/api/workspaces",
      {
        method: "POST",
        body: JSON.stringify({
          ...workspacePayload,
          name: "Disposable E2E workspace",
        }),
      },
      201,
    )).data;
    const archivedWorkspace = (await application.json<Workspace>(
      `/api/workspaces/${disposableWorkspace.id}`,
      {
        method: "PUT",
        body: JSON.stringify({ archived: true }),
      },
    )).data;
    expect(archivedWorkspace.archived).toBe(true);
    await application.json(
      `/api/workspaces/${disposableWorkspace.id}`,
      {
        method: "DELETE",
        body: JSON.stringify({ deleteServerDirectory: false }),
      },
    );
    expect(
      (await application.request(`/api/workspaces/${disposableWorkspace.id}`)).status,
    ).toBe(404);

    const taskChatResponse = await application.request(
      `/api/tasks/${createdTask.config.id}/chat`,
      { method: "POST", body: "{}" },
    );
    expect([200, 201]).toContain(taskChatResponse.status);
    const taskChat = await taskChatResponse.json() as Chat;
    expect(taskChat.config).toEqual(expect.objectContaining({
      scope: "task",
      taskId: createdTask.config.id,
    }));
    await application.json(
      `/api/chats/${taskChat.config.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          message: "Summarize the completed task",
          attachments: [],
        }),
      },
    );
    expect((await waitForChatIdle(application, taskChat.config.id)).state.status).toBe("idle");

    const chat = (await application.json<Chat>(
      "/api/chats",
      {
        method: "POST",
        body: JSON.stringify({
          name: "E2E chat",
          workspaceId: workspace.id,
          model,
          useWorktree: false,
          autoApprovePermissions: false,
          baseBranch: git.branch,
        }),
      },
      201,
    )).data;
    const renamedChat = (await application.json<Chat>(
      `/api/chats/${chat.config.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: "E2E lifecycle chat" }),
      },
    )).data;
    expect(renamedChat.config.name).toBe("E2E lifecycle chat");

    const interactiveMessage = "Explain the fixture [retry] [permission] [question]";
    await application.json(
      `/api/chats/${chat.config.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          message: interactiveMessage,
          attachments: [],
        }),
      },
    );
    const awaitingPermission = await waitForChat(
      application,
      chat.config.id,
      (candidate) => candidate.state.pendingPermissionRequests?.some(
        (permission) => permission.status === "pending",
      ) ?? false,
      "chat permission request",
    );
    const permission = awaitingPermission.state.pendingPermissionRequests!.find(
      (candidate) => candidate.status === "pending",
    )!;
    await application.json(
      `/api/chats/${chat.config.id}/permissions/${permission.requestId}`,
      {
        method: "POST",
        body: JSON.stringify({ decision: "allow" }),
      },
    );
    const awaitingAnswer = await waitForChat(
      application,
      chat.config.id,
      (candidate) => candidate.state.harness?.questions?.some(
        (question) => question.status === "pending",
      ) ?? false,
      "chat question request",
    );
    const question = awaitingAnswer.state.harness!.questions!.find(
      (candidate) => candidate.status === "pending",
    )!;
    await application.json(
      `/api/chats/${chat.config.id}/questions/${question.requestId}`,
      {
        method: "POST",
        body: JSON.stringify({ answers: [["Concise"]] }),
      },
    );
    const settledChat = await waitForChatIdle(application, chat.config.id);
    expect(settledChat.state.status).toBe("idle");
    expect(
      settledChat.state.pendingPermissionRequests?.find(
        (candidate) => candidate.requestId === permission.requestId,
      ),
    ).toEqual(expect.objectContaining({ status: "approved", decision: "allow" }));
    expect(
      settledChat.state.harness?.questions?.find(
        (candidate) => candidate.requestId === question.requestId,
      ),
    ).toEqual(expect.objectContaining({
      status: "answered",
      answers: [["Concise"]],
    }));

    const slowMessage = "Process this slowly [slow]";
    await application.json(
      `/api/chats/${chat.config.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ message: slowMessage, attachments: [] }),
      },
    );
    await waitForChat(
      application,
      chat.config.id,
      (candidate) => candidate.state.status === "streaming",
      "chat to begin slow streaming",
    );
    const queuedMessage = "Handle this queued follow-up after the active turn";
    await application.json(
      `/api/chats/${chat.config.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ message: queuedMessage, attachments: [] }),
      },
    );
    await waitForChat(
      application,
      chat.config.id,
      (candidate) => candidate.state.queuedMessages?.some(
        (message) => message.content === queuedMessage,
      ) ?? false,
      "chat queued follow-up",
    );
    expect((await waitForChatIdle(application, chat.config.id)).state.status).toBe("idle");

    await application.json(
      `/api/chats/${chat.config.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          message: "Interrupt this active response [slow]",
          attachments: [],
        }),
      },
    );
    await waitForChat(
      application,
      chat.config.id,
      (candidate) => candidate.state.status === "streaming",
      "chat to begin interruptible response",
    );
    await application.json(
      `/api/chats/${chat.config.id}/interrupt`,
      {
        method: "POST",
        body: JSON.stringify({ reason: "E2E interruption" }),
      },
    );
    const interruptedChat = await waitForChat(
      application,
      chat.config.id,
      (candidate) => candidate.state.status === "idle",
      "chat interruption to settle",
    );
    expect(interruptedChat.state.status).toBe("idle");
    const reconnectedChat = (await application.json<Chat>(
      `/api/chats/${chat.config.id}/reconnect`,
      { method: "POST", body: "{}" },
    )).data;
    expect(reconnectedChat.state.status).toBe("idle");
    await application.json(
      `/api/chats/${chat.config.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          message: "Continue after recovery",
          attachments: [],
        }),
      },
    );
    expect((await waitForChatIdle(application, chat.config.id)).state.status).toBe("idle");

    const snapshot = (await application.json<ChatSnapshot>(
      `/api/chats/${chat.config.id}/snapshot?full=1`,
    )).data;
    expect(snapshot.transcript.messages).toContainEqual(expect.objectContaining({
      role: "user",
      content: interactiveMessage,
    }));
    expect(snapshot.transcript.messages).toContainEqual(expect.objectContaining({
      role: "user",
      content: queuedMessage,
    }));
    expect(snapshot.transcript.messages).toContainEqual(expect.objectContaining({
      role: "user",
      content: "Continue after recovery",
    }));
    expect(snapshot.transcript.messages.some((message) => message.role === "assistant")).toBe(true);

    const transcriptExport = await application.request(
      `/api/chats/${chat.config.id}/transcript.md`,
    );
    expect(transcriptExport.status).toBe(200);
    expect(await transcriptExport.text()).toContain("Continue after recovery");

    const conversionChat = (await application.json<Chat>(
      "/api/chats",
      {
        method: "POST",
        body: JSON.stringify({
          name: "E2E task conversion",
          workspaceId: workspace.id,
          model,
          useWorktree: false,
          autoApprovePermissions: true,
          baseBranch: git.branch,
        }),
      },
      201,
    )).data;
    await application.json(
      `/api/chats/${conversionChat.config.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          message: "Describe the fixture task to create",
          attachments: [],
        }),
      },
    );
    expect((await waitForChatIdle(application, conversionChat.config.id)).state.status).toBe("idle");
    const convertedTask = (await application.json<Task>(
      `/api/chats/${conversionChat.config.id}/spawn-task`,
      { method: "POST", body: "{}" },
      201,
    )).data;
    const convertedPlan = await waitForTask(
      application,
      convertedTask.config.id,
      (task) => task.state.planMode.isPlanReady || task.state.status === "failed",
      "chat-converted task planning",
    );
    expect(convertedPlan.state.status).toBe("planning");
    await application.json(
      `/api/tasks/${convertedTask.config.id}`,
      { method: "DELETE" },
    );
    await application.json(
      `/api/chats/${conversionChat.config.id}`,
      { method: "DELETE" },
    );

    const doneChat = (await application.json<Chat>(
      `/api/chats/${chat.config.id}/done`,
      { method: "POST", body: "{}" },
    )).data;
    expect(doneChat.state.status).toBe("done");

    await application.json(
      "/api/preferences/dashboard-view-mode",
      { method: "PUT", body: JSON.stringify({ mode: "rows" }) },
    );
    await application.json(
      "/api/preferences/scheduler-timezone",
      { method: "PUT", body: JSON.stringify({ timezone: "UTC" }) },
    );
    await application.json(
      "/api/preferences/quick-chat",
      {
        method: "PUT",
        body: JSON.stringify({
          workspaceId: workspace.id,
          model,
          useWorktree: false,
        }),
      },
    );

    const scheduledStartAt = new Date(Date.now() + 2_000)
      .toISOString()
      .slice(0, 19);
    const agent = (await application.json<Agent>(
      "/api/agents",
      {
        method: "POST",
        body: JSON.stringify({
          name: "E2E scheduled agent",
          workspaceId: workspace.id,
          prompt: "Inspect the fixture and report its state",
          model,
          baseBranch: git.branch,
          useWorktree: false,
          schedule: {
            startAtLocal: scheduledStartAt,
            timezone: "UTC",
            interval: { value: 1, unit: "minutes" },
          },
          enabled: true,
        }),
      },
      201,
    )).data;
    const scheduledRun = await waitForAgentRun(
      application,
      agent.config.id,
      (run) => run.trigger === "schedule" && ["completed", "failed"].includes(run.status),
      "scheduled agent run",
    );
    expect(scheduledRun.status).toBe("completed");
    const scheduledSnapshot = (await application.json<AgentRunSnapshot>(
      `/api/agent-runs/${scheduledRun.id}/snapshot?full=1`,
    )).data;
    expect(
      scheduledSnapshot.transcript.messages.some((message) => message.role === "assistant"),
    ).toBe(true);

    const pausedAgent = (await application.json<Agent>(
      `/api/agents/${agent.config.id}/pause`,
      { method: "POST", body: "{}" },
    )).data;
    expect(pausedAgent.state.status).toBe("paused");
    const resumedAgent = (await application.json<Agent>(
      `/api/agents/${agent.config.id}/resume`,
      { method: "POST", body: "{}" },
    )).data;
    expect(resumedAgent.state.status).toBe("enabled");
    const updatedAgent = (await application.json<Agent>(
      `/api/agents/${agent.config.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          name: "E2E persisted agent",
          prompt: "Run until interrupted [slow]",
        }),
      },
    )).data;
    expect(updatedAgent.config.name).toBe("E2E persisted agent");

    const interruptibleRun = (await application.json<AgentRun>(
      `/api/agents/${agent.config.id}/run`,
      { method: "POST", body: "{}" },
      202,
    )).data;
    await pollUntil(
      async () => (await application.json<AgentRun>(
        `/api/agent-runs/${interruptibleRun.id}`,
      )).data,
      (run) => run.status === "running",
      {
        description: "manual agent run to become interruptible",
        timeoutMs: 10_000,
        formatLastObserved: (run) => run.status,
      },
    );
    await application.json(
      `/api/agents/${agent.config.id}/interrupt`,
      { method: "POST", body: "{}" },
    );
    const interruptedRun = await waitForAgentRun(
      application,
      agent.config.id,
      (run) => run.id === interruptibleRun.id && run.status === "interrupted",
      "manual agent interruption",
    );
    expect(interruptedRun.status).toBe("interrupted");

    await application.json(
      `/api/agents/${agent.config.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ prompt: "Complete the manual fixture report" }),
      },
    );
    const manualRun = (await application.json<AgentRun>(
      `/api/agents/${agent.config.id}/run`,
      { method: "POST", body: "{}" },
      202,
    )).data;
    const completedManualRun = await waitForAgentRun(
      application,
      agent.config.id,
      (run) => run.id === manualRun.id && ["completed", "failed"].includes(run.status),
      "manual agent completion",
    );
    expect(completedManualRun.status).toBe("completed");

    const exportedAgentResponse = await application.request(
      `/api/agents/${agent.config.id}/export`,
    );
    expect(exportedAgentResponse.status).toBe(200);
    const exportedAgent = await exportedAgentResponse.json();
    const importedAgent = (await application.json<Agent>(
      `/api/workspaces/${workspace.id}/agents/import`,
      {
        method: "POST",
        body: JSON.stringify(exportedAgent),
      },
      201,
    )).data;
    expect(importedAgent.config.id).not.toBe(agent.config.id);
    await application.json(
      `/api/agents/${importedAgent.config.id}`,
      { method: "DELETE" },
    );

    const autonomousTask = await createJourneyTask({
      application,
      baseBranch: git.branch,
      fullyAutonomous: true,
      model,
      name: "Autonomous GitHub task",
      prompt: "[provider-write-autonomous] Complete and publish this change",
      workspaceId: workspace.id,
    });
    await waitForTask(
      application,
      autonomousTask.config.id,
      (task) => task.state.planMode.isPlanReady,
      "autonomous task plan to become ready",
    );
    await configureGitHubRemote(git);
    try {
      await application.json(
        `/api/tasks/${autonomousTask.config.id}/plan/accept`,
        {
          method: "POST",
          body: JSON.stringify({ mode: "start_task" }),
        },
      );
      const pullRequestTask = await waitForTask(
        application,
        autonomousTask.config.id,
        (task) => (
          task.state.status === "pushed"
          && task.state.automaticPrFlow?.status === "monitoring"
          && task.state.automaticPrFlow.pullRequestNumber === 42
        ),
        "fully autonomous task to push and open its pull request",
      );
      expect(pullRequestTask.state.automaticPrFlow).toEqual(
        expect.objectContaining({
          enabled: true,
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.com/e2e/clanky-fixture/pull/42",
          status: "monitoring",
        }),
      );
      const autoMerge = (await application.json<{
        pullRequest: {
          number: number;
          url: string;
        };
        success: boolean;
      }>(
        `/api/tasks/${autonomousTask.config.id}/pull-request/auto-merge`,
        { method: "POST", body: "{}" },
      )).data;
      expect(autoMerge).toEqual(expect.objectContaining({
        success: true,
        pullRequest: expect.objectContaining({
          number: 42,
          url: "https://github.com/e2e/clanky-fixture/pull/42",
        }),
      }));

      await application.restart();
      const addressedFeedbackTask = await waitForTask(
        application,
        autonomousTask.config.id,
        (task) => (
          task.state.status === "completed"
          && task.state.automaticPrFlow?.activeBatch !== undefined
        ),
        "automatic GitHub feedback cycle to complete",
      );
      expect(addressedFeedbackTask.state.automaticPrFlow?.activeBatch?.items).toEqual([
        expect.objectContaining({
          id: "e2e-review-thread",
          source: "review_thread",
        }),
      ]);

      await application.restart();
      const resolvedFeedbackTask = await waitForTask(
        application,
        autonomousTask.config.id,
        (task) => (
          task.state.status === "pushed"
          && task.state.automaticPrFlow?.status === "monitoring"
          && task.state.automaticPrFlow.activeBatch === undefined
          && task.state.automaticPrFlow.handledItems.some(
            (item) => item.id === "e2e-review-thread" && item.outcome === "resolved",
          )
        ),
        "automatic GitHub feedback to push and resolve",
      );
      expect(resolvedFeedbackTask.state.automaticPrFlow?.handledItems).toContainEqual(
        expect.objectContaining({
          id: "e2e-review-thread",
          outcome: "resolved",
          source: "review_thread",
        }),
      );

      await application.restart();
      const mergedAutonomousTask = await waitForTask(
        application,
        autonomousTask.config.id,
        (task) => task.state.status === "merged",
        "merged GitHub pull request to close the autonomous task",
      );
      expect(mergedAutonomousTask.state.pullRequestMonitoring).toEqual(
        expect.objectContaining({
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.com/e2e/clanky-fixture/pull/42",
          status: "merged",
        }),
      );
      expect(
        await readRemoteBranchFile(
          git,
          mergedAutonomousTask.state.git!.workingBranch,
          "e2e-autonomous-change.txt",
        ),
      ).toBe("created by the autonomous external ACP journey");
      expect(
        (await application.json<{
          history: {
            reviewCycles: number;
          };
        }>(`/api/tasks/${autonomousTask.config.id}/review-history`)).data.history.reviewCycles,
      ).toBe(1);
    } finally {
      await restoreLocalRemote(git);
    }

    const restartRecoveryTask = await createJourneyTask({
      application,
      baseBranch: git.branch,
      draft: true,
      model,
      name: "Restart recovery task",
      prompt: "[slow] Preserve an active task across server restart",
      workspaceId: workspace.id,
    });
    await application.json(
      `/api/tasks/${restartRecoveryTask.config.id}/draft/start`,
      {
        method: "POST",
        body: JSON.stringify({ attachments: [] }),
      },
    );
    await waitForTask(
      application,
      restartRecoveryTask.config.id,
      (task) => task.state.status === "planning",
      "restart recovery task to become active",
    );
    await application.restart({ disablePasskey: false });

    expect((await application.request("/api/workspaces")).status).toBe(401);
    const authStatus = (await application.json<{
      authenticated: boolean;
      authKind: string;
    }>("/api/auth/status", { apiKey: apiKey.token })).data;
    expect(authStatus).toEqual(expect.objectContaining({
      authenticated: true,
      authKind: "api-key",
    }));

    const persistedWorkspace = (await application.json<Workspace>(
      `/api/workspaces/${workspace.id}`,
      { apiKey: apiKey.token },
    )).data;
    expect(persistedWorkspace.scratchpad).toBe(scratchpad);
    expect(
      (await application.json<Task>(
        `/api/tasks/${createdTask.config.id}`,
        { apiKey: apiKey.token },
      )).data.state.status,
    ).toBe("merged");
    const interruptedPlanningTask = (await application.json<Task>(
      `/api/tasks/${restartRecoveryTask.config.id}`,
      { apiKey: apiKey.token },
    )).data;
    expect(interruptedPlanningTask.state.status).toBe("planning");
    expect(interruptedPlanningTask.state.planMode.isPlanReady).toBe(false);
    await application.json(
      `/api/tasks/${restartRecoveryTask.config.id}/plan/feedback`,
      {
        method: "POST",
        apiKey: apiKey.token,
        body: JSON.stringify({
          feedback: "[plan-feedback-ready] Continue planning after the server restart",
          attachments: [],
        }),
      },
    );
    const recoveredPlanningTask = await pollUntil(
      async () => (await application.json<Task>(
        `/api/tasks/${restartRecoveryTask.config.id}`,
        { apiKey: apiKey.token },
      )).data,
      (task) => task.state.planMode.isPlanReady,
      {
        description: "planning task recovery after restart",
        timeoutMs: 10_000,
        formatLastObserved: (task) => JSON.stringify({
          feedbackRounds: task.state.planMode.feedbackRounds,
          planReady: task.state.planMode.isPlanReady,
          status: task.state.status,
        }),
      },
    );
    expect(recoveredPlanningTask.state.planMode.feedbackRounds).toBe(1);
    await application.json(
      `/api/tasks/${restartRecoveryTask.config.id}/plan/discard`,
      { method: "POST", body: "{}", apiKey: apiKey.token },
    );
    await application.json(
      `/api/tasks/${restartRecoveryTask.config.id}/purge`,
      { method: "POST", body: "{}", apiKey: apiKey.token },
    );
    expect(
      (await application.request(
        `/api/tasks/${restartRecoveryTask.config.id}`,
        { apiKey: apiKey.token },
      )).status,
    ).toBe(404);
    expect(
      (await application.json<ChatSnapshot>(
        `/api/chats/${chat.config.id}/snapshot?full=1`,
        { apiKey: apiKey.token },
      )).data.transcript.messages.length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      (await application.json<Chat>(
        `/api/chats/${chat.config.id}`,
        { apiKey: apiKey.token },
      )).data.state.status,
    ).toBe("done");
    expect(
      (await application.json<Chat>(
        `/api/tasks/${createdTask.config.id}/chat`,
        { apiKey: apiKey.token },
      )).data.config.taskId,
    ).toBe(createdTask.config.id);
    expect(
      (await application.json<{ mode: string }>(
        "/api/preferences/dashboard-view-mode",
        { apiKey: apiKey.token },
      )).data.mode,
    ).toBe("rows");
    expect(
      (await application.json<{ timezone: string }>(
        "/api/preferences/scheduler-timezone",
        { apiKey: apiKey.token },
      )).data.timezone,
    ).toBe("UTC");
    expect(
      (await application.json<{
        workspaceId: string;
        model: { providerID: string; modelID: string };
      }>(
        "/api/preferences/quick-chat",
        { apiKey: apiKey.token },
      )).data,
    ).toEqual(expect.objectContaining({
      workspaceId: workspace.id,
      model: expect.objectContaining({
        providerID: model.providerID,
        modelID: model.modelID,
      }),
    }));
    expect(
      (await application.json<Agent>(
        `/api/agents/${agent.config.id}`,
        { apiKey: apiKey.token },
      )).data.config.name,
    ).toBe("E2E persisted agent");
    const persistedAgentRuns = (await application.json<AgentRun[]>(
      `/api/agents/${agent.config.id}/runs`,
      { apiKey: apiKey.token },
    )).data;
    expect(persistedAgentRuns).toContainEqual(expect.objectContaining({
      id: completedManualRun.id,
      status: "completed",
    }));

    const cliWorkspace = await application.cli(
      ["api", `workspaces/${workspace.id}`, "--method", "GET"],
      { apiKey: apiKey.token },
    );
    expect(cliWorkspace.stdout).toContain("Persisted through the public CLI");

    const transcriptHtml = await application.request(
      `/api/chats/${chat.config.id}/transcript.html`,
      { apiKey: apiKey.token },
    );
    expect(transcriptHtml.status).toBe(200);
    expect(transcriptHtml.headers.get("content-type")).toContain("text/html");
    await application.json(
      `/api/chats/${chat.config.id}`,
      { method: "DELETE", apiKey: apiKey.token },
    );
    expect(
      (await application.request(
        `/api/chats/${chat.config.id}`,
        { apiKey: apiKey.token },
      )).status,
    ).toBe(404);
    const purgeResponse = (await application.json<{ deletedRunIds: string[] }>(
      `/api/agents/${agent.config.id}/runs`,
      {
        method: "DELETE",
        body: "{}",
        apiKey: apiKey.token,
      },
    )).data;
    expect(purgeResponse.deletedRunIds).toContain(completedManualRun.id);
    await application.json(
      `/api/agents/${agent.config.id}`,
      { method: "DELETE", apiKey: apiKey.token },
    );
    expect(
      (await application.request(
        `/api/agents/${agent.config.id}`,
        { apiKey: apiKey.token },
      )).status,
    ).toBe(404);

    await application.json(
      `/api/api-keys/${apiKey.key.id}`,
      { method: "DELETE", apiKey: apiKey.token },
    );
    expect(
      (await application.request("/api/workspaces", { apiKey: apiKey.token })).status,
    ).toBe(401);
  } catch (error) {
    const diagnostics = await application.diagnostics();
    if (diagnostics.length > 0) {
      console.error(diagnostics);
    }
    throw error;
  } finally {
    await application.cleanup();
  }
}, 120_000);
