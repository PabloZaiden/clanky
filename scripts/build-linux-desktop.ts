import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { CLANKY_VERSION } from "../src/version";
import { linuxDesktopUpdateVersion } from "./linux-desktop-version";

const runtimes = {
  x64: { name: "x86_64", digest: "617aa77314d57c8b8e4fae9c3f0b35af7b30d5529cb69e98f64f92510ed98a46", machine: 62 },
  arm64: { name: "aarch64", digest: "9a72a744d221576c9347ec074243acc5c3c7568896b12714e0e82e9f0bf47900", machine: 183 },
};

if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64") || Bun.argv.length !== 2) {
  throw new Error("Run bun run build:linux:desktop on native Linux x64 or arm64.");
}
const runtime = runtimes[process.arch];
const target = `linux-${process.arch}`;
const root = resolve(import.meta.dir, "..");
const native = join(root, "native/linux");
const output = join(root, "dist/linux-desktop");
const filename = `Clanky-v${CLANKY_VERSION}-${target}.AppImage`;
const signing = Boolean(process.env["TAURI_SIGNING_PRIVATE_KEY"] || process.env["TAURI_SIGNING_PRIVATE_KEY_PATH"]);
if (signing !== Boolean(process.env["CLANKY_LINUX_UPDATE_PUBLIC_KEY"])) {
  throw new Error("Configure both the updater public key and the private signing key, or neither for an unsigned local build.");
}
const updateVersion = signing ? linuxDesktopUpdateVersion(CLANKY_VERSION, process.env["CLANKY_LINUX_UPDATE_BUILD"]) : CLANKY_VERSION;
for (const tool of ["cargo", "mksquashfs", ...(signing ? ["minisign"] : [])]) {
  if (!Bun.which(tool)) throw new Error(`${tool} is required to build the Linux desktop AppImage.`);
}

const buildEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !name.startsWith("TAURI_SIGNING_PRIVATE_KEY")));
async function run(args: string[], cwd = root, env = buildEnv): Promise<string> {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "inherit", stdin: "ignore" });
  const stdout = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error(`${args[0]} ${args.slice(1).join(" ")} failed: ${stdout.trim()}`);
  return stdout.trim();
}

async function checkElf(path: string): Promise<void> {
  const header = Buffer.from(await Bun.file(path).slice(0, 20).arrayBuffer());
  if (header.length !== 20 || header.readUInt32BE(0) !== 0x7f454c46
    || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== runtime.machine) {
    throw new Error(`${path} is not a ${target} executable.`);
  }
}

async function checksum(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(output, ".stage-"));
try {
  await run(["bun", "--no-env-file", "src/build-pages.ts", "--desktop"]);
  const cargoTarget = join(output, "cargo-target");
  await run(["cargo", "build", "--release", "--locked"], native, {
    ...buildEnv,
    CARGO_TARGET_DIR: cargoTarget,
    TAURI_CONFIG: JSON.stringify({ version: updateVersion }),
  });
  await run(["bun", "--no-env-file", "src/build.ts", `--target=bun-${target}`]);
  const shell = join(cargoTarget, "release/clanky-desktop");
  const controller = join(root, `dist/clanky-${target}`);
  await checkElf(shell);
  await checkElf(controller);
  if (await run([controller, "version"], stage, {}) !== CLANKY_VERSION) {
    throw new Error("The bundled controller does not report the distribution version.");
  }

  const runtimePath = join(stage, "runtime");
  const url = `https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-${runtime.name}`;
  const cachedRuntime = process.env["CLANKY_APPIMAGE_RUNTIME_FILE"];
  if (cachedRuntime) {
    await copyFile(cachedRuntime, runtimePath);
  } else {
    const download = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!download.ok || !download.body) throw new Error(`AppImage runtime download failed (HTTP ${download.status}).`);
    await Bun.write(runtimePath, download);
  }
  if (await checksum(runtimePath) !== runtime.digest) throw new Error("The AppImage runtime does not match the pinned digest.");
  await checkElf(runtimePath);

  const appDir = join(stage, "AppDir");
  const bin = join(appDir, "usr/bin");
  await mkdir(bin, { recursive: true });
  await Promise.all([
    copyFile(join(native, "AppRun"), join(appDir, "AppRun")),
    copyFile(join(native, "clanky.desktop"), join(appDir, "clanky.desktop")),
    copyFile(join(root, "native/Shared/Assets.xcassets/AppIcon.appiconset/mac-256.png"), join(appDir, "clanky.png")),
    copyFile(shell, join(bin, "clanky-desktop")),
    copyFile(controller, join(bin, "clanky-controller")),
  ]);
  await Promise.all([join(appDir, "AppRun"), join(bin, "clanky-desktop"), join(bin, "clanky-controller")].map(path => chmod(path, 0o755)));
  const payload = join(stage, "payload.squashfs");
  await run(["mksquashfs", appDir, payload, "-noappend", "-all-root", "-comp", "zstd", "-processors", "4", "-no-progress"]);
  const image = join(stage, filename);
  await pipeline(Readable.from((async function* () {
    yield* Bun.file(runtimePath).stream();
    yield* Bun.file(payload).stream();
  })()), createWriteStream(image, { flags: "wx", mode: 0o755 }));
  const digest = await checksum(image);
  if (signing) {
    await run(["bun", "x", "--package", "@tauri-apps/cli@2.12.6", "tauri", "signer", "sign", "--app-version", updateVersion, image], root, process.env);
    const publicKey = join(stage, "minisign.pub");
    const signature = join(stage, "appimage.minisig");
    await Bun.write(publicKey, Buffer.from(process.env["CLANKY_LINUX_UPDATE_PUBLIC_KEY"]!.trim(), "base64"));
    await Bun.write(signature, Buffer.from((await Bun.file(`${image}.sig`).text()).trim(), "base64"));
    await run(["minisign", "-Vm", image, "-p", publicKey, "-x", signature, "-q"]);
    await copyFile(`${image}.sig`, join(output, `${filename}.sig`));
  } else {
    await rm(join(output, `${filename}.sig`), { force: true });
  }
  await copyFile(image, join(output, filename));
  await Bun.write(join(output, `${filename}.sha256`), `${digest}  ${filename}\n`);
  console.log(join(output, filename));
} finally {
  await rm(stage, { recursive: true, force: true });
}
