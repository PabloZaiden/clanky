const GITHUB_REPOSITORY = "pablozaiden/ralpher";
const CLI_BINARY_NAME = "ralpher-cli";
const SERVER_BINARY_NAME = "ralpher";

export interface UpdateCommandOptions {
  checkOnly: boolean;
  version?: string;
}

export type ReleasePlatform = {
  os: "linux" | "darwin";
  arch: "x64" | "arm64";
};

type WritableBinaryContent = Uint8Array | string;

type UpdaterDependencies = {
  fetchFn: typeof fetch;
  out: (message: string) => void;
  err: (message: string) => void;
  getPlatform: () => {
    platform: string;
    arch: string;
  };
  getExecutablePath: () => string;
  resolveRealPath: (path: string) => Promise<string>;
  fileExists: (path: string) => Promise<boolean>;
  createTempDirectory: (targetDirectory: string, prefix: string) => Promise<string>;
  writeBinary: (path: string, content: WritableBinaryContent) => Promise<void>;
  chmodFile: (path: string, mode: number) => Promise<void>;
  renameFile: (from: string, to: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  statFile: (path: string) => Promise<{ mode: number }>;
};

type UpdaterConfig = {
  repository: string;
  binaryName: string;
  currentVersion: string;
  productName: string;
  checksum: {
    required: boolean;
  };
  companionBinaries: Array<{
    binaryName: string;
    assetPrefix: string;
    required: boolean;
  }>;
};

type InstallerModule = {
  runUpdateCommand: (
    command: UpdateCommandOptions,
    config: UpdaterConfig,
    dependencyOverrides?: Partial<UpdaterDependencies>,
  ) => Promise<number>;
};

export type CliUpdateDependencies = Partial<UpdaterDependencies> & {
  currentVersion?: string;
};

export const RALPHER_UPDATER_CONFIG = {
  repository: GITHUB_REPOSITORY,
  binaryName: CLI_BINARY_NAME,
  currentVersion: "0.0.0-development",
  productName: "Ralpher CLI",
  checksum: { required: true },
  companionBinaries: [
    {
      binaryName: SERVER_BINARY_NAME,
      assetPrefix: SERVER_BINARY_NAME,
      required: false,
    },
  ],
} satisfies UpdaterConfig;

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

export function resolveReleasePlatform(platform: string, arch: string): ReleasePlatform {
  const os = platform === "linux" || platform === "darwin" ? platform : undefined;
  const normalizedArch = arch === "x64" || arch === "amd64"
    ? "x64"
    : arch === "arm64" || arch === "aarch64"
      ? "arm64"
      : undefined;

  if (os && normalizedArch) {
    return {
      os,
      arch: normalizedArch,
    };
  }

  throw new Error(`Unsupported platform: ${platform}-${arch}. Supported release targets are Linux and macOS on x64 and arm64.`);
}

export function buildReleaseAssetName(tag: string, target: ReleasePlatform): string {
  return `${CLI_BINARY_NAME}-${normalizeReleaseTag(tag)}-${target.os}-${target.arch}`;
}

async function loadInstaller(): Promise<InstallerModule> {
  return await import("@pablozaiden/installer" as string) as InstallerModule;
}

export async function runUpdateCommand(
  command: UpdateCommandOptions,
  dependencyOverrides: CliUpdateDependencies = {},
): Promise<number> {
  const { currentVersion, ...installerDependencyOverrides } = dependencyOverrides;
  const installer = await loadInstaller();
  return await installer.runUpdateCommand(
    command,
    {
      ...RALPHER_UPDATER_CONFIG,
      currentVersion: currentVersion ?? RALPHER_UPDATER_CONFIG.currentVersion,
    },
    installerDependencyOverrides,
  );
}
