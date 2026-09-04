import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClankyCli } from "../../src/cli";
import { closeDatabase } from "../../src/persistence/database";
import {
  getWebAppServer,
  resetWebAppServerForTests,
} from "../../src/server";

const originalHome = process.env["HOME"];
const originalDataDir = process.env["CLANKY_DATA_DIR"];
const originalMeshWorker = process.env["CLANKY_MESH_WORKER"];
const temporaryRoots: string[] = [];

afterEach(async () => {
  resetWebAppServerForTests();
  closeDatabase();
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
  if (originalMeshWorker === undefined) {
    delete process.env["CLANKY_MESH_WORKER"];
  } else {
    process.env["CLANKY_MESH_WORKER"] = originalMeshWorker;
  }
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function readServeConfig(): Promise<{
  path: string;
  config: {
    serve?: {
      options?: Record<string, boolean | number | string>;
    };
  };
  effective: {
    application: Record<string, boolean | number | string | undefined>;
    dataDir: string;
    configPath?: string;
  };
}> {
  const result = await createClankyCli().execute(["serve", "config", "show"]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.output ?? "") as {
    path: string;
    config: {
      serve?: {
        options?: Record<string, boolean | number | string>;
      };
    };
    effective: {
      application: Record<string, boolean | number | string | undefined>;
      dataDir: string;
      configPath?: string;
    };
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

  test("resolves Mesh-worker mode from persisted config and environment", async () => {
    const home = await mkdtemp(join(tmpdir(), "clanky-home-test-"));
    temporaryRoots.push(home);
    process.env["HOME"] = home;
    delete process.env["CLANKY_DATA_DIR"];
    delete process.env["CLANKY_MESH_WORKER"];
    const cli = createClankyCli();

    const defaults = await readServeConfig();
    expect(defaults.effective.application["mesh-worker"]).toBe(false);

    const configured = await cli.execute([
      "serve",
      "config",
      "set",
      "mesh-worker",
      "true",
    ]);
    expect(configured.exitCode).toBe(0);
    const persisted = await readServeConfig();
    expect(persisted.config.serve?.options?.["mesh-worker"]).toBe(true);
    expect(persisted.effective.application["mesh-worker"]).toBe(true);

    process.env["CLANKY_MESH_WORKER"] = "false";
    const overridden = await readServeConfig();
    expect(overridden.config.serve?.options?.["mesh-worker"]).toBe(true);
    expect(overridden.effective.application["mesh-worker"]).toBe(false);
  });

  test("rejects changing the mode of an initialized server singleton", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clanky-server-mode-test-"));
    temporaryRoots.push(dataDir);
    process.env["CLANKY_DATA_DIR"] = dataDir;

    const server = await getWebAppServer({ meshWorker: false });
    expect(await getWebAppServer({ meshWorker: false })).toBe(server);
    await expect(getWebAppServer({ meshWorker: true })).rejects.toThrow(
      "Clanky server is already initialized with meshWorker=false and cannot be reused with meshWorker=true",
    );

    resetWebAppServerForTests();
    closeDatabase();
    const workerServer = await getWebAppServer({ meshWorker: true });
    expect(await getWebAppServer({ meshWorker: true })).toBe(workerServer);
  });
});
