/**
 * Unit tests for file explorer full-tree loading preference.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let testDataDir: string;

describe("File Explorer Full Tree Preference", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-test-"));
    process.env["RALPHER_DATA_DIR"] = testDataDir;

    const { ensureDataDirectories } = await import("../../src/persistence/database");
    await ensureDataDirectories();
  });

  afterEach(async () => {
    const { closeDatabase } = await import("../../src/persistence/database");
    closeDatabase();

    delete process.env["RALPHER_DATA_DIR"];
    await rm(testDataDir, { recursive: true });
  });

  test("returns true by default when not set", async () => {
    const { getFileExplorerFullTreeEnabled } = await import("../../src/persistence/preferences");
    expect(await getFileExplorerFullTreeEnabled()).toBe(true);
  });

  test("persists false when lazy loading is selected", async () => {
    const { getFileExplorerFullTreeEnabled, setFileExplorerFullTreeEnabled } = await import(
      "../../src/persistence/preferences"
    );

    await setFileExplorerFullTreeEnabled(false);
    expect(await getFileExplorerFullTreeEnabled()).toBe(false);
  });

  test("persists true across module reimports", async () => {
    const preferences = await import("../../src/persistence/preferences");
    await preferences.setFileExplorerFullTreeEnabled(true);

    const { getFileExplorerFullTreeEnabled } = await import("../../src/persistence/preferences");
    expect(await getFileExplorerFullTreeEnabled()).toBe(true);
  });
});
