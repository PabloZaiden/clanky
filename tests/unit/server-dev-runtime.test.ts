import { describe, expect, test } from "bun:test";
import { isWebBundleReady } from "../../apps/server/src/dev-runtime";

describe("isWebBundleReady", () => {
  test("requires index.html plus built javascript and css assets", () => {
    expect(isWebBundleReady([
      "index.html",
      "chunk-abcd1234.js",
      "chunk-abcd1234.css",
      "favicon-32x32.png",
    ])).toBe(true);
  });

  test("returns false while the bundle is incomplete", () => {
    expect(isWebBundleReady(["index.html", "chunk-abcd1234.js"])).toBe(false);
    expect(isWebBundleReady(["index.html", "chunk-abcd1234.css"])).toBe(false);
    expect(isWebBundleReady(["chunk-abcd1234.js", "chunk-abcd1234.css"])).toBe(false);
  });
});
