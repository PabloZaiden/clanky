import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { formatVersion, github, latestVersion } from "./release-version";
import { compareBuilds, readAppcast, sha256, updateMetadata } from "./macos-update-metadata";
import { sparkle } from "./sparkle";

const [outputPath, ...extra] = process.argv.slice(2);
if (!outputPath || extra.length) throw new Error("Usage: bun scripts/macos-pages-feeds.ts pages-directory");
const repository = process.env["GITHUB_REPOSITORY"];
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid update repository.");
const stableTag = formatVersion(await latestVersion(repository));
const assetSchema = z.object({
  name: z.string(), size: z.number().int().nonnegative(), browser_download_url: z.url(),
  digest: z.string().nullable(),
});
const releaseSchema = z.object({ assets: z.array(assetSchema) });
const snapshots: Record<string, string> = {};

async function readURL(url: string): Promise<{ status: number; text: string }> {
  const child = Bun.spawn([
    "curl", "--silent", "--show-error", "--location", "--max-time", "15",
    "--header", "Cache-Control: no-cache",
    "--max-filesize", "1048576", "--write-out", "\n%{http_code}", url,
  ], { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`Mac feed request failed: ${error.trim()}`);
  return { status: Number(output.slice(-3)), text: output.slice(0, -4) };
}

for (const channel of ["stable", "latest"] as const) {
  const tag = channel === "stable" ? stableTag : "latest";
  const release = releaseSchema.parse(JSON.parse(await github(["api", `repos/${repository}/releases/tags/${tag}`])));
  const metadataAssets = release.assets.filter(asset => asset.name.endsWith("-macos-arm64-update.json"));
  if (metadataAssets.length > 1) throw new Error(`Ambiguous ${channel} update metadata.`);
  let xml = '<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Clanky</title></channel></rss>\n';
  if (metadataAssets[0]) {
    const asset = metadataAssets[0];
    const response = await readURL(asset.browser_download_url);
    if (response.status !== 200) throw new Error(`Cannot read ${channel} update metadata: HTTP ${response.status}.`);
    const metadataText = response.text;
    if (asset.digest !== `sha256:${sha256(metadataText)}`) throw new Error(`Invalid ${channel} update metadata digest.`);
    const metadata = updateMetadata.parse(JSON.parse(metadataText));
    const prefix = `https://github.com/${repository}/releases/download/${tag}/`;
    const appcastName = `Clanky-v${metadata.version}-macos-arm64-appcast.xml`;
    const appcast = release.assets.find(asset => asset.name === appcastName);
    const archive = release.assets.find(asset => asset.name === metadata.archive);
    if (metadata.channel !== channel || (channel === "stable" && `v${metadata.version}` !== tag)
      || !archive || archive.size !== metadata.bytes || !appcast
      || archive.digest !== `sha256:${metadata.sha256}`
      || appcast.digest !== `sha256:${metadata.appcastSha256}`
      || archive.browser_download_url !== `${prefix}${metadata.archive}`
      || appcast.browser_download_url !== `${prefix}${appcastName}`) {
      throw new Error(`Incomplete or inconsistent ${channel} update publication.`);
    }
    const feed = await readURL(appcast.browser_download_url);
    if (feed.status !== 200) throw new Error(`Cannot read ${channel} appcast: HTTP ${feed.status}.`);
    xml = feed.text;
    const item = readAppcast(xml);
    if (sha256(xml) !== metadata.appcastSha256 || item.channel !== channel
      || item.buildNumber !== metadata.buildNumber || item.url !== archive.browser_download_url
      || item.bytes !== metadata.bytes) throw new Error(`Invalid ${channel} appcast.`);
  } else {
    console.warn(`No updater-enabled ${channel} Mac build is published yet.`);
  }
  const previous = await readURL(new URL(`${channel}/appcast.xml`, sparkle.feedBaseURL).href);
  if (previous.status === 200) {
    const oldXML = previous.text;
    const old = readAppcast(oldXML);
    const next = readAppcast(xml);
    if (old.buildNumber && (!next.buildNumber || compareBuilds(old.buildNumber, next.buildNumber) > 0)) {
      console.warn(`Keeping the previously published ${channel} feed; no newer completed Mac build is ready.`);
      xml = oldXML;
    }
  } else if (previous.status !== 404) {
    throw new Error(`Cannot check the published ${channel} feed: HTTP ${previous.status}.`);
  }
  const directory = join(resolve(outputPath), "macos", channel);
  await mkdir(directory, { recursive: true });
  await Bun.write(join(directory, "appcast.xml"), xml);
  snapshots[channel] = sha256(xml);
}
console.log(JSON.stringify(snapshots));
