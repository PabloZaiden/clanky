import { join } from "node:path";
import { z } from "zod";
import { github } from "./release-version";

const [input, tag, repository, revision, version, ...extra] = Bun.argv.slice(2);
if (!input || !tag || !repository || !revision || !version || extra.length
  || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)
  || !/^[a-f0-9]{40}$/.test(revision)
  || !/^\d+\.\d+\.\d+(?:-main-[0-9A-Za-z.-]+)?$/.test(version)
  || tag !== (version.includes("-main-") ? "latest" : `v${version}`)) {
  throw new Error("Usage: publish-linux-desktop <artifacts-dir> <tag> <owner/repo> <revision> <version>");
}

const files: string[] = [];
const expected = new Map<string, string>();
const platforms: Record<string, { url: string; signature: string }> = {};
const feedPath = join(input, "clanky-linux-desktop-update.json");
const hash = async (path: string) => {
  const digest = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) digest.update(chunk);
  return digest.digest("hex");
};
for (const [target, arch] of [["linux-x64", "x86_64"], ["linux-arm64", "aarch64"]] as const) {
  const filename = `Clanky-v${version}-${target}.AppImage`;
  const base = join(input, target, filename);
  const digest = await hash(base);
  if ((await Bun.file(`${base}.sha256`).text()).trim() !== `${digest}  ${filename}`) {
    throw new Error(`${filename} does not match its SHA-256 file.`);
  }
  const signature = (await Bun.file(`${base}.sig`).text()).trim();
  if (!signature || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new Error(`${filename} does not have a Tauri update signature.`);
  }
  const header = Buffer.from(await Bun.file(base).slice(0, 20).arrayBuffer());
  if (header.length !== 20 || header.readUInt32BE(0) !== 0x7f454c46
    || header.readUIntLE(8, 3) !== 0x024941 || header.readUInt16LE(18) !== (arch === "x86_64" ? 62 : 183)) {
    throw new Error(`${filename} is not a ${target} Type 2 AppImage.`);
  }
  for (const [path, name] of [[base, filename], [`${base}.sha256`, `${filename}.sha256`], [`${base}.sig`, `${filename}.sig`]] as const) {
    files.push(path);
    expected.set(name, `sha256:${path === base ? digest : await hash(path)}`);
  }
  platforms[`linux-${arch}`] = {
    url: `https://github.com/${repository}/releases/download/${tag}/${filename}`,
    signature,
  };
}
await Bun.write(feedPath, `${JSON.stringify({ version, platforms }, null, 2)}\n`);

if (process.env["CLANKY_RELEASE_VALIDATE_ONLY"] === "1") {
  console.log("Linux desktop release inputs verified.");
  process.exit(0);
}
if (tag === "latest") {
  const defaultBranch = await github(["api", `repos/${repository}`, "--jq", ".default_branch"]);
  const head = await github(["api", `repos/${repository}/commits/${defaultBranch}`, "--jq", ".sha"]);
  if (head !== revision) throw new Error("The current default-branch revision superseded this Linux desktop build.");
  const manifest = z.object({ schemaVersion: z.literal(1), channel: z.literal("latest"), revision: z.string(), version: z.string() })
    .parse(JSON.parse(await github(["release", "download", "latest", "--repo", repository, "--pattern", "release.json", "--output", "-"])));
  if (manifest.revision !== revision || manifest.version !== version) {
    throw new Error("The published CLI manifest does not match the Linux desktop build.");
  }
}
const assetSchema = z.array(z.object({ name: z.string(), digest: z.string().nullable() }));
async function verifyAssets(assets: Map<string, string>) {
  const remote = assetSchema.parse(JSON.parse(await github(["api", `repos/${repository}/releases/tags/${tag}`, "--jq", ".assets | map({name,digest})"])));
  const digests = new Map(remote.map(asset => [asset.name, asset.digest]));
  for (const [name, digest] of assets) {
    if (digests.get(name) !== digest) throw new Error(`The uploaded Linux desktop asset ${name} does not match its expected digest.`);
  }
}
await github(["release", "upload", tag, ...files, "--clobber", "--repo", repository]);
await verifyAssets(expected);
await github(["release", "upload", tag, feedPath, "--clobber", "--repo", repository]);
await verifyAssets(new Map([["clanky-linux-desktop-update.json", `sha256:${await hash(feedPath)}`]]));
