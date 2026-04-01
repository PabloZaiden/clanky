import { expect, test } from "bun:test";
import type { Page } from "playwright";

import { waitForCondition, waitForVisible, withBrowserTest } from "./support/browser-test";

async function openNewChat(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/#/new/chat`);
  await waitForVisible(page.getByRole("heading", { name: /Start a new chat/i }));
}

async function waitForChatId(
  app: Awaited<ReturnType<typeof import("./support/test-app.js").startTestApp>>,
  chatName: string,
): Promise<string> {
  return await waitForCondition(
    async () => {
      const chats = await app.listChats();
      return chats.find((chat: { config: { name: string; id: string } }) => chat.config.name === chatName)?.config.id ?? null;
    },
    (value) => typeof value === "string" && value.length > 0,
    `chat ${chatName}`,
  );
}

async function waitForChatToIdle(
  app: Awaited<ReturnType<typeof import("./support/test-app.js").startTestApp>>,
  chatId: string,
): Promise<void> {
  const status = await waitForCondition(
    async () => (await app.getChat(chatId)).state.status,
    (value) => value === "idle",
    "chat to become idle",
    30_000,
  );
  expect(status).toBe("idle");
}

async function waitForSshSessionId(
  app: Awaited<ReturnType<typeof import("./support/test-app.js").startTestApp>>,
  workspaceId: string,
): Promise<string> {
  return await waitForCondition(
    async () => {
      const sessions = await app.listSshSessions();
      return sessions.find((session: { config: { workspaceId: string; id: string } }) => session.config.workspaceId === workspaceId)?.config.id ?? null;
    },
    (value) => typeof value === "string" && value.length > 0,
    `ssh session for workspace ${workspaceId}`,
  );
}

test("creates a chat and supports multiple back-and-forth messages", async () => {
  await withBrowserTest(async ({ app, page }) => {
    const repo = await app.createGitRepository("chat-browser");
    const workspace = await app.createWorkspace({
      name: "Chat Browser Workspace",
      directory: repo.directory,
    });

    await openNewChat(page, app.baseUrl);
    await page.getByLabel("Name").fill("Browser Chat Session");
    await page.locator("#chat-workspace").selectOption(workspace.id);
    await page.getByRole("button", { name: "Create chat" }).click();

    const chatId = await waitForChatId(app, "Browser Chat Session");
    await page.waitForURL(new RegExp(`#\\/chat\\/${chatId}$`));

    await page.getByLabel("Message").fill("Summarize the current repository state.");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForChatToIdle(app, chatId);
    await waitForVisible(page.getByText("Summarize the current repository state."));
    await waitForVisible(page.getByText(/Mock ACP is streaming a realistic looking response/i));

    await page.getByLabel("Message").fill("Now confirm that the browser can continue the same conversation.");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForChatToIdle(app, chatId);
    await waitForVisible(page.getByText("Now confirm that the browser can continue the same conversation."));

    const messageCount = await waitForCondition(
      async () => (await app.getChat(chatId)).state.messages.length,
      (value) => value > 2,
      "chat message count to grow",
      30_000,
    );
    expect(messageCount).toBeGreaterThan(2);
  });
});

test("shows reasoning during streaming and keeps the final assistant answer visible", async () => {
  await withBrowserTest(async ({ app, page }) => {
    const repo = await app.createGitRepository("chat-streaming-browser");
    const workspace = await app.createWorkspace({
      name: "Chat Streaming Workspace",
      directory: repo.directory,
    });

    await openNewChat(page, app.baseUrl);
    await page.getByLabel("Name").fill("Streaming Chat Session");
    await page.locator("#chat-workspace").selectOption(workspace.id);
    await page.getByRole("button", { name: "Create chat" }).click();

    const chatId = await waitForChatId(app, "Streaming Chat Session");
    await page.waitForURL(new RegExp(`#\\/chat\\/${chatId}$`));

    await page.getByLabel("Message").fill("Please stream a response with reasoning.");
    await page.getByRole("button", { name: "Send" }).click();

    const reasoningContent = await waitForCondition(
      async () => {
        const chat = await app.getChat(chatId);
        if (chat.state.status !== "streaming") {
          return null;
        }
        return chat.state.logs.find((log: { details?: Record<string, unknown> }) =>
          log.details?.["logKind"] === "reasoning")?.details?.["responseContent"] ?? null;
      },
      (value) => typeof value === "string" && value.length > 0,
      "reasoning log content while streaming",
      30_000,
    );

    expect(typeof reasoningContent).toBe("string");
    await waitForVisible(page.getByText(new RegExp(String(reasoningContent).slice(0, 12), "i")));

    await waitForChatToIdle(app, chatId);
    await waitForVisible(page.getByText(/Mock ACP is streaming a realistic looking response/i));
  });
});

test("creates an SSH session and surfaces terminal connection errors in the route", async () => {
  await withBrowserTest(async ({ app, page }) => {
    const repo = await app.createGitRepository("ssh-browser");
    const workspace = await app.createWorkspace({
      name: "SSH Browser Workspace",
      directory: repo.directory,
      transport: "ssh",
    });

    await page.goto(`${app.baseUrl}/#/new/ssh-session`);
    await waitForVisible(page.getByRole("heading", { name: "Create an SSH session" }));
    await page.locator("#ssh-target-type").selectOption("workspace");
    await page.locator("#workspace").selectOption(workspace.id);
    await page.locator("#ssh-connection-mode").selectOption("direct");
    await page.getByRole("button", { name: "Create SSH Session" }).click();

    const sessionId = await waitForSshSessionId(app, workspace.id);
    await page.waitForURL(new RegExp(`#\\/ssh\\/${sessionId}$`));

    const status = await waitForCondition(
      async () => (await app.getSshSession(sessionId)).state.status,
      (value) => value === "failed",
      "ssh session to fail cleanly",
      30_000,
    );
    expect(status).toBe("failed");
    await waitForVisible(page.getByText("Error: SSH terminal is not connected").first());
    await waitForVisible(page.getByText(/Direct SSH/i));
  });
});
