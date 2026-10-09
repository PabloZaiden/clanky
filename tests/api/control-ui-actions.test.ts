/**
 * HTTP scenarios for transient UI actions initiated by control chats.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type { ControlUiActionEvent } from "@/shared/clanky-control";
import { chatEventEmitter } from "../../src/core/event-emitter";
import { getCurrentBranch, initializeGitRepository } from "../helpers/git-fixtures";
import { pollUntil } from "../helpers/polling";
import { serveNativeApiRoutes } from "../native-api-server";
import {
  fetchTestLocalExecutionHost,
  setupTestContext,
  teardownTestContext,
  testOwnerUser,
  testWorkspaceId,
  type TestContext,
} from "../setup";

const controlModel = { providerID: "copilot", modelID: "gpt-5.5", variant: "" };

const otherUser: CurrentUser = {
  id: "control-action-other-user",
  username: "other-user",
  role: "user",
  isOwner: false,
  isAdmin: false,
};

describe("Control UI actions API", () => {
  let context: TestContext | null = null;
  let server: Server<unknown> | null = null;
  let otherUserServer: Server<unknown> | null = null;
  let baseUrl = "";
  let otherUserBaseUrl = "";
  let temporaryWorkspaceDirectories: string[] = [];

  beforeEach(async () => {
    context = await setupTestContext({ useMockBackend: false, initGit: true });
    server = serveNativeApiRoutes();
    otherUserServer = serveNativeApiRoutes({ user: otherUser });
    baseUrl = server.url.toString().replace(/\/$/, "");
    otherUserBaseUrl = otherUserServer.url.toString().replace(/\/$/, "");
    temporaryWorkspaceDirectories = [];
  });

  afterEach(async () => {
    server?.stop();
    otherUserServer?.stop();
    for (const directory of temporaryWorkspaceDirectories) {
      await rm(directory, { recursive: true, force: true });
    }
    if (context) {
      await teardownTestContext(context);
    }
  });

  async function createWorkspace(name: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "clanky-control-action-workspace-"));
    temporaryWorkspaceDirectories.push(directory);
    await initializeGitRepository(directory, { initialCommit: "readme" });
    const executionHost = await fetchTestLocalExecutionHost(baseUrl);
    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        directory,
        executionHost,
        serverSettings: { agent: { adapter: "acp", provider: "opencode" } },
      }),
    });
    expect(response.status).toBe(201);
    const workspace = await response.json() as { id: string };
    return workspace.id;
  }

  async function setQuickChatWorkspace(workspaceId: string): Promise<void> {
    const response = await fetch(`${baseUrl}/api/preferences/quick-chat`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        model: controlModel,
        useWorktree: false,
      }),
    });
    expect(response.status).toBe(200);
  }

  async function createChat(workspaceId: string): Promise<string> {
    if (!context) {
      throw new Error("Test context is unavailable");
    }
    const response = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Control action test chat",
        workspaceId,
        model: controlModel,
        useWorktree: false,
        baseBranch: await getCurrentBranch(context.workDir),
      }),
    });
    expect(response.status).toBe(201);
    const chat = await response.json() as { config: { id: string } };
    return chat.config.id;
  }

  function actionRequest(chatId: string, clientId: string, turnId: string, workspaceId: string) {
    return {
      chatId,
      clientId,
      turnId,
      action: { type: "open_workspace", workspaceId },
    };
  }

  test("dispatches and acknowledges over HTTP while rejecting foreign and ineligible chats", async () => {
    const targetWorkspaceId = await createWorkspace("Control action target");
    await setQuickChatWorkspace(testWorkspaceId);
    const chatId = await createChat(testWorkspaceId);
    const action = { type: "open_workspace", workspaceId: targetWorkspaceId } as const;
    const clientId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const actionEvents: ControlUiActionEvent[] = [];

    // The native route harness supplies an authenticated user context; the declared framework policy is tested separately.
    const unsubscribe = chatEventEmitter.subscribe((event, eventContext) => {
      if (
        event.type === "control.ui_action"
        && eventContext.userId === testOwnerUser.id
        && event.chatId === chatId
        && event.clientId === clientId
      ) {
        actionEvents.push(event);
      }
    });
    const dispatchController = new AbortController();
    let earlyDispatchResponse: Response | null = null;
    const dispatchResponsePromise = fetch(`${baseUrl}/api/control/ui-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, clientId, turnId, action }),
      signal: dispatchController.signal,
    }).then((response) => {
      earlyDispatchResponse = response;
      return response;
    });

    try {
      const eventOrResponse = await pollUntil(
        () => actionEvents[0] ?? earlyDispatchResponse ?? undefined,
        (observed): observed is ControlUiActionEvent | Response => observed !== undefined,
        {
          description: "control UI action event",
          timeoutMs: 5_000,
          formatLastObserved: (observed) => observed instanceof Response
            ? `dispatch returned HTTP ${observed.status}`
            : observed ? `actionId=${observed.actionId}` : "not emitted",
        },
      );
      if (eventOrResponse instanceof Response) {
        throw new Error(
          `Control action dispatch returned HTTP ${eventOrResponse.status}: ${await eventOrResponse.clone().text()}`,
        );
      }
      const actionEvent = eventOrResponse;

      const foreignAcknowledgement = await fetch(
        `${otherUserBaseUrl}/api/control/ui-actions/${actionEvent.actionId}/ack`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId,
            chatId,
            turnId,
            outcome: { status: "opened", action },
          }),
        },
      );
      expect(foreignAcknowledgement.status).toBe(404);
      expect((await foreignAcknowledgement.json()).error).toBe("control_action_not_found");

      const acknowledgement = await fetch(
        `${baseUrl}/api/control/ui-actions/${actionEvent.actionId}/ack`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId,
            chatId,
            turnId,
            outcome: { status: "opened", action },
          }),
        },
      );
      expect(acknowledgement.status).toBe(200);
      expect(await acknowledgement.json()).toMatchObject({ accepted: true });

      const dispatchResponse = await dispatchResponsePromise;
      expect(dispatchResponse.status).toBe(200);
      expect(await dispatchResponse.json()).toMatchObject({
        actionId: actionEvent.actionId,
        outcome: { status: "opened", action },
      });
    } finally {
      unsubscribe();
      dispatchController.abort();
      await dispatchResponsePromise.catch(() => undefined);
    }

    const foreignDispatch = await fetch(`${otherUserBaseUrl}/api/control/ui-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actionRequest(chatId, crypto.randomUUID(), crypto.randomUUID(), targetWorkspaceId)),
    });
    expect(foreignDispatch.status).toBe(404);
    expect((await foreignDispatch.json()).error).toBe("not_found");

    await setQuickChatWorkspace(targetWorkspaceId);
    const ineligibleChatDispatch = await fetch(`${baseUrl}/api/control/ui-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actionRequest(chatId, crypto.randomUUID(), crypto.randomUUID(), targetWorkspaceId)),
    });
    expect(ineligibleChatDispatch.status).toBe(403);
    expect((await ineligibleChatDispatch.json()).error).toBe("control_chat_required");

    await setQuickChatWorkspace(testWorkspaceId);
    const missingTargetDispatch = await fetch(`${baseUrl}/api/control/ui-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actionRequest(chatId, crypto.randomUUID(), crypto.randomUUID(), "missing-workspace")),
    });
    expect(missingTargetDispatch.status).toBe(404);
    expect((await missingTargetDispatch.json()).error).toBe("workspace_not_found");
  });
});
