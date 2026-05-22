import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import index from "../../src/index.html";
import { getWebAppRoute, serveWebApp } from "../../src/server";

describe("serveWebApp", () => {
  const originalWebDistDir = process.env["CLANKY_WEB_DIST_DIR"];
  let webDistDir = "";

  beforeEach(async () => {
    webDistDir = await mkdtemp(join(tmpdir(), "clanky-web-dist-"));
    process.env["CLANKY_WEB_DIST_DIR"] = webDistDir;
  });

  afterEach(async () => {
    await rm(webDistDir, { recursive: true, force: true });

    if (originalWebDistDir === undefined) {
      delete process.env["CLANKY_WEB_DIST_DIR"];
      return;
    }

    process.env["CLANKY_WEB_DIST_DIR"] = originalWebDistDir;
  });

  test("uses Bun's HTML bundle route when no web dist is configured", () => {
    delete process.env["CLANKY_WEB_DIST_DIR"];

    expect(getWebAppRoute()).toBe(index);
  });

  test("uses the dist-serving handler when a web dist is configured", () => {
    expect(getWebAppRoute()).toBe(serveWebApp);
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
