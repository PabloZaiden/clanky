import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import { pollUntil } from "./support/polling";

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

interface HistoryRecovery {
  exportDirectory: string;
  status: string;
  transcriptPath: string;
}

interface Chat {
  config: {
    id: string;
  };
  state: {
    status: string;
    error?: { message: string };
    connectionStatus?: string;
    harness?: {
      historyRecovery?: HistoryRecovery;
    };
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
        connectionStatus: chat.state.connectionStatus,
        error: chat.state.error,
      }),
    },
  );
}

test("users can continue a persisted chat after its provider session is lost", async () => {
  const application = await E2EApplication.create();
  try {
    const git = await createGitFixture(application.runDirectory);
    await application.start();

    const hosts = (await application.json<ExecutionHost[]>("/api/execution-hosts")).data;
    const localHost = hosts.find((host) => host.ref["kind"] === "local");
    expect(localHost).toBeDefined();
    const workspace = (await application.json<Workspace>(
      "/api/workspaces",
      {
        method: "POST",
        body: JSON.stringify({
          name: "History recovery",
          directory: git.repositoryDirectory,
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
    const model = models.find((candidate) =>
      candidate.providerID === "copilot" && candidate.connected
    );
    expect(model).toBeDefined();

    const chat = (await application.json<Chat>(
      "/api/chats",
      {
        method: "POST",
        body: JSON.stringify({
          name: "History recovery chat",
          workspaceId: workspace.id,
          model: {
            providerID: model!.providerID,
            modelID: model!.modelID,
            variant: "",
          },
          useWorktree: false,
          autoApprovePermissions: true,
          baseBranch: git.branch,
        }),
      },
      201,
    )).data;
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nBT /F1 12 Tf 72 720 Td (Estimate code: EST-73142) Tj ET\n%%EOF\n",
      "latin1",
    );
    await application.json(
      `/api/chats/${chat.config.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          message: "Please remember the secret word is AMBER-KITE.",
          attachments: [{
            id: crypto.randomUUID(),
            filename: "estimate.pdf",
            mimeType: "application/octet-stream",
            data: pdf.toString("base64"),
            size: pdf.byteLength,
          }],
        }),
      },
    );
    const initialTurn = await waitForChat(
      application,
      chat.config.id,
      (current) => current.state.status === "idle" || current.state.status === "failed",
      "the initial chat turn to finish",
    );
    expect(initialTurn.state.status).toBe("idle");

    await application.restart({
      env: { CLANKY_E2E_ACP_FAIL_SESSION_LOAD: "true" },
    });
    const disconnectedChat = await waitForChat(
      application,
      chat.config.id,
      (current) => current.state.status === "idle" || current.state.status === "failed",
      "the chat to reload after the server restart",
    );
    expect(disconnectedChat.state.connectionStatus).toBe("disconnected");

    const reconnect = await application.request(
      `/api/chats/${chat.config.id}/reconnect`,
      { method: "POST", body: "{}" },
    );
    const reconnectBody = await reconnect.text();
    expect(reconnect.ok, reconnectBody).toBe(false);
    const failedReconnect = await waitForChat(
      application,
      chat.config.id,
      (current) => current.state.status === "failed",
      "the failed provider reconnect to settle",
    );
    expect(failedReconnect.state.status).toBe("failed");

    const continued = (await application.json<Chat>(
      `/api/chats/${chat.config.id}/continue-from-history`,
      { method: "POST", body: "{}" },
    )).data;
    const recovery = continued.state.harness?.historyRecovery;
    expect(recovery).toBeDefined();
    if (!recovery) {
      throw new Error("Continue from history did not create a temporary history export.");
    }
    expect(existsSync(recovery.transcriptPath)).toBe(true);

    await application.json(
      `/api/chats/${chat.config.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          message: "What was the secret word, and what code is printed on the estimate?",
          attachments: [],
        }),
      },
    );
    const response = await pollUntil(
      async () => (
        await application.json<ChatSnapshot>(
          `/api/chats/${chat.config.id}/snapshot?full=1`,
        )
      ).data,
      (snapshot) => snapshot.transcript.messages.some(
        (message) => message.role === "assistant"
          && message.content.includes("AMBER-KITE")
          && message.content.includes("EST-73142"),
      ),
      {
        description: "the provider to answer from the prior message and PDF",
        timeoutMs: 10_000,
        formatLastObserved: (snapshot) => JSON.stringify(
          snapshot.transcript.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.content),
        ),
      },
    );
    expect(response.transcript.messages.some(
      (message) => message.role === "assistant"
        && message.content.includes("AMBER-KITE")
        && message.content.includes("EST-73142"),
    )).toBe(true);

    const completedChat = await waitForChat(
      application,
      chat.config.id,
      (current) => current.state.status === "idle",
      "the recovered chat turn to finish",
    );
    const completedRecovery = await pollUntil(
      async () => (
        await application.json<Chat>(`/api/chats/${chat.config.id}`)
      ).data.state.harness?.historyRecovery ?? null,
      (current): current is HistoryRecovery => current?.status === "complete",
      {
        description: "the temporary history export cleanup to finish",
        timeoutMs: 10_000,
        formatLastObserved: (current) => JSON.stringify({
          chatStatus: completedChat.state.status,
          recoveryStatus: current?.status,
        }),
      },
    );
    expect(existsSync(completedRecovery.exportDirectory)).toBe(false);
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
