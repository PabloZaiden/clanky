import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "bun:test";

import { waitForCondition, waitForVisible, withBrowserTest } from "./support/browser-test";

test("opens the workspace file explorer and browses files", async () => {
  await withBrowserTest(async ({ app, page }) => {
    const repo = await app.createGitRepository("workspace-files-browser");
    await mkdir(`${repo.directory}/src`, { recursive: true });
    await writeFile(`${repo.directory}/src/index.ts`, "export const value = 1;\n");

    const workspace = await app.createWorkspace({
      name: "Workspace Files Browser",
      directory: repo.directory,
    });

    await page.goto(`${app.baseUrl}/#/workspace-files/${workspace.id}`);
    await waitForVisible(page.getByRole("heading", { name: "Workspace Files Browser editor" }));
    await page.getByRole("button", { name: "src" }).click();
    await waitForVisible(page.getByRole("button", { name: "index.ts" }));
    await page.getByRole("button", { name: "index.ts" }).click();
    await waitForVisible(page.getByRole("heading", { name: "src/index.ts" }));

    const readmeVisible = await waitForCondition(
      async () => await page.getByText("Select a file from the explorer to start editing.").count(),
      (value) => value === 0,
      "editor to switch away from empty state",
    );
    expect(readmeVisible).toBe(0);
  });
});

test("can re-expand the collapsed explorer on mobile", async () => {
  await withBrowserTest(async ({ app, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    const repo = await app.createGitRepository("workspace-files-mobile-browser");
    await mkdir(`${repo.directory}/src`, { recursive: true });
    await writeFile(`${repo.directory}/src/index.ts`, "export const mobileValue = 1;\n");

    const workspace = await app.createWorkspace({
      name: "Workspace Files Mobile Browser",
      directory: repo.directory,
    });

    await page.goto(`${app.baseUrl}/#/workspace-files/${workspace.id}`);
    await waitForVisible(page.getByRole("heading", { name: "Workspace Files Mobile Browser editor" }));
    await waitForVisible(page.getByRole("button", { name: "Collapse file explorer" }));

    await page.getByRole("button", { name: "Collapse file explorer" }).click();
    await waitForVisible(page.getByRole("button", { name: "Expand file explorer" }));
    await waitForVisible(page.getByRole("button", { name: "Files", exact: true }));
    await waitForVisible(page.getByRole("button", { name: "Terminals", exact: true }));

    await page.getByRole("button", { name: "Expand file explorer" }).click();
    await waitForVisible(page.getByRole("button", { name: "src" }));

    await page.getByRole("button", { name: "src" }).click();
    await waitForVisible(page.getByRole("button", { name: "index.ts" }));
  });
});

test("keeps the embedded terminal panel inside the visible explorer body", async () => {
  await withBrowserTest(async ({ app, page }) => {
    const repo = await app.createGitRepository("workspace-files-terminal-browser");
    const workspace = await app.createWorkspace({
      name: "Workspace Files Terminal Browser",
      directory: repo.directory,
      transport: "ssh",
    });

    await page.goto(`${app.baseUrl}/#/workspace-files/${workspace.id}`);
    await waitForVisible(page.getByRole("heading", { name: "Workspace Files Terminal Browser editor" }));

    await page.getByRole("button", { name: "Terminals" }).click();
    await waitForVisible(page.getByRole("heading", { name: "Integrated terminal" }));
    await page.getByRole("button", { name: "New terminal" }).click();

    await waitForCondition(
      async () => await app.listSshSessions(),
      (sessions) => sessions.some((session) => session.workspaceId === workspace.id),
      "workspace file explorer SSH session creation",
    );
    await waitForCondition(
      async () => await page.getByRole("combobox", { name: "Select workspace SSH session" }).inputValue(),
      (value) => value.length > 0,
      "workspace terminal selector to pick the created session",
    );

    const shellBody = page.getByTestId("workspace-shell-body");
    const terminalPanel = page
      .getByRole("heading", { name: "Integrated terminal" })
      .locator("xpath=ancestor::section[1]");

    const shellOverflowY = await shellBody.evaluate((element) => getComputedStyle(element).overflowY);
    expect(shellOverflowY).toBe("hidden");

    const shellBox = await shellBody.boundingBox();
    const terminalBox = await terminalPanel.boundingBox();

    expect(shellBox).not.toBeNull();
    expect(terminalBox).not.toBeNull();
    expect(terminalBox!.y + terminalBox!.height).toBeLessThanOrEqual(shellBox!.y + shellBox!.height + 1);
  });
});
