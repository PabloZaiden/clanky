export type ReleaseOs = "linux" | "darwin" | "windows";
export type ReleaseArchitecture = "x64" | "arm64";
export type DockerChannelName = "release" | "main";

export interface ChecksumPolicy {
  required: boolean;
  extension: string;
}

export interface ReleaseBinary {
  id: string;
  name: string;
  installedFilename: string;
  assetPrefix: string;
  buildCommand: string;
  outputPath: string;
  postInstallMessage: string;
  checksum: ChecksumPolicy;
}

export interface ReleaseTarget {
  id: string;
  os: ReleaseOs;
  architecture: ReleaseArchitecture;
  runner: string;
  bunTarget: string;
  executableExtension: string;
}

export interface DockerImage {
  id: string;
  imageSuffix: string;
  dockerfileTarget: string;
}

export interface DockerPlatform {
  id: string;
  platform: string;
  targetArch: "amd64" | "arm64";
  targetId: string;
}

export interface DockerChannel {
  platforms: string[];
  tags: string[];
}

export interface DockerMetadata {
  images: DockerImage[];
  platforms: DockerPlatform[];
  channels: Record<DockerChannelName, DockerChannel>;
}

export interface ReleaseMetadata {
  schemaVersion: 1;
  repo: string;
  installDir: string;
  binaries: ReleaseBinary[];
  targets: ReleaseTarget[];
  docker: DockerMetadata;
}

export interface InstallerTarget {
  os: string;
  target: string;
  bun_target: string;
}

export interface InstallerBinary {
  name: string;
  asset_prefix: string;
  build_command: string;
  output_path: string;
}

export interface InstallerManifest {
  schemaVersion: 1;
  repo: string;
  installDir: string;
  binaries: Array<{
    name: string;
    assetPrefix: string;
    postInstallMessage: string;
  }>;
  checksums: ChecksumPolicy;
  platforms: Record<ReleaseOs, ReleaseArchitecture[]>;
}

export interface DockerConfig {
  repository: string;
  platforms: string;
  tags: string;
  images: {
    server: {
      name: string;
      dockerfileTarget: string;
    };
    relay: {
      name: string;
      dockerfileTarget: string;
    };
  };
}

export const canonicalMetadataPath = `${import.meta.dir}/../.github/release-metadata.json`;
export const installerManifestPath = `${import.meta.dir}/../.github/installer.json`;

const supportedTemplateVariables = new Set([
  "TAG",
  "VERSION",
  "RELEASE_TARGET",
  "BUN_TARGET",
  "BINARY_NAME",
  "ASSET_PREFIX",
  "ASSET_NAME",
  "ASSET_PATH",
  "OUTPUT_PATH",
]);
const releaseOsValues: ReleaseOs[] = ["linux", "darwin", "windows"];
const releaseArchitectureValues: ReleaseArchitecture[] = ["x64", "arm64"];
const dockerChannelNames: DockerChannelName[] = ["release", "main"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value;
}

function requireString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path}.${key} must be a non-empty string`);
  }
  return value;
}

function requireStringAllowEmpty(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${path}.${key} must be a string`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string, path: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${path}.${key} must be a boolean`);
  }
  return value;
}

function requireLiteralOne(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== 1) {
    throw new Error(`${path}.${key} must be 1`);
  }
}

function requireSafeToken(value: string, path: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${path} contains unsafe characters: ${value}`);
  }
}

function requireSafeSuffix(value: string, path: string): void {
  if (value.length > 0 && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.replace(/^-/, ""))) {
    throw new Error(`${path} contains unsafe characters: ${value}`);
  }
  if (value.length > 0 && !value.startsWith("-")) {
    throw new Error(`${path} must be empty or start with '-': ${value}`);
  }
}

function requireNoNewlines(value: string, path: string): void {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`${path} must not contain newlines`);
  }
}

function validateTemplate(value: string, path: string, requiredVariable: string): void {
  requireNoNewlines(value, path);
  const variables = value.matchAll(/\$(?:\{([A-Z][A-Z0-9_]*)\}|([A-Z][A-Z0-9_]*))/g);
  for (const match of variables) {
    const variable = match[1] ?? match[2];
    if (variable === undefined || !supportedTemplateVariables.has(variable)) {
      throw new Error(`${path} uses unsupported template variable: ${variable ?? ""}`);
    }
  }
  if (!value.includes(`$${requiredVariable}`) && !value.includes(`\${${requiredVariable}}`)) {
    throw new Error(`${path} must include $${requiredVariable}`);
  }
}

function parseChecksumPolicy(value: unknown, path: string): ChecksumPolicy {
  const record = requireRecord(value, path);
  const required = requireBoolean(record, "required", path);
  const extension = requireString(record, "extension", path);
  if (!/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(extension)) {
    throw new Error(`${path}.extension must be a safe file extension`);
  }
  return { required, extension };
}

function parseBinary(value: unknown, index: number): ReleaseBinary {
  const path = `binaries[${index}]`;
  const record = requireRecord(value, path);
  return {
    id: requireString(record, "id", path),
    name: requireString(record, "name", path),
    installedFilename: requireString(record, "installedFilename", path),
    assetPrefix: requireString(record, "assetPrefix", path),
    buildCommand: requireString(record, "buildCommand", path),
    outputPath: requireString(record, "outputPath", path),
    postInstallMessage: requireString(record, "postInstallMessage", path),
    checksum: parseChecksumPolicy(record["checksum"], `${path}.checksum`),
  };
}

function parseReleaseOs(value: string, path: string): ReleaseOs {
  if (!releaseOsValues.includes(value as ReleaseOs)) {
    throw new Error(`${path} must be one of ${releaseOsValues.join(", ")}`);
  }
  return value as ReleaseOs;
}

function parseReleaseArchitecture(value: string, path: string): ReleaseArchitecture {
  if (!releaseArchitectureValues.includes(value as ReleaseArchitecture)) {
    throw new Error(`${path} must be one of ${releaseArchitectureValues.join(", ")}`);
  }
  return value as ReleaseArchitecture;
}

function parseTarget(value: unknown, index: number): ReleaseTarget {
  const path = `targets[${index}]`;
  const record = requireRecord(value, path);
  const id = requireString(record, "id", path);
  const os = parseReleaseOs(requireString(record, "os", path), `${path}.os`);
  const architecture = parseReleaseArchitecture(
    requireString(record, "architecture", path),
    `${path}.architecture`,
  );
  const runner = requireString(record, "runner", path);
  const bunTarget = requireString(record, "bunTarget", path);
  const executableExtension = requireStringAllowEmpty(record, "executableExtension", path);
  return {
    id,
    os,
    architecture,
    runner,
    bunTarget,
    executableExtension,
  };
}

function parseDockerImage(value: unknown, index: number): DockerImage {
  const path = `docker.images[${index}]`;
  const record = requireRecord(value, path);
  return {
    id: requireString(record, "id", path),
    imageSuffix: requireStringAllowEmpty(record, "imageSuffix", path),
    dockerfileTarget: requireString(record, "dockerfileTarget", path),
  };
}

function parseDockerPlatform(value: unknown, index: number): DockerPlatform {
  const path = `docker.platforms[${index}]`;
  const record = requireRecord(value, path);
  const targetArch = requireString(record, "targetArch", path);
  if (targetArch !== "amd64" && targetArch !== "arm64") {
    throw new Error(`${path}.targetArch must be amd64 or arm64`);
  }
  return {
    id: requireString(record, "id", path),
    platform: requireString(record, "platform", path),
    targetArch,
    targetId: requireString(record, "targetId", path),
  };
}

function parseDockerChannel(value: unknown, channel: DockerChannelName): DockerChannel {
  const path = `docker.channels.${channel}`;
  const record = requireRecord(value, path);
  const platforms = requireArray(record["platforms"], `${path}.platforms`).map((platform, index) => {
    if (typeof platform !== "string" || platform.length === 0) {
      throw new Error(`${path}.platforms[${index}] must be a non-empty string`);
    }
    return platform;
  });
  const tags = requireArray(record["tags"], `${path}.tags`).map((tag, index) => {
    if (typeof tag !== "string" || tag.length === 0) {
      throw new Error(`${path}.tags[${index}] must be a non-empty string`);
    }
    requireNoNewlines(tag, `${path}.tags[${index}]`);
    return tag;
  });
  return { platforms, tags };
}

function validateUnique(values: string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${path} contains duplicate value: ${value}`);
    }
    seen.add(value);
  }
}

function validateBinaryDefinitions(binaries: ReleaseBinary[]): void {
  if (binaries.length === 0) {
    throw new Error("binaries must not be empty");
  }
  validateUnique(binaries.map((binary) => binary.id), "binaries.id");
  validateUnique(binaries.map((binary) => binary.name), "binaries.name");
  validateUnique(
    binaries.map((binary) => binary.installedFilename),
    "binaries.installedFilename",
  );
  validateUnique(binaries.map((binary) => binary.assetPrefix), "binaries.assetPrefix");

  for (const [index, binary] of binaries.entries()) {
    const path = `binaries[${index}]`;
    requireSafeToken(binary.id, `${path}.id`);
    requireSafeToken(binary.name, `${path}.name`);
    requireSafeToken(binary.installedFilename, `${path}.installedFilename`);
    requireSafeToken(binary.assetPrefix, `${path}.assetPrefix`);
    validateTemplate(binary.buildCommand, `${path}.buildCommand`, "BUN_TARGET");
    validateTemplate(binary.outputPath, `${path}.outputPath`, "RELEASE_TARGET");
    if (binary.outputPath.includes("..")) {
      throw new Error(`${path}.outputPath must not contain parent-directory traversal`);
    }
    requireNoNewlines(binary.postInstallMessage, `${path}.postInstallMessage`);
  }

  const [firstBinary] = binaries;
  if (firstBinary === undefined) {
    throw new Error("binaries must not be empty");
  }
  for (const binary of binaries.slice(1)) {
    if (
      binary.checksum.required !== firstBinary.checksum.required
      || binary.checksum.extension !== firstBinary.checksum.extension
    ) {
      throw new Error("all binary checksum policies must match the installer manifest policy");
    }
  }
}

function validateTargets(targets: ReleaseTarget[]): void {
  if (targets.length === 0) {
    throw new Error("targets must not be empty");
  }
  validateUnique(targets.map((target) => target.id), "targets.id");
  validateUnique(targets.map((target) => target.bunTarget), "targets.bunTarget");

  for (const [index, target] of targets.entries()) {
    const path = `targets[${index}]`;
    requireSafeToken(target.id, `${path}.id`);
    requireSafeToken(target.runner, `${path}.runner`);
    requireSafeToken(target.bunTarget, `${path}.bunTarget`);
    if (target.id !== `${target.os}-${target.architecture}`) {
      throw new Error(`${path}.id must match ${path}.os and ${path}.architecture`);
    }
    if (target.bunTarget !== `bun-${target.os}-${target.architecture}`) {
      throw new Error(`${path}.bunTarget does not match its OS and architecture`);
    }
    const expectedRunnerPrefix = {
      linux: "ubuntu-",
      darwin: "macos-",
      windows: "windows-",
    }[target.os];
    if (!target.runner.startsWith(expectedRunnerPrefix)) {
      throw new Error(`${path}.runner does not support its target OS`);
    }
    const expectedExtension = target.os === "windows" ? ".exe" : "";
    if (target.executableExtension !== expectedExtension) {
      throw new Error(`${path}.executableExtension must be ${JSON.stringify(expectedExtension)}`);
    }
  }
}

function validateDockerMetadata(docker: DockerMetadata, targets: ReleaseTarget[], repo: string): void {
  if (docker.images.length === 0) {
    throw new Error("docker.images must not be empty");
  }
  if (docker.platforms.length === 0) {
    throw new Error("docker.platforms must not be empty");
  }
  validateUnique(docker.images.map((image) => image.id), "docker.images.id");
  validateUnique(docker.images.map((image) => image.dockerfileTarget), "docker.images.dockerfileTarget");
  validateUnique(docker.platforms.map((platform) => platform.id), "docker.platforms.id");
  validateUnique(docker.platforms.map((platform) => platform.platform), "docker.platforms.platform");
  validateUnique(docker.platforms.map((platform) => platform.targetArch), "docker.platforms.targetArch");

  for (const [index, image] of docker.images.entries()) {
    const path = `docker.images[${index}]`;
    requireSafeToken(image.id, `${path}.id`);
    requireSafeSuffix(image.imageSuffix, `${path}.imageSuffix`);
    requireSafeToken(image.dockerfileTarget, `${path}.dockerfileTarget`);
  }

  const targetById = new Map(targets.map((target) => [target.id, target]));
  for (const [index, platform] of docker.platforms.entries()) {
    const path = `docker.platforms[${index}]`;
    requireSafeToken(platform.id, `${path}.id`);
    requireSafeToken(platform.targetArch, `${path}.targetArch`);
    const target = targetById.get(platform.targetId);
    if (target === undefined) {
      throw new Error(`${path}.targetId references an unknown target: ${platform.targetId}`);
    }
    if (target.os !== "linux") {
      throw new Error(`${path}.targetId must reference a Linux target`);
    }
    if (platform.platform !== `linux/${platform.targetArch}`) {
      throw new Error(`${path}.platform must match targetArch`);
    }
    const expectedArch = target.architecture === "x64" ? "amd64" : "arm64";
    if (platform.targetArch !== expectedArch) {
      throw new Error(`${path}.targetArch does not match its target architecture`);
    }
  }

  const platformNames = new Set(docker.platforms.map((platform) => platform.platform));
  for (const channel of dockerChannelNames) {
    const definition = docker.channels[channel];
    if (definition === undefined) {
      throw new Error(`docker.channels.${channel} is required`);
    }
    if (definition.platforms.length === 0 || definition.tags.length === 0) {
      throw new Error(`docker.channels.${channel} must define platforms and tags`);
    }
    validateUnique(definition.platforms, `docker.channels.${channel}.platforms`);
    validateUnique(definition.tags, `docker.channels.${channel}.tags`);
    for (const platform of definition.platforms) {
      if (!platformNames.has(platform)) {
        throw new Error(`docker.channels.${channel} references an unknown platform: ${platform}`);
      }
    }
  }

  const imageNames = docker.images.map((image) => `${repo}${image.imageSuffix}`);
  validateUnique(imageNames, "docker image names");
  for (const requiredImage of ["server", "relay"]) {
    if (!docker.images.some((image) => image.id === requiredImage)) {
      throw new Error(`docker.images must define ${requiredImage}`);
    }
  }
}

export function validateReleaseMetadata(value: unknown): ReleaseMetadata {
  const record = requireRecord(value, "release metadata");
  requireLiteralOne(record, "schemaVersion", "release metadata");
  const repo = requireString(record, "repo", "release metadata");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("release metadata.repo must be in owner/repository form");
  }
  const installDir = requireString(record, "installDir", "release metadata");
  requireNoNewlines(installDir, "release metadata.installDir");
  const binaries = requireArray(record["binaries"], "binaries").map(parseBinary);
  const targets = requireArray(record["targets"], "targets").map(parseTarget);
  const dockerRecord = requireRecord(record["docker"], "docker");
  const images = requireArray(dockerRecord["images"], "docker.images").map(parseDockerImage);
  const platforms = requireArray(dockerRecord["platforms"], "docker.platforms").map(parseDockerPlatform);
  const channelRecord = requireRecord(dockerRecord["channels"], "docker.channels");
  const channels = {
    release: parseDockerChannel(channelRecord["release"], "release"),
    main: parseDockerChannel(channelRecord["main"], "main"),
  };
  const metadata: ReleaseMetadata = {
    schemaVersion: 1,
    repo,
    installDir,
    binaries,
    targets,
    docker: { images, platforms, channels },
  };

  validateBinaryDefinitions(binaries);
  validateTargets(targets);
  validateDockerMetadata(metadata.docker, targets, repo);
  return metadata;
}

export async function loadReleaseMetadata(path = canonicalMetadataPath): Promise<ReleaseMetadata> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch (error) {
    throw new Error(`Unable to read release metadata at ${path}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Release metadata at ${path} is not valid JSON`, { cause: error });
  }
  return validateReleaseMetadata(parsed);
}

export function installerTargets(metadata: ReleaseMetadata): InstallerTarget[] {
  return metadata.targets.map((target) => ({
    os: target.runner,
    target: target.id,
    bun_target: target.bunTarget,
  }));
}

export function installerBinaries(metadata: ReleaseMetadata): InstallerBinary[] {
  return metadata.binaries.map((binary) => ({
    name: binary.name,
    asset_prefix: binary.assetPrefix,
    build_command: binary.buildCommand,
    output_path: binary.outputPath,
  }));
}

export function installerChecksumGeneration(metadata: ReleaseMetadata): boolean {
  const [firstBinary] = metadata.binaries;
  if (firstBinary === undefined) {
    throw new Error("Cannot determine checksum generation without a binary");
  }
  return firstBinary.checksum.required;
}

export function installerManifest(metadata: ReleaseMetadata): InstallerManifest {
  const [firstBinary] = metadata.binaries;
  if (firstBinary === undefined) {
    throw new Error("Cannot generate an installer manifest without a binary");
  }
  const platforms = Object.fromEntries(
    releaseOsValues.map((os) => [
      os,
      metadata.targets
        .filter((target) => target.os === os)
        .map((target) => target.architecture),
    ]),
  ) as Record<ReleaseOs, ReleaseArchitecture[]>;
  return {
    schemaVersion: 1,
    repo: metadata.repo,
    installDir: metadata.installDir,
    binaries: metadata.binaries.map((binary) => ({
      name: binary.installedFilename,
      assetPrefix: binary.assetPrefix,
      postInstallMessage: binary.postInstallMessage,
    })),
    checksums: firstBinary.checksum,
    platforms,
  };
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildReleaseAssetName(
  binary: ReleaseBinary,
  tag: string,
  target: ReleaseTarget,
): string {
  requireSafeToken(tag, "release tag");
  return `${binary.assetPrefix}-${tag}-${target.id}${target.executableExtension}`;
}

export function buildReleaseChecksumName(
  binary: ReleaseBinary,
  tag: string,
  target: ReleaseTarget,
): string {
  return `${buildReleaseAssetName(binary, tag, target)}${binary.checksum.extension}`;
}

function findDockerImage(metadata: ReleaseMetadata, id: "server" | "relay"): DockerImage {
  const image = metadata.docker.images.find((candidate) => candidate.id === id);
  if (image === undefined) {
    throw new Error(`Docker image metadata is missing ${id}`);
  }
  return image;
}

function parseDockerChannelName(value: string): DockerChannelName {
  if (!dockerChannelNames.includes(value as DockerChannelName)) {
    throw new Error(`Unknown Docker channel: ${value}`);
  }
  return value as DockerChannelName;
}

export function dockerConfig(
  metadata: ReleaseMetadata,
  channel: DockerChannelName,
): DockerConfig {
  const channelMetadata = metadata.docker.channels[channel];
  if (channelMetadata === undefined) {
    throw new Error(`Unknown Docker channel: ${channel}`);
  }
  const server = findDockerImage(metadata, "server");
  const relay = findDockerImage(metadata, "relay");
  return {
    repository: metadata.repo,
    platforms: channelMetadata.platforms.join(","),
    tags: channelMetadata.tags.join("\n"),
    images: {
      server: {
        name: `${metadata.repo}${server.imageSuffix}`,
        dockerfileTarget: server.dockerfileTarget,
      },
      relay: {
        name: `${metadata.repo}${relay.imageSuffix}`,
        dockerfileTarget: relay.dockerfileTarget,
      },
    },
  };
}

export function dockerBunTarget(metadata: ReleaseMetadata, targetArch: string): string {
  const platform = metadata.docker.platforms.find((candidate) => candidate.targetArch === targetArch);
  if (platform === undefined) {
    throw new Error(`No Docker target is defined for TARGETARCH=${targetArch}`);
  }
  const target = metadata.targets.find((candidate) => candidate.id === platform.targetId);
  if (target === undefined) {
    throw new Error(`Docker target ${platform.targetId} is not defined in release targets`);
  }
  return target.bunTarget;
}

async function checkInstallerManifest(metadata: ReleaseMetadata): Promise<void> {
  let actual: string;
  try {
    actual = await Bun.file(installerManifestPath).text();
  } catch (error) {
    throw new Error(`Unable to read generated installer manifest at ${installerManifestPath}`, {
      cause: error,
    });
  }
  const expected = formatJson(installerManifest(metadata));
  if (actual !== expected) {
    throw new Error(
      `${installerManifestPath} is out of date; run 'bun run release:metadata:generate'`,
    );
  }
}

async function generateInstallerManifest(metadata: ReleaseMetadata): Promise<void> {
  await Bun.write(installerManifestPath, formatJson(installerManifest(metadata)));
}

function requireArgument(args: string[], index: number, name: string): string {
  const value = args[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

export async function runReleaseMetadataCommand(args: string[]): Promise<void> {
  const command = args[0] ?? "check";
  const metadata = await loadReleaseMetadata();
  switch (command) {
    case "validate":
      console.log("Release metadata is valid.");
      return;
    case "check":
      await checkInstallerManifest(metadata);
      console.log("Release metadata and generated installer manifest are up to date.");
      return;
    case "generate-installer":
      await generateInstallerManifest(metadata);
      console.log(`Generated ${installerManifestPath}.`);
      return;
    case "installer-targets":
      process.stdout.write(JSON.stringify(installerTargets(metadata)));
      return;
    case "installer-binaries":
      process.stdout.write(JSON.stringify(installerBinaries(metadata)));
      return;
    case "installer-checksums":
      process.stdout.write(String(installerChecksumGeneration(metadata)));
      return;
    case "docker-config":
      process.stdout.write(JSON.stringify(dockerConfig(
        metadata,
        parseDockerChannelName(requireArgument(args, 1, "Docker channel")),
      )));
      return;
    case "docker-bun-target":
      process.stdout.write(dockerBunTarget(metadata, requireArgument(args, 1, "Docker architecture")));
      return;
    case "asset-name": {
      const binary = metadata.binaries.find((candidate) => candidate.id === requireArgument(args, 1, "binary ID"));
      if (binary === undefined) {
        throw new Error(`Unknown binary ID: ${args[1]}`);
      }
      const target = metadata.targets.find((candidate) => candidate.id === requireArgument(args, 2, "release target"));
      if (target === undefined) {
        throw new Error(`Unknown release target: ${args[2]}`);
      }
      process.stdout.write(buildReleaseAssetName(binary, requireArgument(args, 3, "release tag"), target));
      return;
    }
    default:
      throw new Error(`Unknown release metadata command: ${command}`);
  }
}

if (import.meta.main) {
  try {
    await runReleaseMetadataCommand(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
