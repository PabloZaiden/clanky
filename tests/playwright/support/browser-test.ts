import { chromium, type Locator, type Page } from "playwright";

import { startTestApp } from "./test-app.js";

export type BrowserTestContext = {
  app: Awaited<ReturnType<typeof startTestApp>>;
  page: Page;
};

export async function withBrowserTest(
  callback: (context: BrowserTestContext) => Promise<void>,
): Promise<void> {
  const app = await startTestApp(process.cwd());
  const browser = await chromium.launch({
    headless: process.env["PLAYWRIGHT_HEADLESS"] !== "false",
  });
  const context = await browser.newContext({
    viewport: {
      width: 1440,
      height: 960,
    },
  });
  const page = await context.newPage();

  try {
    await callback({ app, page });
  } finally {
    const teardownErrors: unknown[] = [];
    for (const closeResource of [
      async () => await page.close(),
      async () => await context.close(),
      async () => await browser.close(),
      async () => await app.stop(),
    ]) {
      try {
        await closeResource();
      } catch (error) {
        teardownErrors.push(error);
      }
    }
    if (teardownErrors.length > 0) {
      throw teardownErrors[0];
    }
  }
}

export async function waitForCondition<T>(
  readValue: () => Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
  timeoutMs = 20_000,
): Promise<T> {
  const startTime = Date.now();
  let lastValue: T | undefined;

  while (Date.now() - startTime < timeoutMs) {
    lastValue = await readValue();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for ${description}. Last value: ${JSON.stringify(lastValue)}`);
}

export async function waitForVisible(locator: Locator): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 20_000 });
}
