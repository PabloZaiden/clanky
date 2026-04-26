import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { serveWebApp } from "../../src/server";

describe("serveWebApp", () => {
  const originalWebDistDir = process.env["RALPHER_WEB_DIST_DIR"];
  let webDistDir = "";

  beforeEach(async () => {
    webDistDir = await mkdtemp(join(tmpdir(), "ralpher-web-dist-"));
    process.env["RALPHER_WEB_DIST_DIR"] = webDistDir;
  });

  afterEach(async () => {
    await rm(webDistDir, { recursive: true, force: true });

    if (originalWebDistDir === undefined) {
      delete process.env["RALPHER_WEB_DIST_DIR"];
      return;
    }

    process.env["RALPHER_WEB_DIST_DIR"] = originalWebDistDir;
  });

  test("returns 400 for malformed percent-encoded SPA paths", async () => {
    const response = await serveWebApp(new Request("http://example.com/%E0%A4%A"));
    if (!(response instanceof Response)) {
      throw new Error("Expected serveWebApp to return a Response when serving a configured web dist.");
    }

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Malformed request path");
  });
});
