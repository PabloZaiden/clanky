import { cp, mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import settings from "../native/Configuration/sparkle.json";

export const sparkle = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  feedBaseURL: z.url(),
}).parse(settings);

export async function prepareSparkle(): Promise<string> {
  const root = resolve("dist/apple/Sparkle");
  const settings = macOSBuildSettings();
  await Bun.write(resolve("dist/apple/Sparkle.xcconfig"), Object.entries(settings)
    .map(([name, value]) => `${name} = ${value.replaceAll("://", ":/$()/")}`).join("\n") + "\n");
  const template = await Bun.file(resolve("native/Configuration/macOS.plist")).text();
  await Bun.write(resolve("dist/apple/macOS.plist"), template.replace(
    "<string>$(CLANKY_UPDATE_INTERVAL)</string>",
    `<integer>${settings["CLANKY_UPDATE_INTERVAL"]}</integer>`,
  ));
  const marker = join(root, "distribution.sha256");
  if (await Bun.file(marker).exists() && await Bun.file(marker).text() === sparkle.sha256) return root;
  await mkdir(resolve("dist/apple"), { recursive: true });
  const staging = `${root}.preparing`;
  await mkdir(staging, { recursive: false });
  try {
    const path = join(staging, "distribution.tar.xz");
    const download = Bun.spawn([
      "curl", "--fail", "--location", "--silent", "--show-error", "--max-time", "120",
      `https://github.com/sparkle-project/Sparkle/releases/download/${sparkle.version}/Sparkle-${sparkle.version}.tar.xz`,
      "--output", path,
    ], { stdout: "inherit", stderr: "inherit" });
    if (await download.exited !== 0) throw new Error("Sparkle download failed.");
    if (new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex") !== sparkle.sha256) {
      throw new Error("Sparkle distribution checksum mismatch.");
    }
    const child = Bun.spawn(["tar", "-xJf", path, "-C", staging], {
      stdout: "inherit", stderr: "inherit",
    });
    if (await child.exited !== 0) throw new Error("Sparkle extraction failed.");
    await rm(path);
    await Bun.write(join(staging, "distribution.sha256"), sparkle.sha256);
    await rm(root, { recursive: true, force: true });
    await rename(staging, root);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return root;
}

export async function embedSparkle(app: string): Promise<void> {
  const root = await prepareSparkle();
  const destination = join(app, "Contents/Frameworks");
  await mkdir(destination, { recursive: true });
  await cp(join(root, "Sparkle.framework"), join(destination, "Sparkle.framework"), {
    recursive: true, dereference: false, verbatimSymlinks: true,
  });
}

export function macOSBuildSettings(): Record<string, string> {
  const channel = process.env["CLANKY_MACOS_CHANNEL"];
  const build = process.env["GITHUB_RUN_NUMBER"];
  const revision = process.env["GITHUB_SHA"] ?? "development";
  const version = process.env["APPLE_BUILD_VERSION"] ?? "0.0.0-development";
  if (channel !== undefined && channel !== "stable" && channel !== "latest") {
    throw new Error("CLANKY_MACOS_CHANNEL must be stable or latest.");
  }
  if (channel && (!build || !/^[1-9]\d{0,7}$/.test(build)
    || !/^[a-f0-9]{40}$/.test(revision)
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))) {
    throw new Error("Mac distribution builds require a run number, full revision, and distribution version.");
  }
  const number = channel ? Number(build) : 0;
  if (number > 99_989_999) throw new Error("The native build sequence exceeds Apple's four-digit major version limit.");
  const numericVersion = channel
    ? `${Math.floor(number / 10000) + 1}.${Math.floor(number / 100) % 100}.${number % 100}` : "0.0.0";
  return {
    CURRENT_PROJECT_VERSION: numericVersion,
    MARKETING_VERSION: version.match(/^\d+\.\d+\.\d+/)?.[0] ?? "0.0.0",
    CLANKY_DISTRIBUTION_CHANNEL: channel ?? "development",
    CLANKY_DISTRIBUTION_VERSION: version,
    CLANKY_SOURCE_REVISION: revision,
    CLANKY_SPARKLE_PUBLIC_KEY: sparkle.publicKey,
    CLANKY_UPDATE_FEED: new URL(`${channel ?? "stable"}/appcast.xml`, sparkle.feedBaseURL).href,
    CLANKY_UPDATE_INTERVAL: channel === "latest" ? "3600" : "86400",
  };
}
