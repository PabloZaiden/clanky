import { describe, expect, test } from "bun:test";
import { rewriteBuiltIndexHtml } from "../../apps/web/src/build-index-html";

describe("rewriteBuiltIndexHtml", () => {
  test("replaces the frontend entry placeholder with built asset references", () => {
    const sourceHtml = `<!doctype html>
<html>
  <body>
    <div id="root"></div>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>`;

    const rewrittenHtml = rewriteBuiltIndexHtml(sourceHtml, {
      entryScriptFileName: "frontend-abc123.js",
      stylesheetFileName: "frontend-abc123.css",
    });

    expect(rewrittenHtml).toContain(
      '    <link rel="stylesheet" href="./frontend-abc123.css" />',
    );
    expect(rewrittenHtml).toContain(
      '    <script type="module" src="./frontend-abc123.js"></script>',
    );
    expect(rewrittenHtml).not.toContain('./frontend.tsx');
  });

  test("throws when the frontend entry placeholder is missing", () => {
    const sourceHtml = `<!doctype html>
<html>
  <body>
    <div id="root"></div>
  </body>
</html>`;

    expect(() =>
      rewriteBuiltIndexHtml(sourceHtml, {
        entryScriptFileName: "frontend-abc123.js",
      }),
    ).toThrow("Web build could not replace the frontend entry script");
  });
});
