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
