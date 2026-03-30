import { afterEach, describe, expect, test } from "bun:test";
import { ChatManager } from "../../src/core/chat-manager";
import { SimpleEventEmitter } from "../../src/core/event-emitter";
import { loadChat } from "../../src/persistence/chats";
import type { ChatEvent } from "../../src/types";
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
      initGit: true,
    });

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Runtime Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
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
    expect(completed.state.worktree?.originalBranch).toBeString();
    expect(completed.state.worktree?.workingBranch).toContain("chat-runtime-chat-");
    expect(completed.state.worktree?.worktreePath).toBe(`${context.workDir}/.ralph-worktrees/${chat.config.id}`);
    expect(context.mockBackend?.getDirectory()).toBe(completed.state.worktree?.worktreePath);
    expect(
      await context.git.worktreeExists(
        context.workDir,
        `${context.workDir}/.ralph-worktrees/${chat.config.id}`,
      ),
    ).toBe(true);
    expect(completed.state.messages.map((message) => message.content)).toEqual([
      "Say hello",
      "Hello from the chat backend",
    ]);
  });

  test("emits chat.status events for starting, streaming, and idle transitions", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Hello from the chat backend"],
      initGit: true,
    });

    const events: ChatEvent[] = [];
    const emitter = new SimpleEventEmitter<ChatEvent>();
    emitter.subscribe((event) => {
      events.push(event);
    });

    const manager = new ChatManager(emitter);
    const chat = await manager.createChat({
      name: "Status Events Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Say hello",
    });

    await waitForChat(chat.config.id, (current) => current.state.status === "idle");

    const statuses = events
      .filter((event): event is Extract<ChatEvent, { type: "chat.status" }> => event.type === "chat.status")
      .map((event) => event.status);

    expect(statuses).toEqual(expect.arrayContaining(["starting", "streaming", "idle"]));
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

  test("removes the chat worktree when deleting a worktree-backed chat", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Hello from the chat backend"],
      initGit: true,
    });

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Delete Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Create the worktree",
    });

    const completed = await waitForChat(chat.config.id, (current) => current.state.status === "idle");
    const worktreePath = completed.state.worktree?.worktreePath;

    expect(worktreePath).toBeString();
    expect(await context.git.worktreeExists(context.workDir, worktreePath!)).toBe(true);

    expect(await manager.deleteChat(chat.config.id)).toBe(true);
    expect(await loadChat(chat.config.id)).toBeNull();
    expect(await context.git.worktreeExists(context.workDir, worktreePath!)).toBe(false);
  });
});
