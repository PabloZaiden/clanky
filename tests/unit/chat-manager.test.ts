import { afterEach, describe, expect, test } from "bun:test";
import { ChatManager } from "../../src/core/chat-manager";
import { loadChat } from "../../src/persistence/chats";
import { setupTestContext, teardownTestContext, testModelFields, testWorkspaceId, type TestContext } from "../setup";

let context: TestContext | undefined;

async function waitForChat(
  chatId: string,
  predicate: (chat: NonNullable<Awaited<ReturnType<typeof loadChat>>>) => boolean,
  timeoutMs = 5000,
): Promise<NonNullable<Awaited<ReturnType<typeof loadChat>>>> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const chat = await loadChat(chatId);
    if (chat && predicate(chat)) {
      return chat;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const lastChat = await loadChat(chatId);
  throw new Error(`Timed out waiting for chat condition. Last state: ${JSON.stringify(lastChat?.state)}`);
}

describe("ChatManager", () => {
  afterEach(async () => {
    if (context) {
      await teardownTestContext(context);
      context = undefined;
    }
  });

  test("streams chat responses and persists assistant messages", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Hello from the chat backend"],
    });

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Runtime Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    const started = await manager.sendMessage(chat.config.id, {
      message: "Say hello",
    });

    expect(started.state.status).toBe("streaming");

    const completed = await waitForChat(chat.config.id, (current) =>
      current.state.status === "idle" && current.state.messages.some((message) => message.role === "assistant"),
    );

    expect(completed.state.session?.id).toBeString();
    expect(completed.state.messages.map((message) => message.content)).toEqual([
      "Say hello",
      "Hello from the chat backend",
    ]);
  });

  test("marks chat failed when persisted session is missing instead of recreating it", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Recovered response"],
    });

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Reconnect Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    const firstRun = await manager.sendMessage(chat.config.id, {
      message: "Create a session",
    });

    const completed = await waitForChat(chat.config.id, (current) => current.state.status === "idle");
    const sessionId = completed.state.session?.id;

    expect(sessionId).toBeString();
    await context.mockBackend?.deleteSession(sessionId!);

    const reconnected = await manager.reconnectSession(firstRun.config.id);
    expect(reconnected).not.toBeNull();
    expect(reconnected?.state.status).toBe("failed");
    expect(reconnected?.state.session?.id).toBe(sessionId);
    expect(reconnected?.state.error?.message.toLowerCase()).toContain("session");
    expect(await context.mockBackend?.getSession(sessionId!)).toBeNull();
  });
});
