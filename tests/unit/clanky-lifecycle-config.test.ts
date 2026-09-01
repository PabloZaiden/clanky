import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClankyCli } from "../../src/cli";

const originalHome = process.env["HOME"];
const originalDataDir = process.env["CLANKY_DATA_DIR"];
const temporaryRoots: string[] = [];

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  if (originalDataDir === undefined) {
    delete process.env["CLANKY_DATA_DIR"];
  } else {
    process.env["CLANKY_DATA_DIR"] = originalDataDir;
  }
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function readServeConfig(): Promise<{
  path: string;
  effective: { dataDir: string; configPath?: string };
}> {
  const result = await createClankyCli().execute(["serve", "config", "show"]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.output ?? "") as {
    path: string;
    effective: { dataDir: string; configPath?: string };
  };
}

describe("Clanky lifecycle state configuration", () => {
  test("defaults local state to .clanky under HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "clanky-home-test-"));
    temporaryRoots.push(home);
    process.env["HOME"] = home;
    delete process.env["CLANKY_DATA_DIR"];

    const config = await readServeConfig();

    expect(config.effective.dataDir).toBe(join(home, ".clanky"));
    expect(config.path).toBe(join(home, ".clanky", "config.json"));
  });

  test("uses CLANKY_DATA_DIR as the complete state override", async () => {
    const home = await mkdtemp(join(tmpdir(), "clanky-home-test-"));
    temporaryRoots.push(home);
    const dataDir = join(home, "custom-state");
    process.env["HOME"] = home;
    process.env["CLANKY_DATA_DIR"] = dataDir;

    const config = await readServeConfig();

    expect(config.effective.dataDir).toBe(dataDir);
    expect(config.path).toBe(join(dataDir, "config.json"));
  });
});
