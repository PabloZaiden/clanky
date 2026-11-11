import { cp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { checkPagesSize, renderPagesChooser } from "../src/pages-site";

const [stablePath, latestPath, ...extra] = process.argv.slice(2);
if (!stablePath || !latestPath || extra.length) {
  throw new Error("Usage: bun scripts/assemble-pages.ts stable-snapshot latest-snapshot");
}
const outdir = resolve("dist/pages");
const infoSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  version: z.string().min(1),
  update: z.object({
    manifest: z.literal("frontend-update.json"),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
const snapshots = await Promise.all([stablePath, latestPath].map(async path => {
  const root = resolve(path);
  if (root === outdir || root.startsWith(`${outdir}/`) || outdir.startsWith(`${root}/`)) {
    throw new Error("Pages input snapshots must not contain or be inside the combined output directory.");
  }
  const info = infoSchema.parse(await Bun.file(join(root, "build-info.json")).json());
  const manifest = await Bun.file(join(root, info.update.manifest)).arrayBuffer();
  if (manifest.byteLength !== info.update.bytes
    || new Bun.CryptoHasher("sha256").update(manifest).digest("hex") !== info.update.sha256) {
    throw new Error(`Pages snapshot failed manifest integrity verification: ${root}`);
  }
  return { root, info };
}));
const [stable, latest] = snapshots;
if (!stable || !latest || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(stable.info.version)) {
  throw new Error("The stable Pages snapshot must have a stable release version.");
}
await rm(outdir, { recursive: true, force: true });
await cp(stable.root, join(outdir, "stable"), { recursive: true, errorOnExist: true, force: false });
await cp(latest.root, join(outdir, "latest"), { recursive: true, errorOnExist: true, force: false });
await cp(join(stable.root, "favicon.svg"), join(outdir, "favicon.svg"));
await cp(resolve("assets/privacy"), join(outdir, "privacy"), { recursive: true, errorOnExist: true, force: false });
await Bun.write(join(outdir, "index.html"), renderPagesChooser({
  prompt: "Choose a frontend channel.",
  navigation: "Frontend channels",
  choices: [
    { href: "./stable/", label: "Stable", description: `Latest release: ${stable.info.version}` },
    { href: "./latest/", label: "Latest", description: `Main build: ${latest.info.version}` },
  ],
}));
await checkPagesSize(outdir);
