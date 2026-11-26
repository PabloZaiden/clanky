import { join } from "node:path";
import { z } from "zod";
import { github } from "./release-version";
import { linuxDesktopUpdateVersion } from "./linux-desktop-version";

const [input, tag, repository, revision, version, ...extra] = Bun.argv.slice(2);
if (!input || !tag || !repository || !revision || !version || extra.length
  || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)
  || !/^[a-f0-9]{40}$/.test(revision)
  || !/^\d+\.\d+\.\d+(?:-main-[0-9A-Za-z.-]+)?$/.test(version)
  || tag !== (version.includes("-main-") ? "latest" : `v${version}`)) {
  throw new Error("Usage: publish-linux-desktop <artifacts-dir> <tag> <owner/repo> <revision> <version>");
}

const build = process.env["CLANKY_LINUX_UPDATE_BUILD"];
const updateVersion = linuxDesktopUpdateVersion(version, build);
const files: string[] = [];
const expected = new Map<string, string>();
const platforms: Record<string, { url: string; signature: string }> = {};
const feedName = "clanky-linux-desktop-update.json";
const feedPath = join(input, feedName);
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
  const signedVersion = Buffer.from(signature, "base64").toString("utf8").split(/\r?\n/)[2]
    ?.split("\t").find(field => field.startsWith("version:"));
  if (signedVersion !== `version:${updateVersion}`) {
    throw new Error(`${filename} was not signed for ${updateVersion}.`);
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
const feed = `${JSON.stringify({ version: updateVersion, platforms }, null, 2)}\n`;
await Bun.write(feedPath, feed);

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
const assetSchema = z.array(z.object({ id: z.number(), name: z.string(), digest: z.string().nullable() }));
const releaseAssets = async () => assetSchema.parse(JSON.parse(await github([
  "api", `repos/${repository}/releases/tags/${tag}`, "--jq", ".assets | map({id,name,digest})",
])));
type ReleaseAsset = z.infer<typeof assetSchema>[number];

function verifyAssets(assets: Map<string, string>, remote: ReleaseAsset[]) {
  const digests = new Map(remote.map(asset => [asset.name, asset.digest]));
  for (const [name, digest] of assets) {
    if (digests.get(name) !== digest) throw new Error(`The uploaded Linux desktop asset ${name} does not match its expected digest.`);
  }
}

const feedDigest = `sha256:${await hash(feedPath)}`;
const previousAssets = tag === "latest" ? await releaseAssets() : [];
const previousFeed = previousAssets.find(asset => asset.name === feedName);
const downloadLatest = (name: string) => github(["release", "download", "latest", "--repo", repository, "--pattern", name, "--output", "-"]);
const previousVersion = previousFeed && z.object({ version: z.string() })
  .parse(JSON.parse(await downloadLatest(feedName))).version;
const previousBuild = previousVersion?.match(/\+build\.([1-9]\d{0,7})$/)?.[1];
if (previousBuild && previousVersion !== updateVersion
  && Number(previousBuild) >= Number(build)) {
  throw new Error("The rolling Linux desktop feed already points to an equal or newer build.");
}
if (previousVersion?.split("+", 1)[0] === version) {
  // A retry must not overwrite binaries already referenced by a published feed.
  verifyAssets(expected, previousAssets);
} else {
  await github(["release", "upload", tag, ...files, "--clobber", "--repo", repository]);
  verifyAssets(expected, await releaseAssets());
}

if (tag !== "latest") {
  await github(["release", "upload", tag, feedPath, "--clobber", "--repo", repository]);
} else if (previousFeed?.digest !== feedDigest) {
  const pendingName = "clanky-linux-desktop-update.pending.json";
  const pendingPath = join(input, pendingName);
  await Bun.write(pendingPath, feed);
  await github(["release", "upload", tag, pendingPath, "--clobber", "--repo", repository]);
  const pendingAssets = await releaseAssets();
  verifyAssets(new Map([[pendingName, feedDigest]]), pendingAssets);
  const pending = pendingAssets.find(asset => asset.name === pendingName);
  if (!pending) throw new Error("The verified pending Linux update feed is missing.");

  const rename = (asset: ReleaseAsset, name: string) => github([
    "api", `repos/${repository}/releases/assets/${asset.id}`, "--method", "PATCH", "-f", `name=${name}`,
  ]);
  try {
    if (previousFeed) await rename(previousFeed, `clanky-linux-desktop-update.previous-${previousFeed.id}.json`);
    await rename(pending, feedName);
  } catch (error) {
    if (previousFeed) {
      try {
        if (!(await releaseAssets()).some(asset => asset.name === feedName)) await rename(previousFeed, feedName);
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], "Linux update feed promotion and recovery failed.");
      }
    }
    throw error;
  }
}

const published = await releaseAssets();
verifyAssets(new Map([[feedName, feedDigest]]), published);
if (tag === "latest") {
  const obsoleteAppImage = /^Clanky-v\d+\.\d+\.\d+-main-[0-9A-Za-z.-]+-linux-(x64|arm64)\.AppImage(\.sha256|\.sig)?$/;
  const temporaryFeed = /^clanky-linux-desktop-update\.(pending|previous-\d+)\.json$/;
  for (const { id, name } of published) {
    if ((obsoleteAppImage.test(name) && !expected.has(name)) || temporaryFeed.test(name)) {
      await github(["api", `repos/${repository}/releases/assets/${id}`, "--method", "DELETE"]);
    }
  }
}
