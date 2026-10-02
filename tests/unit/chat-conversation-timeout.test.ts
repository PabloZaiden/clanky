import { afterEach, expect, jest, test } from "bun:test";
import type { Chat } from "@/shared";
import { createInitialChatState } from "@/shared/chat";
import { ChatConversationService } from "../../src/core/chat-conversation-service";
import type {
  ChatSessionPort,
  ChatStatePort,
  ChatWorktreePort,
} from "../../src/core/chat-service-contracts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  jest.useRealTimers();
});

// Keep the public wait deadline independent from the shorter agent-stream timeout without a real wait.
test("keeps the chat-idle wait deadline at 15 minutes after the stream default becomes 330 seconds", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

  const chatId = "busy-chat";
  const timestamp = new Date().toISOString();
  const chat: Chat = {
    config: {
      id: chatId,
      name: "Busy chat",
      workspaceId: "workspace-1",
      scope: "workspace",
      directory: "/workspace",
      model: { providerID: "test-provider", modelID: "test-model", variant: "" },
      useWorktree: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      mode: "chat",
    },
    state: {
      ...createInitialChatState(chatId),
      status: "streaming",
    },
  };

  const firstSummary = deferred<Chat | null>();
  const secondSummary = deferred<Chat | null>();
  let signalSecondSummaryRequested!: () => void;
  const secondSummaryRequested = new Promise<void>((resolve) => {
    signalSecondSummaryRequested = resolve;
  });
  let summaryRequestCount = 0;
  // The wait operation only reads these two state-port methods in this focused boundary test.
  const state = {
    getChat: async () => chat,
    getChatSummary: () => {
      summaryRequestCount += 1;
      if (summaryRequestCount === 1) {
        return firstSummary.promise;
      }
      signalSecondSummaryRequested();
      return secondSummary.promise;
    },
  } as unknown as ChatStatePort;
  const service = new ChatConversationService({
    state,
    session: {} as ChatSessionPort,
    worktree: {} as ChatWorktreePort,
  });

  const startedAt = Date.now();
  let outcome: "resolved" | "rejected" | undefined;
  const settled = service.waitForChatIdle(chatId).then(
    () => {
      outcome = "resolved";
    },
    () => {
      outcome = "rejected";
    },
  );

  jest.setSystemTime(startedAt + 330_001);
  firstSummary.resolve(chat);
  await Promise.resolve();
  await Promise.resolve();
  expect(outcome).toBeUndefined();

  jest.advanceTimersByTime(100);
  await secondSummaryRequested;
  jest.setSystemTime(startedAt + 900_001);
  secondSummary.resolve(chat);
  await settled;
  expect(outcome).toBe("rejected");
});
