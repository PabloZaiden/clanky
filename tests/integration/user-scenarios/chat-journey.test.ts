import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatSnapshot } from "@/shared/chat-transcript";
import { pollUntil } from "../../helpers/polling";
import {
  setupTestServer,
  teardownTestServer,
  type TestServerContext,
} from "./helpers";

const mockAcpModel = {
  providerID: "opencode",
  modelID: "mock-model",
  variant: "",
};

describe("Workspace chat journey", () => {
  let context: TestServerContext;

  beforeEach(async () => {
    context = await setupTestServer({
      useMockAcpProcess: true,
      useRealExecutionPath: true,
    });
  });

  afterEach(async () => {
    await teardownTestServer(context);
  });

  test("creates a chat, sends a prompt, and reloads its persisted response", async () => {
    const prompt = "Confirm this chat round-trip. <promise>COMPLETE</promise>";
    const createResponse = await fetch(`${context.baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "HTTP chat journey",
        workspaceId: context.workspaceId,
        model: mockAcpModel,
        useWorktree: false,
        baseBranch: context.defaultBranch,
      }),
    });
    expect(createResponse.status).toBe(201);

    const created = await createResponse.json() as {
      config: { id: string; workspaceId: string };
    };
    expect(created.config.workspaceId).toBe(context.workspaceId);

    const sendResponse = await fetch(`${context.baseUrl}/api/chats/${created.config.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: prompt }),
    });
    expect(sendResponse.status).toBe(200);
    const sendResult = await sendResponse.json() as {
      success: boolean;
      chatId: string;
    };
    expect(sendResult.success).toBe(true);
    expect(sendResult.chatId).toBe(created.config.id);

    const settled = await pollUntil(
      async () => {
        const response = await fetch(
          `${context.baseUrl}/api/chats/${created.config.id}/snapshot?full=1`,
        );
        if (!response.ok) {
          return { status: response.status, snapshot: null };
        }
        return {
          status: response.status,
          snapshot: await response.json() as ChatSnapshot,
        };
      },
      ({ status, snapshot }) => status === 200 && (
        snapshot?.state.status === "failed"
        || (
          snapshot?.state.status === "idle"
          && snapshot.transcript.messages.some((message) => (
            message.role === "assistant"
            && message.content.includes("The requested work is complete.")
          ))
        )
      ),
      {
        description: `chat ${created.config.id} to persist its completed response`,
        timeoutMs: 30_000,
        formatLastObserved: ({ status, snapshot }) => {
          if (!snapshot) {
            return `HTTP ${status}`;
          }
          const lastMessage = snapshot.transcript.messages.at(-1)?.content ?? "no messages";
          return `HTTP ${status}; state=${snapshot.state.status}; last message=${lastMessage.slice(0, 120)}`
            + (snapshot.state.error ? `; error=${snapshot.state.error.message}` : "");
        },
      },
    );

    if (!settled.snapshot) {
      throw new Error(`Chat ${created.config.id} returned no persisted transcript`);
    }

    expect(settled.snapshot.state.status).toBe("idle");
    expect(settled.snapshot.transcript.messages.some((message) => (
      message.role === "user" && message.content === prompt
    ))).toBe(true);
    expect(settled.snapshot.transcript.messages.some((message) => (
      message.role === "assistant"
      && message.content.includes("The requested work is complete.")
    ))).toBe(true);
  }, { timeout: 60_000 });
});
