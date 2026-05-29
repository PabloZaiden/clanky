import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";

import {
  setupTestContext,
  teardownTestContext,
  type TestContext,
} from "../setup";

describe("GitService diff", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestContext({ initGit: true });
  });

  afterEach(async () => {
    await teardownTestContext(ctx);
  });

  test("falls back from a missing remote base ref to the local branch", async () => {
    const currentBranch = (await Bun.$`git -C ${ctx.workDir} branch --show-current`.text()).trim();
    await Bun.write(join(ctx.workDir, ".gitkeep"), "<h1>Hello world</h1>\n");

    const diff = await ctx.git.getDiffWithContent(ctx.workDir, `origin/${currentBranch}`);

    expect(diff).toHaveLength(1);
    expect(diff[0]?.path).toBe(".gitkeep");
    expect(diff[0]?.status).toBe("modified");
    expect(diff[0]?.patch).toContain("+<h1>Hello world</h1>");
  });
});
