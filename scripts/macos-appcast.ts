import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { macOSBuildSettings, prepareSparkle } from "./sparkle";
import { readAppcast, sha256, updateMetadata, verifyUpdateArchive } from "./macos-update-metadata";

const [archivePath, outputPath, ...extra] = process.argv.slice(2);
if (!archivePath || !outputPath || extra.length || process.platform !== "darwin") {
  throw new Error("Usage on macOS: bun scripts/macos-appcast.ts notarized-archive output-directory");
}
const settings = macOSBuildSettings();
const channel = settings["CLANKY_DISTRIBUTION_CHANNEL"];
const version = settings["CLANKY_DISTRIBUTION_VERSION"]!;
if (channel !== "stable" && channel !== "latest") throw new Error("Appcasts require a distribution build.");
const repository = process.env["GITHUB_REPOSITORY"];
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid update repository.");
const key = process.env["SPARKLE_PRIVATE_KEY"];
if (!key?.trim()) throw new Error("SPARKLE_PRIVATE_KEY is required.");
const tools = await prepareSparkle();
const output = resolve(outputPath);
await mkdir(output, { recursive: true });
const work = await mkdtemp(join(process.env["RUNNER_TEMP"] ?? "/tmp", "clanky-appcast-"));
try {
  const name = `Clanky-v${version}-macos-arm64-notarized.zip`;
  await cp(resolve(archivePath), join(work, name));
  const tag = channel === "latest" ? "latest" : `v${version}`;
  const prefix = `https://github.com/${repository}/releases/download/${tag}/`;
  const child = Bun.spawn([
    join(tools, "bin/generate_appcast"), "--ed-key-file", "-",
    "--download-url-prefix", prefix, "--maximum-deltas", "0", "--maximum-versions", "1",
    "--channel", channel, work,
  ], {
    stdin: "pipe", stdout: "inherit", stderr: "inherit",
    env: { ...process.env, SPARKLE_PRIVATE_KEY: undefined },
  });
  child.stdin.write(key);
  child.stdin.end();
  if (await child.exited !== 0) throw new Error("Sparkle appcast generation failed.");
  const xml = await Bun.file(join(work, "appcast.xml")).text();
  const item = readAppcast(xml);
  if (item.buildNumber !== settings["CURRENT_PROJECT_VERSION"]
    || item.channel !== channel || item.url !== `${prefix}${name}`) {
    throw new Error("Generated appcast does not match the distribution build.");
  }
  const bytes = new Uint8Array(await Bun.file(archivePath).arrayBuffer());
  verifyUpdateArchive(xml, bytes);
  const metadata = updateMetadata.parse({
    schemaVersion: 1, channel, version, revision: settings["CLANKY_SOURCE_REVISION"],
    buildNumber: item.buildNumber, archive: name,
    bytes: bytes.byteLength, sha256: sha256(bytes), appcastSha256: sha256(xml),
  });
  await Bun.write(join(output, "appcast.xml"), xml);
  await Bun.write(join(output, "update.json"), `${JSON.stringify(metadata, null, 2)}\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
