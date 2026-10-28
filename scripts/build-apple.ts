import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const platform = process.argv[2];
if (!["assets", "macos", "ios"].includes(platform ?? "")) {
  throw new Error("Usage: bun scripts/build-apple.ts assets|macos|ios");
}
if (process.platform !== "darwin") {
  throw new Error("Apple app builds require macOS and Xcode.");
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  if (await child.exited !== 0) throw new Error(`Apple build failed: ${command.join(" ")}`);
}

// Use the existing two-mode site, including its chooser, without a second frontend.
await run([process.execPath, "run", "build:pages"]);
const directory = resolve("dist/apple");
await mkdir(directory, { recursive: true });
const web = `${directory}/Web`;
await rm(web, { recursive: true, force: true });
await cp(resolve("dist/pages"), web, { recursive: true });

if (platform === "macos") {
  await run([process.execPath, "run", "build"]);
  await mkdir(`${directory}/Controller`, { recursive: true });
  await cp(resolve("dist/clanky"), `${directory}/Controller/clanky`);
}

if (platform !== "assets") {
  const mac = platform === "macos";
  await run([
    "xcodebuild", "-quiet", "-project", "native/Clanky.xcodeproj",
    "-scheme", mac ? "Clanky-macOS" : "Clanky-iOS", "-configuration", "Debug",
    "-derivedDataPath", `${directory}/build`,
    "-destination", mac ? "platform=macOS" : "generic/platform=iOS Simulator",
    ...(mac ? ["ARCHS=" + (process.arch === "x64" ? "x86_64" : process.arch), "ONLY_ACTIVE_ARCH=YES"]
      : ["CODE_SIGNING_ALLOWED=NO"]),
    "build",
  ]);
  console.log(`App: ${directory}/build/Build/Products/${mac ? "Debug" : "Debug-iphonesimulator"}/Clanky.app`);
}
