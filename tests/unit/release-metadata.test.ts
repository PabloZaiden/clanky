/**
 * These tests protect the published artifact and workflow metadata contract,
 * which is not practical to verify through a live release workflow.
 */
import { describe, expect, test } from "bun:test";
import {
  buildReleaseAssetName,
  buildReleaseChecksumName,
  dockerBunTarget,
  dockerConfig,
  formatJson,
  installerBinaries,
  installerManifest,
  installerManifestPath,
  installerTargets,
  loadReleaseMetadata,
  validateReleaseMetadata,
} from "../../scripts/release-metadata";

describe("release metadata", () => {
  test("preserves the six supported installer targets and binary projection", async () => {
    const metadata = await loadReleaseMetadata();

    expect(installerTargets(metadata)).toEqual([
      {
        os: "ubuntu-latest",
        target: "linux-x64",
        bun_target: "bun-linux-x64",
      },
      {
        os: "ubuntu-latest",
        target: "linux-arm64",
        bun_target: "bun-linux-arm64",
      },
      {
        os: "macos-latest",
        target: "darwin-x64",
        bun_target: "bun-darwin-x64",
      },
      {
        os: "macos-latest",
        target: "darwin-arm64",
        bun_target: "bun-darwin-arm64",
      },
      {
        os: "windows-latest",
        target: "windows-x64",
        bun_target: "bun-windows-x64",
      },
      {
        os: "windows-latest",
        target: "windows-arm64",
        bun_target: "bun-windows-arm64",
      },
    ]);
    expect(installerBinaries(metadata)).toEqual([
      {
        name: "clanky",
        asset_prefix: "clanky",
        build_command: "bun src/build.ts --target=$BUN_TARGET",
        output_path: "dist/clanky-$RELEASE_TARGET",
      },
    ]);
  });

  test("keeps release asset and checksum names stable for both tag forms", async () => {
    const metadata = await loadReleaseMetadata();
    const binary = metadata.binaries[0];
    const linuxTarget = metadata.targets.find((target) => target.id === "linux-x64");
    const windowsTarget = metadata.targets.find((target) => target.id === "windows-arm64");
    if (binary === undefined || linuxTarget === undefined || windowsTarget === undefined) {
      throw new Error("Expected current release metadata entries are missing");
    }

    expect(buildReleaseAssetName(binary, "v1.2.3", linuxTarget))
      .toBe("clanky-v1.2.3-linux-x64");
    expect(buildReleaseChecksumName(binary, "v1.2.3", linuxTarget))
      .toBe("clanky-v1.2.3-linux-x64.sha256");
    expect(buildReleaseAssetName(binary, "1.2.3", windowsTarget))
      .toBe("clanky-1.2.3-windows-arm64.exe");
    expect(buildReleaseChecksumName(binary, "1.2.3", windowsTarget))
      .toBe("clanky-1.2.3-windows-arm64.exe.sha256");
  });

  test("generates the committed installer manifest deterministically", async () => {
    const metadata = await loadReleaseMetadata();
    const manifest = installerManifest(metadata);
    const expectedText = formatJson(manifest);
    const actualText = await Bun.file(installerManifestPath).text();

    expect(formatJson(manifest)).toBe(expectedText);
    expect(actualText).toBe(expectedText);
    expect(JSON.parse(actualText) as unknown).toEqual(manifest);
  });

  test("preserves Docker channel policies, image targets, and architecture lookup", async () => {
    const metadata = await loadReleaseMetadata();
    const release = dockerConfig(metadata, "release");
    const main = dockerConfig(metadata, "main");

    expect(release.platforms).toBe("linux/amd64,linux/arm64");
    expect(release.tags).toBe([
      "type=semver,pattern={{version}}",
      "type=semver,pattern={{major}}.{{minor}}",
      "type=semver,pattern={{major}}",
      "type=raw,value=latest",
    ].join("\n"));
    expect(main.platforms).toBe("linux/amd64");
    expect(main.tags).toBe("type=raw,value=main");
    expect(release.images).toEqual({
      server: {
        name: "pablozaiden/clanky",
        dockerfileTarget: "server",
      },
      relay: {
        name: "pablozaiden/clanky-relay",
        dockerfileTarget: "relay",
      },
    });
    expect(dockerBunTarget(metadata, "amd64")).toBe("bun-linux-x64");
    expect(dockerBunTarget(metadata, "arm64")).toBe("bun-linux-arm64");
  });

  test("rejects duplicate, unsafe, inconsistent, and missing metadata references", async () => {
    const metadata = await loadReleaseMetadata();
    const invalidCases: Array<{
      label: string;
      mutate: (value: typeof metadata) => void;
      message: RegExp;
    }> = [
      {
        label: "duplicate target",
        mutate: (value) => {
          value.targets[1]!.id = value.targets[0]!.id;
        },
        message: /targets\.id contains duplicate value/,
      },
      {
        label: "unsafe asset prefix",
        mutate: (value) => {
          value.binaries[0]!.assetPrefix = "../clanky";
        },
        message: /binaries\[0\]\.assetPrefix contains unsafe characters/,
      },
      {
        label: "inconsistent Bun target",
        mutate: (value) => {
          value.targets[0]!.bunTarget = "bun-linux-arm64";
        },
        message: /targets\.bunTarget contains duplicate value|does not match/,
      },
      {
        label: "unsupported runner",
        mutate: (value) => {
          value.targets[0]!.runner = "macos-latest";
        },
        message: /targets\[0\]\.runner does not support its target OS/,
      },
      {
        label: "missing Docker target reference",
        mutate: (value) => {
          value.docker.platforms[0]!.targetId = "linux-missing";
        },
        message: /docker\.platforms\[0\]\.targetId references an unknown target/,
      },
      {
        label: "empty Docker channel",
        mutate: (value) => {
          value.docker.channels.main.platforms = [];
        },
        message: /docker\.channels\.main must define platforms and tags/,
      },
    ];

    for (const invalidCase of invalidCases) {
      const invalid = structuredClone(metadata);
      invalidCase.mutate(invalid);
      expect(() => validateReleaseMetadata(invalid), invalidCase.label)
        .toThrow(invalidCase.message);
    }
  });
});
