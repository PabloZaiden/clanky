import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const platform = process.argv[2];
const linux = platform === "ios-linux" || platform === "ios-simulator-linux";
if (!["assets", "macos", "ios", "ios-linux", "ios-simulator-linux"].includes(platform ?? "")) {
  throw new Error("Usage: bun scripts/build-apple.ts assets|macos|ios|ios-linux|ios-simulator-linux");
}
if (linux && process.platform !== "linux") {
  throw new Error("The xtool cross-build requires Linux.");
}
if (!linux && process.platform !== "darwin") {
  throw new Error("Apple app builds require macOS and Xcode.");
}

async function run(command: string[], cwd?: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
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

if (linux) {
  const simulator = platform === "ios-simulator-linux";
  const sdkPlatform = simulator ? "iPhoneSimulator" : "iPhoneOS";
  const status = Bun.spawnSync(["xtool", "sdk", "status"], { stderr: "inherit" });
  if (status.exitCode !== 0) throw new Error("Unable to inspect the xtool SDK.");
  const sdk = status.stdout.toString().match(/^\s*Path: (.+)$/m)?.[1];
  if (!sdk) throw new Error("Install the Darwin SDK with xtool sdk install before building.");
  const metadata: unknown = await Bun.file(
    `${sdk}/Developer/Platforms/${sdkPlatform}.platform/Developer/SDKs/${sdkPlatform}.sdk/SDKSettings.json`,
  ).json();
  if (typeof metadata !== "object" || metadata === null || !("Version" in metadata)
    || typeof metadata.Version !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(metadata.Version)) {
    throw new Error(`The xtool ${sdkPlatform} SDK has no valid version.`);
  }

  const project = await Bun.file("native/Clanky.xcodeproj/project.pbxproj").text();
  const configurations = [...project.matchAll(
    /isa = XCBuildConfiguration;\s*buildSettings = \{([^{}]*)\};\s*name = Debug;/g,
  )].map(match => match[1]!);
  const common = configurations[0];
  const ios = configurations.find(settings => /\bSDKROOT = iphoneos;/.test(settings));
  if (!common || !ios) throw new Error("Unable to read the Xcode Debug iOS configuration.");
  const inheritedSettings = `${ios}\n${common}`;
  function setting(name: string): string {
    const pattern = new RegExp(`^\\s*${name} = ([^;]+);`, "m");
    const value = inheritedSettings.match(pattern)?.[1]?.trim();
    if (!value) throw new Error(`Missing Xcode build setting: ${name}`);
    return value.replace(/^"(.*)"$/, "$1");
  }
  const product = setting("PRODUCT_NAME");
  const deploymentTarget = setting("IPHONEOS_DEPLOYMENT_TARGET");
  const language = setting("SWIFT_VERSION").split(".")[0];
  if (language !== "5" && language !== "6") {
    throw new Error("The xtool build requires Swift language mode 5 or 6.");
  }
  const staging = `${directory}/${platform}`;
  await mkdir(staging, { recursive: true });
  await rm(`${staging}/Shared`, { recursive: true, force: true });
  await cp(resolve("native/Shared"), `${staging}/Shared`, { recursive: true });
  const plist = (await Bun.file("native/Configuration/iOS.plist").text()).replace(
    /\$\(([^)]+)\)/g,
    (_, name: string) => Bun.escapeHTML(name === "EXECUTABLE_NAME" ? product : setting(name)),
  );
  await Bun.write(`${staging}/Info.plist`, plist);
  // Preserve linked-SDK behavior: xtool otherwise uses the deployment target as the SDK version.
  await Bun.write(`${staging}/Package.swift`, `// swift-tools-version: 6.4
import PackageDescription
let package = Package(
    name: ${JSON.stringify(product)},
    platforms: [.iOS(${JSON.stringify(deploymentTarget)})],
    products: [.library(name: ${JSON.stringify(product)}, targets: [${JSON.stringify(product)}])],
    targets: [.target(
        name: ${JSON.stringify(product)}, path: "Shared", exclude: ["Assets.xcassets"],
        linkerSettings: [.unsafeFlags([
            "-Xlinker", "-platform_version", "-Xlinker", ${JSON.stringify(simulator ? "ios-simulator" : "ios")},
            "-Xlinker", ${JSON.stringify(deploymentTarget)}, "-Xlinker", ${JSON.stringify(metadata.Version)}
        ])]
    )],
    swiftLanguageModes: [.v${language}]
)
`);
  await Bun.write(`${staging}/xtool.yml`, `version: 1
bundleID: ${JSON.stringify(setting("PRODUCT_BUNDLE_IDENTIFIER"))}
product: ${JSON.stringify(product)}
infoPath: Info.plist
iconPath: Shared/Assets.xcassets/AppIcon.appiconset/ios-1024.png
resources:
  - ../Web
skipLSP: true
`);
  await run([
    "xtool", "dev", "build", "--triple",
    simulator ? "arm64-apple-ios-simulator" : "arm64-apple-ios",
  ], staging);
  console.log(`App (${simulator ? "iOS simulator" : "requires development signing"}): ${staging}/xtool/${product}.app`);
} else if (platform !== "assets") {
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
