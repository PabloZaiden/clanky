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
import { checkPagesSize, renderPagesChooser } from "./pages-site";
import { CLANKY_VERSION } from "./version";

const [version = CLANKY_VERSION, ...extra] = process.argv.slice(2);
if (extra.length || !version.trim()) {
  throw new Error("Usage: bun run build:pages [frontend-version]");
}
const outdir = resolve("dist/pages");
const revision = (process.env["GITHUB_SHA"] ?? await Bun.$`git rev-parse HEAD`.text()).trim();
if (!/^[a-f0-9]{40}$/.test(revision)) {
  throw new Error("Pages publishing requires a full Git commit SHA.");
}

await rm(outdir, { recursive: true, force: true });
const apiDirectory = join(outdir, "api");
await buildClient({ outdir: apiDirectory, clientMode: "remote", version });
const collaborationDirectory = join(outdir, "collaboration");
await cp(apiDirectory, collaborationDirectory, { recursive: true, errorOnExist: true, force: false });
const collaborationBootstrap: WebAppClientBootstrap = { mode: "external", version };
await Bun.write(
  join(collaborationDirectory, WEB_APP_CLIENT_CONFIG_PATH.slice(1)),
  JSON.stringify(collaborationBootstrap),
);
await cp(new URL("./favicon.svg", import.meta.url), join(outdir, "favicon.svg"));

await Bun.write(join(outdir, "index.html"), renderPagesChooser({
  prompt: "Choose how to connect.",
  navigation: "Client connections",
  choices: [
    { href: "./api/", label: "Connect to an API", description: "Use your own Clanky server." },
    { href: "./collaboration/", label: "Connect through collaboration", description: "Connect with a controller invitation." },
  ],
  revision,
}));

const paths = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: outdir, onlyFiles: true }))).sort();
const assets = [];
for (const path of paths) {
  const file = Bun.file(join(outdir, path));
  assets.push({
    path,
    bytes: file.size,
    sha256: new Bun.CryptoHasher("sha256").update(await file.arrayBuffer()).digest("hex"),
  });
}
const manifest = `${JSON.stringify({ revision, version, files: assets })}\n`;
await Bun.write(join(outdir, "frontend-update.json"), manifest);
await Bun.write(join(outdir, "build-info.json"), `${JSON.stringify({
  revision,
  version,
  builtAt: new Date().toISOString(),
  update: {
    manifest: "frontend-update.json",
    bytes: Buffer.byteLength(manifest),
    sha256: new Bun.CryptoHasher("sha256").update(manifest).digest("hex"),
  },
}, null, 2)}\n`);

await checkPagesSize(outdir);
console.log(`Revision: ${revision}`);
