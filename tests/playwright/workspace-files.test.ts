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
    await waitForVisible(page.getByText("src/index.ts"));

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
