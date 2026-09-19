import { describe, expect, test } from "bun:test";

import {
  generateChatName,
  generateTaskName,
  type BackendInterface,
} from "../../src/utils/name-generator";
import type { AgentResponse, PromptInput } from "../../src/backends/types";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

class PendingNameBackend implements BackendInterface {
  readonly response = createDeferred<AgentResponse>();

  async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
    return await this.response.promise;
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

describe("name generation cancellation", () => {
  test("waits for task-session cancellation before returning a timeout", async () => {
    const backend = new PendingNameBackend();
    let signalCancellationStarted!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => {
      signalCancellationStarted = resolve;
    });
    let releaseCancellation!: () => void;
    const cancellationSettled = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let settled = false;

    const operation = generateTaskName({
      prompt: "Keep the task prompt pending",
      backend,
      sessionId: "task-name-session",
      timeoutMs: 0,
      cancelSession: async () => {
        signalCancellationStarted();
        await cancellationSettled;
      },
    });
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await cancellationStarted;
    await flushMicrotasks();
    expect(settled).toBe(false);

    releaseCancellation();
    await expect(operation).rejects.toBeInstanceOf(Error);

    backend.response.reject(new Error("late task name failure"));
  });

  test("preserves sanitized task output through the shared operation", async () => {
    const backend: BackendInterface = {
      sendPrompt: async () => ({
        id: "task-name-response",
        content: "  **Deploy   feature**  ",
        parts: [{ type: "text", text: "  **Deploy   feature**  " }],
      }),
    };

    await expect(generateTaskName({
      prompt: "Deploy the feature",
      backend,
      sessionId: "task-name-session",
    })).resolves.toBe("Deploy feature");
  });

  test("preserves cancellation failure context on timeout", async () => {
    const backend = new PendingNameBackend();

    const operation = generateTaskName({
      prompt: "Cancel this task title request",
      backend,
      sessionId: "task-name-session",
      timeoutMs: 0,
      cancelSession: async () => {
        throw new Error("cancellation failed");
      },
    });

    await expect(operation).rejects.toMatchObject({
      cause: expect.any(Error),
    });
    backend.response.resolve({
      id: "late-task-name-response",
      content: "Late task title",
      parts: [{ type: "text", text: "Late task title" }],
    });
  });

  test("waits for chat-session cancellation before returning a timeout", async () => {
    const backend = new PendingNameBackend();
    let signalCancellationStarted!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => {
      signalCancellationStarted = resolve;
    });
    let releaseCancellation!: () => void;
    const cancellationSettled = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let settled = false;

    const operation = generateChatName({
      message: "Keep the chat message pending",
      backend,
      sessionId: "chat-name-session",
      timeoutMs: 0,
      cancelSession: async () => {
        signalCancellationStarted();
        await cancellationSettled;
      },
    });
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await cancellationStarted;
    await flushMicrotasks();
    expect(settled).toBe(false);

    releaseCancellation();
    await expect(operation).rejects.toBeInstanceOf(Error);

    backend.response.resolve({
      id: "late-chat-name-response",
      content: "Late chat name",
      parts: [{ type: "text", text: "Late chat name" }],
    });
  });

  test("rejects an unusable chat response after sanitization", async () => {
    const backend: BackendInterface = {
      sendPrompt: async () => ({
        id: "chat-name-response",
        content: "###",
        parts: [{ type: "text", text: "###" }],
      }),
    };

    await expect(generateChatName({
      message: "Name this chat",
      backend,
      sessionId: "chat-name-session",
    })).rejects.toBeInstanceOf(Error);
  });
});
