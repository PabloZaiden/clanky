/**
 * Data-safety contract for concurrent chat metadata mutations.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { ChatManager } from "../../src/core/chat-manager";
import { ChatStateService } from "../../src/core/chat-state-service";
import type { HarnessConversationBinding } from "../../src/shared/harness-control";
import type { HarnessQuestionRequest } from "../../src/shared/harness-questions";
import { runWithCurrentUser } from "../../src/context/user-context";
import {
  setupTestContext,
  teardownTestContext,
  testModelFields,
  testOwnerUser,
  testWorkspaceId,
} from "../setup";

let context: Awaited<ReturnType<typeof setupTestContext>>;

beforeEach(async () => {
  context = await setupTestContext({ initGit: true });
});

afterEach(async () => {
  await teardownTestContext(context);
});

// HTTP cannot deterministically select the read/write microtask window. Protect
// the public atomic mutation contract with real SQLite, without scheduling
// hooks, mocked storage, or assertions about the queue implementation.
test("atomic chat state mutations preserve waiting and uncertain answers", async () => {
  await runWithCurrentUser(testOwnerUser, async () => {
    const chat = await new ChatManager().createChat({
      name: "Uncertain answer race",
      workspaceId: testWorkspaceId,
      useWorktree: false,
      ...testModelFields,
    });
    const state = new ChatStateService();
    const binding: HarnessConversationBinding = {
      adapter: "copilot", nativeId: "owned-conversation", ownerId: testOwnerUser.id,
      contextId: chat.config.id, directory: context.workDir, executionHost: context.executionHostBinding,
      questionPolicy: "interactive",
    };
    const question: HarnessQuestionRequest = {
      requestId: "pending-answer", conversation: binding,
      scope: { kind: "unknown", native: { adapter: "copilot", conversationId: binding.nativeId } },
      questions: [{ header: "Color", question: "Choose a color", options: [{ label: "Blue", description: "" }], custom: true }],
      blocking: true, status: "submitting", answers: [["Blue"]], createdAt: new Date().toISOString(),
    };
    await state.updateState(chat, {
      ...chat.state, status: "reconnecting", startupStage: "connecting_provider",
      session: { id: binding.nativeId, binding }, harness: { questions: [question] },
    });

    await Promise.all([
      state.mutateState(chat.config.id, (current) => ({
        ...current.state, status: "waiting", startupStage: undefined,
      })),
      state.mutateState(chat.config.id, (current) => ({
        ...current.state,
        harness: { ...current.state.harness, questions: current.state.harness!.questions!.map((request) =>
          request.requestId === question.requestId ? { ...request, status: "unconfirmed" } : request) },
      })),
    ]);

    const persisted = await state.getChat(chat.config.id);
    expect(persisted?.state.status).toBe("waiting");
    expect(persisted?.state.startupStage).toBeUndefined();
    expect(persisted?.state.harness?.questions).toEqual([{ ...question, status: "unconfirmed" }]);
  });
});
