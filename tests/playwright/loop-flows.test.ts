import { expect, test } from "bun:test";
import type { Page } from "playwright";

import { waitForCondition, waitForVisible, withBrowserTest } from "./support/browser-test";

async function openNewLoop(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/#/new/loop`);
  await waitForVisible(page.getByRole("heading", { name: "Start a new loop" }));
}

async function selectWorkspace(page: Page, workspaceId: string): Promise<void> {
  await page.locator("#workspace").selectOption(workspaceId);
}

async function fillLoopBasics(page: Page, title: string, prompt: string): Promise<void> {
  await page.locator("#name").fill(title);
  await page.locator("#prompt").fill(prompt);
}

async function setPlanMode(page: Page, enabled: boolean): Promise<void> {
  const planMode = page.getByRole("checkbox", { name: /Plan Mode/i });
  if ((await planMode.isChecked()) !== enabled) {
    if (enabled) {
      await planMode.check();
    } else {
      await planMode.uncheck();
    }
  }
}

async function waitForLoopId(
  app: Awaited<ReturnType<typeof import("./support/test-app.js").startTestApp>>,
  loopName: string,
): Promise<string> {
  const loopId = await waitForCondition(
    async () => {
      const loops = await app.listLoops();
      return loops.find((loop: { config: { name: string; id: string } }) => loop.config.name === loopName)?.config.id ?? null;
    },
    (value) => typeof value === "string" && value.length > 0,
    `loop ${loopName}`,
  );
  return loopId;
}

test("creates a draft loop, edits it, and starts it", async () => {
  await withBrowserTest(async ({ app, page }) => {
    const repo = await app.createGitRepository("draft-loop-browser");
    const workspace = await app.createWorkspace({
      name: "Draft Browser Workspace",
      directory: repo.directory,
    });

    await openNewLoop(page, app.baseUrl);
    await selectWorkspace(page, workspace.id);
    await fillLoopBasics(page, "Draft Browser Loop", "Draft the browser flow before execution.");
    await setPlanMode(page, false);
    await page.getByRole("button", { name: "Save as Draft" }).click();

    const draftLoopId = await waitForLoopId(app, "Draft Browser Loop");
    await page.goto(`${app.baseUrl}/#/loop/${draftLoopId}`);
    await waitForVisible(page.getByRole("heading", { name: "Edit Draft Browser Loop" }));

    await page.locator("#name").fill("Updated Draft Browser Loop");
    await page.locator("#prompt").fill("Draft the browser flow and then execute it.");
    await page.getByRole("button", { name: "Update" }).click();

    const updatedName = await waitForCondition(
      async () => (await app.getLoop(draftLoopId)).config.name,
      (value) => value === "Updated Draft Browser Loop",
      "draft update to persist",
    );
    expect(updatedName).toBe("Updated Draft Browser Loop");

    await page.getByRole("button", { name: "Start" }).click();

    const status = await waitForCondition(
      async () => (await app.getLoop(draftLoopId)).state.status,
      (value) => value === "completed",
      "draft loop completion",
      30_000,
    );
    expect(status).toBe("completed");
    await waitForVisible(page.locator("header").getByText("Completed"));
  });
});

test("creates a loop in plan mode and accepts the generated plan", async () => {
  await withBrowserTest(async ({ app, page }) => {
    const repo = await app.createGitRepository("plan-loop-browser");
    const workspace = await app.createWorkspace({
      name: "Plan Browser Workspace",
      directory: repo.directory,
    });

    await openNewLoop(page, app.baseUrl);
    await selectWorkspace(page, workspace.id);
    await fillLoopBasics(page, "Plan Browser Loop", "Create a detailed plan for this browser flow.");
    await setPlanMode(page, true);
    await page.getByRole("button", { name: "Create" }).click();

    const loopId = await waitForLoopId(app, "Plan Browser Loop");
    const planReady = await waitForCondition(
      async () => (await app.getLoop(loopId)).state.planMode?.isPlanReady ?? false,
      (value) => value === true,
      "plan readiness",
      30_000,
    );
    expect(planReady).toBe(true);

    await page.goto(`${app.baseUrl}/#/loop/${loopId}`);
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await waitForVisible(page.getByRole("heading", { name: "Status" }));

    await page.getByRole("button", { name: "Actions", exact: true }).click();
    const acceptPlanButton = page.getByRole("button", { name: /Accept Plan & Start Loop/i });
    await waitForVisible(acceptPlanButton);
    await waitForCondition(
      async () => await acceptPlanButton.isEnabled(),
      (value) => value === true,
      "accept plan button to become enabled",
    );
    await acceptPlanButton.click();

    const status = await waitForCondition(
      async () => (await app.getLoop(loopId)).state.status,
      (value) => value === "completed",
      "accepted plan completion",
      30_000,
    );
    expect(status).toBe("completed");
    await waitForVisible(page.locator("header").getByText("Completed"));
  });
});

test("executes a loop and shows streamed log content in the browser", async () => {
  await withBrowserTest(async ({ app, page }) => {
    const repo = await app.createGitRepository("log-loop-browser");
    const workspace = await app.createWorkspace({
      name: "Log Browser Workspace",
      directory: repo.directory,
    });

    await openNewLoop(page, app.baseUrl);
    await selectWorkspace(page, workspace.id);
    await fillLoopBasics(page, "Log Browser Loop", "Original Goal: validate how execution logs behave in the browser.");
    await setPlanMode(page, false);
    await page.getByRole("button", { name: "Create" }).click();

    const loopId = await waitForLoopId(app, "Log Browser Loop");
    await page.goto(`${app.baseUrl}/#/loop/${loopId}`);
    await page.getByRole("button", { name: "Log", exact: true }).click();

    const logCount = await waitForCondition(
      async () => (await app.getLoop(loopId)).state.logs.length,
      (value) => value > 0,
      "loop logs to appear",
      30_000,
    );
    expect(logCount).toBeGreaterThan(0);
    await waitForVisible(page.getByText(/Mock ACP is streaming a realistic looking response/i));

    const status = await waitForCondition(
      async () => (await app.getLoop(loopId)).state.status,
      (value) => value === "completed",
      "log loop completion",
      30_000,
    );
    expect(status).toBe("completed");
    await waitForVisible(page.getByText(/The requested work is complete/i));
  });
});
