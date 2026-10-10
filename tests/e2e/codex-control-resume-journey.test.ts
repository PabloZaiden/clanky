import { expect, test } from "bun:test";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import { pollUntil } from "./support/polling";
import { installExternalCodexProvider } from "./support/provider";

interface ExecutionHost {
  ref: Record<string, string>;
}

interface Workspace {
  id: string;
  name: string;
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
    status: string;
  };
}

interface ChatSnapshot {
  transcript: {
    messages: Array<{
      content: string;
      role: string;
    }>;
  };
}

async function waitForChatIdle(application: E2EApplication, chatId: string): Promise<Chat> {
  const chat = await pollUntil(
    async () => (await application.json<Chat>(`/api/chats/${chatId}`)).data,
    (current) => current.state.status === "idle" || current.state.status === "failed",
    {
      description: `chat ${chatId} to finish its turn`,
      timeoutMs: 10_000,
      formatLastObserved: (current) => JSON.stringify({ status: current.state.status }),
    },
  );
  expect(chat.state.status).toBe("idle");
  return chat;
}

async function waitForToolResult(
  application: E2EApplication,
  chatId: string,
  workspaceName: string,
  expectedCount: number,
): Promise<ChatSnapshot> {
  return await pollUntil(
    async () => (
      await application.json<ChatSnapshot>(`/api/chats/${chatId}/snapshot?full=1`)
    ).data,
    (snapshot) => snapshot.transcript.messages.filter(
      (message) => message.role === "assistant" && message.content.includes(workspaceName),
    ).length >= expectedCount,
    {
      description: `Codex to return ${String(expectedCount)} public workspace-list results`,
      timeoutMs: 10_000,
      formatLastObserved: (snapshot) => JSON.stringify({
        assistantMessages: snapshot.transcript.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.content.slice(0, 300)),
      }),
    },
  );
}

test("Codex control chat resumes with its tools after restarting Clanky", async () => {
  const application = await E2EApplication.create();
  try {
    const git = await createGitFixture(application.runDirectory);
    await installExternalCodexProvider(application.providerBinDirectory);
    await application.start();

    const hosts = (await application.json<ExecutionHost[]>("/api/execution-hosts")).data;
    const localHost = hosts.find((host) => host.ref["kind"] === "local");
    expect(localHost).toBeDefined();

    const workspaceName = "Codex control resume workspace";
    const workspace = (await application.json<Workspace>(
      "/api/workspaces",
      {
        method: "POST",
        body: JSON.stringify({
          name: workspaceName,
          directory: git.repositoryDirectory,
          executionHost: localHost!.ref,
          serverSettings: {
            agent: { adapter: "codex", provider: "codex" },
          },
        }),
      },
      201,
    )).data;

    const models = (await application.json<Model[]>(
      `/api/models?workspaceId=${encodeURIComponent(workspace.id)}`,
    )).data;
    const model = models.find(
      (candidate) => candidate.providerID === "codex" && candidate.connected,
    );
    expect(model?.modelID).toBe("e2e-codex-model");
    const modelConfig = {
      providerID: model!.providerID,
      modelID: model!.modelID,
      variant: "",
    };

    await application.json("/api/preferences/quick-chat", {
      method: "PUT",
      body: JSON.stringify({
        workspaceId: workspace.id,
        model: modelConfig,
        useWorktree: false,
      }),
    });
    const chat = (await application.json<Chat>(
      "/api/chats",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Codex control resume",
          workspaceId: workspace.id,
          model: modelConfig,
          useWorktree: false,
          autoApprovePermissions: false,
          baseBranch: git.branch,
        }),
      },
      201,
    )).data;

    await application.json(`/api/chats/${chat.config.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message: "List the workspaces available in Clanky.",
        attachments: [],
      }),
    });
    await waitForChatIdle(application, chat.config.id);
    await waitForToolResult(application, chat.config.id, workspaceName, 1);

    await application.restart();
    const reconnected = (await application.json<Chat>(
      `/api/chats/${chat.config.id}/reconnect`,
      { method: "POST", body: "{}" },
    )).data;
    expect(reconnected.state.status).toBe("idle");

    await application.json(`/api/chats/${chat.config.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message: "List the workspaces again after reconnecting.",
        attachments: [],
      }),
    });
    await waitForChatIdle(application, chat.config.id);
    const resumedSnapshot = await waitForToolResult(
      application,
      chat.config.id,
      workspaceName,
      2,
    );
    expect(
      resumedSnapshot.transcript.messages.filter(
        (message) => message.role === "assistant" && message.content.includes(workspaceName),
      ),
    ).toHaveLength(2);
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
