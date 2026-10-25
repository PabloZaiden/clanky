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

await Bun.write(join(outdir, "build-info.json"), `${JSON.stringify({
  revision,
  version: CLANKY_VERSION,
  builtAt: new Date().toISOString(),
}, null, 2)}\n`);
await Bun.write(join(outdir, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark light">
    <title>Clanky clients</title>
  </head>
  <body>
    <h1>Clanky clients</h1>
    <ul>
      <li><a href="./api/">Connect to an API</a></li>
      <li><a href="./collaboration/">Connect through collaboration</a></li>
    </ul>
    <p>Build: <a href="https://github.com/PabloZaiden/clanky/commit/${revision}">${revision.slice(0, 7)}</a></p>
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
