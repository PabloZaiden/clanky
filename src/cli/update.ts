import { chmod, mkdtemp, realpath, rename, rm, stat } from "fs/promises";
import { basename, dirname, join } from "path";
import { z } from "zod";

const GITHUB_REPOSITORY = "pablozaiden/ralpher";
const GITHUB_API_BASE_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}`;
const RELEASE_BINARY_PREFIX = "ralpher";

const ReleaseAssetSchema = z.object({
  name: z.string().min(1),
  browser_download_url: z.string().url(),
});

const ReleaseSchema = z.object({
  tag_name: z.string().min(1),
  assets: z.array(ReleaseAssetSchema),
});

export interface UpdateCommandOptions {
  checkOnly: boolean;
  version?: string;
}

export type ReleasePlatform = {
  os: "linux" | "darwin";
  arch: "x64" | "arm64";
};

type WritableBinaryContent = Uint8Array | string;

export interface CliUpdateDependencies {
  fetchFn: typeof fetch;
  out: (message: string) => void;
  currentVersion: string;
  getPlatform: () => {
    platform: NodeJS.Platform;
    arch: string;
  };
  getExecutablePath: () => string;
  resolveRealPath: (path: string) => Promise<string>;
  createTempDirectory: (targetDirectory: string) => Promise<string>;
  writeBinary: (path: string, content: WritableBinaryContent) => Promise<void>;
  chmodFile: (path: string, mode: number) => Promise<void>;
  renameFile: (from: string, to: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  statFile: (path: string) => Promise<{
    mode: number;
  }>;
}

type GitHubRelease = z.infer<typeof ReleaseSchema>;

type ReleaseAsset = {
  version: string;
  assetName: string;
  downloadUrl: string;
};

function createDefaultUpdateDependencies(): CliUpdateDependencies {
  return {
    fetchFn: fetch,
    out: console.log,
    currentVersion: "0.0.0-development",
    getPlatform: () => ({
      platform: process.platform,
      arch: process.arch,
    }),
    getExecutablePath: () => process.execPath,
    resolveRealPath: async (path: string) => await realpath(path),
    createTempDirectory: async (targetDirectory: string) => await mkdtemp(join(targetDirectory, ".ralpher-update-")),
    writeBinary: async (path: string, content: WritableBinaryContent) => {
      await Bun.write(path, content);
    },
    chmodFile: async (path: string, mode: number) => {
      await chmod(path, mode);
    },
    renameFile: async (from: string, to: string) => {
      await rename(from, to);
    },
    removeFile: async (path: string) => {
      await rm(path, { force: true, recursive: true });
    },
    statFile: async (path: string) => {
      const currentStat = await stat(path);
      return {
        mode: currentStat.mode,
      };
    },
  };
}

export function normalizeReleaseVersion(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("Missing release version.");
  }
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

export function normalizeReleaseTag(rawValue: string): string {
  return `v${normalizeReleaseVersion(rawValue)}`;
}

function parseVersion(value: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
} | null {
  const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(normalizeReleaseVersion(value));
  if (!parsed) {
    return null;
  }

  return {
    major: Number(parsed[1]),
    minor: Number(parsed[2]),
    patch: Number(parsed[3]),
    prerelease: parsed[4]?.split(".") ?? [],
  };
}

function comparePrereleaseIdentifiers(left: string[], right: string[]): number {
  const limit = Math.max(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    if (leftPart === rightPart) {
      continue;
    }

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) {
      return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
    }
    if (leftNumber !== null) {
      return -1;
    }
    if (rightNumber !== null) {
      return 1;
    }
    return leftPart.localeCompare(rightPart);
  }

  return 0;
}

export function compareReleaseVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) {
    return normalizeReleaseVersion(left).localeCompare(normalizeReleaseVersion(right));
  }

  if (leftVersion.major !== rightVersion.major) {
    return leftVersion.major < rightVersion.major ? -1 : 1;
  }
  if (leftVersion.minor !== rightVersion.minor) {
    return leftVersion.minor < rightVersion.minor ? -1 : 1;
  }
  if (leftVersion.patch !== rightVersion.patch) {
    return leftVersion.patch < rightVersion.patch ? -1 : 1;
  }

  const leftHasPrerelease = leftVersion.prerelease.length > 0;
  const rightHasPrerelease = rightVersion.prerelease.length > 0;
  if (!leftHasPrerelease && !rightHasPrerelease) {
    return 0;
  }
  if (!leftHasPrerelease) {
    return 1;
  }
  if (!rightHasPrerelease) {
    return -1;
  }
  return comparePrereleaseIdentifiers(leftVersion.prerelease, rightVersion.prerelease);
}

export function resolveReleasePlatform(platform: NodeJS.Platform, arch: string): ReleasePlatform {
  if ((platform === "linux" || platform === "darwin") && (arch === "x64" || arch === "arm64")) {
    return {
      os: platform,
      arch,
    };
  }

  throw new Error(
    `Unsupported platform: ${platform}-${arch}. Ralpher releases support Linux and macOS on x64 and arm64.`,
  );
}

export function buildReleaseAssetName(tag: string, target: ReleasePlatform): string {
  return `${RELEASE_BINARY_PREFIX}-${tag}-${target.os}-${target.arch}`;
}

async function fetchRelease(
  version: string | undefined,
  dependencies: CliUpdateDependencies,
): Promise<GitHubRelease> {
  const tag = version ? normalizeReleaseTag(version) : undefined;
  const releaseUrl = tag
    ? `${GITHUB_API_BASE_URL}/releases/tags/${tag}`
    : `${GITHUB_API_BASE_URL}/releases/latest`;
  const response = await dependencies.fetchFn(releaseUrl, {
    headers: {
      accept: "application/vnd.github+json",
    },
  });

  if (response.status === 404 && tag) {
    throw new Error(`Release not found: ${tag}`);
  }
  if (!response.ok) {
    throw new Error(`Failed to load release metadata: GitHub returned ${String(response.status)}.`);
  }

  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch (error) {
    throw new Error(`Failed to parse release metadata: ${String(error)}`);
  }

  return ReleaseSchema.parse(rawBody);
}

async function resolveReleaseAsset(
  command: UpdateCommandOptions,
  dependencies: CliUpdateDependencies,
): Promise<ReleaseAsset> {
  const release = await fetchRelease(command.version, dependencies);
  const runtimePlatform = dependencies.getPlatform();
  const releasePlatform = resolveReleasePlatform(runtimePlatform.platform, runtimePlatform.arch);
  const assetName = buildReleaseAssetName(release.tag_name, releasePlatform);
  const asset = release.assets.find((entry) => entry.name === assetName);
  if (!asset) {
    throw new Error(`Release ${release.tag_name} does not include asset ${assetName}.`);
  }

  return {
    version: normalizeReleaseVersion(release.tag_name),
    assetName,
    downloadUrl: asset.browser_download_url,
  };
}

async function resolveInstalledBinaryPath(dependencies: CliUpdateDependencies): Promise<string> {
  const executablePath = dependencies.getExecutablePath();
  const executableName = basename(executablePath);
  if (executableName === "bun" || executableName.startsWith("bun-")) {
    throw new Error("ralpher update only works from an installed Ralpher binary. Use install.sh when running from source.");
  }
  return await dependencies.resolveRealPath(executablePath);
}

function formatCheckMessage(currentVersion: string, targetVersion: string): string {
  const comparison = compareReleaseVersions(currentVersion, targetVersion);
  if (comparison === 0) {
    return `ralpher ${currentVersion} is up to date.`;
  }
  if (comparison > 0) {
    return `ralpher ${currentVersion} is newer than the latest published release ${targetVersion}.`;
  }
  return `Update available: ${currentVersion} -> ${targetVersion}`;
}

function toPermissionMessage(path: string, error: unknown): Error {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : undefined;
  if (code === "EACCES" || code === "EPERM") {
    return new Error(
      `Cannot update ${path}: permission denied. Re-run with permission to modify the installed binary or use the installer script.`,
    );
  }
  return new Error(`Failed to update ${path}: ${String(error)}`);
}

async function replaceInstalledBinary(
  asset: ReleaseAsset,
  dependencies: CliUpdateDependencies,
): Promise<string> {
  const targetPath = await resolveInstalledBinaryPath(dependencies);
  let tempDirectory: string | undefined;
  let tempPath: string | undefined;
  let tempCreated = false;

  try {
    tempDirectory = await dependencies.createTempDirectory(dirname(targetPath));
    tempPath = join(tempDirectory, asset.assetName);
    const response = await dependencies.fetchFn(asset.downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download ${asset.assetName}: GitHub returned ${String(response.status)}.`);
    }

    const payload = await response.bytes();
    await dependencies.writeBinary(tempPath, payload);
    tempCreated = true;

    const installedBinaryStat = await dependencies.statFile(targetPath);
    const executableMode = installedBinaryStat.mode & 0o777;
    await dependencies.chmodFile(tempPath, executableMode || 0o755);
    await dependencies.renameFile(tempPath, targetPath);
    return targetPath;
  } catch (error) {
    throw toPermissionMessage(targetPath, error);
  } finally {
    if (tempCreated && tempPath) {
      await dependencies.removeFile(tempPath);
    }
    if (tempDirectory) {
      await dependencies.removeFile(tempDirectory);
    }
  }
}

export async function runUpdateCommand(
  command: UpdateCommandOptions,
  dependencyOverrides: Partial<CliUpdateDependencies> = {},
): Promise<number> {
  const dependencies = {
    ...createDefaultUpdateDependencies(),
    ...dependencyOverrides,
  };
  const currentVersion = normalizeReleaseVersion(dependencies.currentVersion);
  const releaseAsset = await resolveReleaseAsset(command, dependencies);

  if (command.checkOnly) {
    dependencies.out(formatCheckMessage(currentVersion, releaseAsset.version));
    return 0;
  }

  if (!command.version && compareReleaseVersions(currentVersion, releaseAsset.version) >= 0) {
    dependencies.out(formatCheckMessage(currentVersion, releaseAsset.version));
    return 0;
  }

  if (command.version && compareReleaseVersions(currentVersion, releaseAsset.version) === 0) {
    dependencies.out(`ralpher ${currentVersion} is already installed.`);
    return 0;
  }

  const installedPath = await replaceInstalledBinary(releaseAsset, dependencies);
  if (command.version) {
    dependencies.out(`Installed ralpher ${releaseAsset.version} at ${installedPath}.`);
    return 0;
  }

  dependencies.out(`Updated ralpher ${currentVersion} -> ${releaseAsset.version} at ${installedPath}.`);
  return 0;
}
