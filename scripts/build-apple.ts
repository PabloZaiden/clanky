import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const [platform, ...options] = process.argv.slice(2);
const linux = platform === "macos-linux" || platform === "ios-linux" || platform === "ios-simulator-linux";
const usage = "Usage: bun scripts/build-apple.ts assets|macos|macos-linux|ios|ios-device|ios-linux|ios-simulator-linux [--configuration Debug|Release]";
if (!["assets", "macos", "macos-linux", "ios", "ios-device", "ios-linux", "ios-simulator-linux"].includes(platform ?? "")) {
  throw new Error(usage);
}
let configuration: "Debug" | "Release" = "Debug";
const frontendUpdateChannel = process.env["CLANKY_FRONTEND_UPDATE_CHANNEL"] ?? "latest";
if (frontendUpdateChannel !== "stable" && frontendUpdateChannel !== "latest") {
  throw new Error("CLANKY_FRONTEND_UPDATE_CHANNEL must be stable or latest.");
}
if (options.length > 0) {
  const [flag, value] = options;
  if (options.length !== 2 || flag !== "--configuration" || (value !== "Debug" && value !== "Release")) {
    throw new Error(usage);
  }
  if (linux || platform === "assets") {
    throw new Error("--configuration is only supported for native macos, ios and ios-device builds.");
  }
  configuration = value;
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
  const mac = platform === "macos-linux";
  const simulator = platform === "ios-simulator-linux";
  const sdkPlatform = mac ? "MacOSX" : simulator ? "iPhoneSimulator" : "iPhoneOS";
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
  const target = configurations.find(settings => mac
    ? /\bSDKROOT = macosx;/.test(settings) : /\bSDKROOT = iphoneos;/.test(settings));
  if (!common || !target) throw new Error("Unable to read the Xcode Debug Apple configuration.");
  const inheritedSettings = `${target}\n${common}`;
  function setting(name: string): string {
    const pattern = new RegExp(`^\\s*${name} = ([^;]+);`, "m");
    const value = inheritedSettings.match(pattern)?.[1]?.trim();
    if (!value) throw new Error(`Missing Xcode build setting: ${name}`);
    return value.replace(/^"(.*)"$/, "$1");
  }
  const product = setting("PRODUCT_NAME");
  const deploymentTarget = setting(mac ? "MACOSX_DEPLOYMENT_TARGET" : "IPHONEOS_DEPLOYMENT_TARGET");
  const language = setting("SWIFT_VERSION").split(".")[0];
  if (language !== "5" && language !== "6") {
    throw new Error("The xtool build requires Swift language mode 5 or 6.");
  }
  const staging = `${directory}/${platform}`;
  await mkdir(staging, { recursive: true });
  if (mac) {
    const app = `${staging}/${product}.app`;
    await rm(app, { recursive: true, force: true });
    const contents = `${app}/Contents`;
    await mkdir(`${contents}/MacOS`, { recursive: true });
    await mkdir(`${contents}/Helpers`, { recursive: true });
    await mkdir(`${contents}/Resources`, { recursive: true });
    const toolchain = `${sdk}/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib`;
    const runtimes = [...new Bun.Glob("*/lib/darwin/libclang_rt.osx.a").scanSync({
      cwd: `${toolchain}/clang`, absolute: true,
    })];
    if (runtimes.length !== 1) {
      throw new Error("The xtool SDK must contain exactly one macOS Clang runtime.");
    }
    const sources = ["native/Shared", "native/macOS"].flatMap(path =>
      [...new Bun.Glob("*.swift").scanSync({ cwd: resolve(path), absolute: true })].sort());
    await run([
      "swiftc", "-parse-as-library", "-swift-version", language, setting("SWIFT_OPTIMIZATION_LEVEL"),
      "-target", `arm64-apple-macosx${deploymentTarget}`,
      "-sdk", `${sdk}/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk`,
      "-resource-dir", `${toolchain}/swift`,
      "-Xfrontend", "-enable-cross-import-overlays", "-use-ld=lld",
      `-ld-path=${sdk}/toolset/bin/ld64.lld`,
      "-Xlinker", "-platform_version", "-Xlinker", "macos",
      "-Xlinker", deploymentTarget, "-Xlinker", metadata.Version,
      runtimes[0]!, ...sources, "-o", `${contents}/MacOS/${product}`,
    ]);
    await run([process.execPath, "src/build.ts", "--target=bun-darwin-arm64"]);
    await cp(resolve("dist/clanky-darwin-arm64"), `${contents}/Helpers/clanky`);
    await chmod(`${contents}/Helpers/clanky`, 0o755);
    await cp(web, `${contents}/Resources/Web`, { recursive: true });
    const plist = (await Bun.file("native/Configuration/macOS.plist").text()).replace(
      /\$\(([^)]+)\)/g,
      (_, name: string) => Bun.escapeHTML(name === "EXECUTABLE_NAME" ? product : setting(name)),
    );
    await Bun.write(`${contents}/Info.plist`, plist);
    const catalog = resolve("native/Shared/Assets.xcassets/AppIcon.appiconset");
    const artwork: unknown = await Bun.file(`${catalog}/Contents.json`).json();
    if (typeof artwork !== "object" || artwork === null || !("images" in artwork)
      || !Array.isArray(artwork.images)) {
      throw new Error("Invalid native app icon catalog.");
    }
    const iconTypes = new Map([
      ["16x16@1x", "icp4"], ["16x16@2x", "ic11"], ["32x32@1x", "icp5"], ["32x32@2x", "ic12"],
      ["128x128@1x", "ic07"], ["128x128@2x", "ic13"], ["256x256@1x", "ic08"],
      ["256x256@2x", "ic14"], ["512x512@1x", "ic09"], ["512x512@2x", "ic10"],
    ]);
    const chunks: Buffer[] = [];
    for (const image of artwork.images) {
      if (typeof image !== "object" || image === null || !("idiom" in image) || image.idiom !== "mac") continue;
      if (!("size" in image) || !("scale" in image) || !("filename" in image)
        || typeof image.size !== "string" || typeof image.scale !== "string"
        || typeof image.filename !== "string") {
        throw new Error("Invalid Mac app icon entry.");
      }
      const type = iconTypes.get(`${image.size}@${image.scale}`);
      if (!type) throw new Error(`Unsupported Mac icon size: ${image.size}@${image.scale}`);
      const png = Buffer.from(await Bun.file(`${catalog}/${image.filename}`).arrayBuffer());
      const pixels = Number(image.size.split("x")[0]) * Number(image.scale.slice(0, -1));
      if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
        || png.readUInt32BE(16) !== pixels || png.readUInt32BE(20) !== pixels) {
        throw new Error(`Invalid Mac icon PNG: ${image.filename}`);
      }
      const header = Buffer.alloc(8);
      header.write(type, 0, "ascii");
      header.writeUInt32BE(png.length + 8, 4);
      chunks.push(header, png);
    }
    if (chunks.length !== iconTypes.size * 2) throw new Error("The Mac icon catalog is incomplete.");
    const header = Buffer.alloc(8);
    header.write("icns", 0, "ascii");
    header.writeUInt32BE(8 + chunks.reduce((size, chunk) => size + chunk.length, 0), 4);
    await Bun.write(`${contents}/Resources/AppIcon.icns`, Buffer.concat([header, ...chunks]));
    console.log(`App (macOS arm64, requires native signing): ${app}`);
  } else {
    await rm(`${staging}/Shared`, { recursive: true, force: true });
    await cp(resolve("native/Shared"), `${staging}/Shared`, { recursive: true });
    const plist = (await Bun.file("native/Configuration/iOS.plist").text()).replace(
      /\$\(([^)]+)\)/g,
      (_, name: string) => Bun.escapeHTML(name === "EXECUTABLE_NAME" ? product
        : name === "CLANKY_FRONTEND_UPDATE_CHANNEL" ? frontendUpdateChannel : setting(name)),
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
  }
} else if (platform !== "assets") {
  const mac = platform === "macos";
  const device = platform === "ios-device";
  await run([
    "xcodebuild", "-quiet", "-project", "native/Clanky.xcodeproj",
    "-scheme", mac ? "Clanky-macOS" : "Clanky-iOS", "-configuration", configuration,
    "-derivedDataPath", `${directory}/build`,
    "-destination", mac ? "platform=macOS" : device ? "generic/platform=iOS" : "generic/platform=iOS Simulator",
    ...(mac ? ["ARCHS=" + (process.arch === "x64" ? "x86_64" : process.arch), "ONLY_ACTIVE_ARCH=YES"]
      : ["CODE_SIGNING_ALLOWED=NO"]),
    ...(device ? ["ARCHS=arm64"] : []),
    ...(!mac ? [`CLANKY_FRONTEND_UPDATE_CHANNEL=${frontendUpdateChannel}`] : []),
    "build",
  ]);
  const product = mac ? configuration : `${configuration}-${device ? "iphoneos" : "iphonesimulator"}`;
  console.log(`App: ${directory}/build/Build/Products/${product}/Clanky.app`);
}
