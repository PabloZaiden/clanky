import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureMeshWorkerTlsIdentity,
  getMeshWorkerTlsIdentity,
} from "../../src/persistence/mesh-worker-tls";

let dataDir: string;
const originalDataDir = process.env["CLANKY_DATA_DIR"];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-worker-tls-"));
  process.env["CLANKY_DATA_DIR"] = dataDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) {
    delete process.env["CLANKY_DATA_DIR"];
  } else {
    process.env["CLANKY_DATA_DIR"] = originalDataDir;
  }
  await rm(dataDir, { recursive: true, force: true });
});

describe("Mesh worker TLS identity", () => {
  test("reports malformed private keys as private-key failures", async () => {
    await ensureMeshWorkerTlsIdentity("https://127.0.0.1:3000");
    const identityPath = join(dataDir, "mesh", "worker-tls.json");
    const stored = JSON.parse(await Bun.file(identityPath).text()) as Record<string, unknown>;
    stored["privateKey"] = "not a private key";
    await Bun.write(identityPath, `${JSON.stringify(stored)}\n`);

    await expect(getMeshWorkerTlsIdentity()).rejects.toMatchObject({
      code: "mesh_worker_tls_private_key_invalid",
      message: "The stored Mesh worker TLS private key is invalid or does not match the certificate.",
    });
  });
});
