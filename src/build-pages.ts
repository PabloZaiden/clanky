/**
 * Package both static client modes from one clean browser build for GitHub Pages.
 */

import { cp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  WEB_APP_CLIENT_CONFIG_PATH,
  type WebAppClientBootstrap,
} from "@pablozaiden/webapp/contracts";
import { buildClient } from "./build-client";
import { CLANKY_VERSION } from "./version";

const outdir = resolve("dist/pages");
const revision = (process.env["GITHUB_SHA"] ?? await Bun.$`git rev-parse HEAD`.text()).trim();
if (!/^[a-f0-9]{40}$/.test(revision)) {
  throw new Error("Pages publishing requires a full Git commit SHA.");
}

await rm(outdir, { recursive: true, force: true });
const apiDirectory = join(outdir, "api");
await buildClient({ outdir: apiDirectory, clientMode: "remote" });
const collaborationDirectory = join(outdir, "collaboration");
await cp(apiDirectory, collaborationDirectory, { recursive: true, errorOnExist: true, force: false });
const collaborationBootstrap: WebAppClientBootstrap = { mode: "external", version: CLANKY_VERSION };
await Bun.write(
  join(collaborationDirectory, WEB_APP_CLIENT_CONFIG_PATH.slice(1)),
  JSON.stringify(collaborationBootstrap),
);
await cp(new URL("./favicon.svg", import.meta.url), join(outdir, "favicon.svg"));

await Bun.write(join(outdir, "build-info.json"), `${JSON.stringify({
  revision,
  version: CLANKY_VERSION,
  builtAt: new Date().toISOString(),
}, null, 2)}\n`);
await Bun.write(join(outdir, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="color-scheme" content="dark light">
    <title>Clanky clients</title>
    <link rel="icon" href="./favicon.svg" type="image/svg+xml">
    <style>
      :root {
        color-scheme: dark;
        --background: #161616;
        --surface: #202020;
        --border: #383838;
        --text: #f5f5f5;
        --muted: #a3a3a3;
        --accent: #4ade80;
      }
      @media (prefers-color-scheme: light) {
        :root {
          color-scheme: light;
          --background: #f7f7f5;
          --surface: #ffffff;
          --border: #d4d4d4;
          --text: #191919;
          --muted: #595959;
          --accent: #15803d;
        }
      }
      * { box-sizing: border-box; }
      body {
        --page-padding: clamp(24px, 6vw, 64px);
        margin: 0;
        min-height: 100vh;
        min-height: 100svh;
        display: grid;
        place-items: center;
        padding: max(var(--page-padding), env(safe-area-inset-top, 0px)) max(var(--page-padding), env(safe-area-inset-right, 0px)) max(var(--page-padding), env(safe-area-inset-bottom, 0px)) max(var(--page-padding), env(safe-area-inset-left, 0px));
        background: var(--background);
        color: var(--text);
        font: 16px/1.5 system-ui, sans-serif;
      }
      main { width: min(100%, 480px); }
      header { display: flex; align-items: center; gap: 16px; }
      h1 { margin: 0; font-size: 28px; letter-spacing: -0.03em; }
      p { margin: 4px 0 0; color: var(--muted); }
      ul { display: grid; gap: 12px; margin: 32px 0; padding: 0; list-style: none; }
      a { color: inherit; }
      a:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
      .connection {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 4px 16px;
        padding: 20px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface);
        text-decoration: none;
      }
      .connection:hover { border-color: var(--accent); }
      .description { grid-column: 1; color: var(--muted); font-size: 14px; }
      .arrow { grid-column: 2; grid-row: 1 / 3; align-self: center; color: var(--accent); }
      footer { color: var(--muted); font-size: 13px; }
      footer a { text-underline-offset: 3px; }
      footer a:hover { color: var(--text); }
    </style>
  </head>
  <body>
    <main>
      <header>
        <img src="./favicon.svg" alt="" width="48" height="48">
        <div>
          <h1>Clanky</h1>
          <p>Choose how to connect.</p>
        </div>
      </header>
      <nav aria-label="Client connections">
        <ul>
          <li>
            <a class="connection" href="./api/">
              <strong>Connect to an API</strong>
              <span class="description">Use your own Clanky server.</span>
              <span class="arrow" aria-hidden="true">&rarr;</span>
            </a>
          </li>
          <li>
            <a class="connection" href="./collaboration/">
              <strong>Connect through collaboration</strong>
              <span class="description">Connect with a controller invitation.</span>
              <span class="arrow" aria-hidden="true">&rarr;</span>
            </a>
          </li>
        </ul>
      </nav>
      <footer>Build: <a href="https://github.com/PabloZaiden/clanky/commit/${revision}">${revision.slice(0, 7)}</a></footer>
    </main>
  </body>
</html>
`);

let bytes = 0;
let files = 0;
for await (const path of new Bun.Glob("**/*").scan({ cwd: outdir, absolute: true, onlyFiles: true })) {
  bytes += Bun.file(path).size;
  files++;
}
if (bytes > 1_000_000_000) {
  throw new Error(`Pages artifact exceeds the 1 GB site limit (${bytes} bytes).`);
}
console.log(`Pages: ${files} files, ${(bytes / 1_048_576).toFixed(1)} MiB, revision ${revision}`);
