import type { MeshWorkerUpdateRequest } from "@/contracts/schemas/mesh";
import type { MeshWorkerUpdateStatus } from "@/shared/mesh";
import { createLogger } from "@pablozaiden/webapp/server";
import { CLANKY_VERSION } from "../version";
import { getDataDir } from "../persistence/database";
import { rename } from "node:fs/promises";
import { verifyMeshPayloadSignature } from "../persistence/mesh-node-identity";
import { DomainError } from "./domain-error";
import { requireTrustedController } from "./mesh-peer-auth";
import { buildMeshWorkerUpdateSigningPayload } from "./mesh-protocol";
import {
  createWorkerHandoffParent,
  workerHandoffEnvironment,
} from "./mesh-worker-handoff";
import { requireMeshRuntimeRole } from "./mesh-runtime";

const log = createLogger("core:mesh-worker-update");
const usedNonces = new Set<string>();
const MAX_USED_NONCES = 1_000;
let stopWorker: (() => Promise<void>) | undefined;

const status: MeshWorkerUpdateStatus = {
  operationId: null,
  state: "idle",
  fromVersion: CLANKY_VERSION,
  targetVersion: null,
  startedAt: null,
  completedAt: null,
  error: null,
};

async function persistStatus(): Promise<void> {
  const path = `${getDataDir()}/mesh-worker-update.json`;
  const temporaryPath = `${path}.${String(process.pid)}.tmp`;
  await Bun.write(temporaryPath, `${JSON.stringify(status, null, 2)}\n`);
  await rename(temporaryPath, path);
}

export function configureMeshWorkerShutdown(stop: () => Promise<void>): void {
  stopWorker = stop;
}

function assertStandaloneBinary(): void {
  if (!Bun.main.startsWith("/$bunfs/") && !Bun.main.includes("\\$bunfs\\")) {
    throw new DomainError(
      "mesh_worker_update_unsupported",
      "Remote worker updates require a compiled Clanky binary.",
    );
  }
}

async function verifyRequest(envelope: MeshWorkerUpdateRequest): Promise<void> {
  requireMeshRuntimeRole("worker");
  if (Date.parse(envelope.expiresAt) <= Date.now()) {
    throw new DomainError("mesh_worker_update_expired", "The worker update request has expired.");
  }
  if (usedNonces.has(envelope.nonce)) {
    throw new DomainError("mesh_worker_update_replay", "The worker update request was already used.");
  }
  await requireTrustedController({
    controllerNodeId: envelope.controllerNodeId,
    publicKey: envelope.controllerPublicKey,
    fingerprint: envelope.controllerFingerprint,
    requireEncryptionKey: false,
    context: "worker update controller",
  });
  const { signature, ...unsigned } = envelope;
  if (!await verifyMeshPayloadSignature(
    buildMeshWorkerUpdateSigningPayload(unsigned),
    signature,
    envelope.controllerPublicKey,
  )) {
    throw new DomainError(
      "mesh_worker_update_invalid_signature",
      "The worker update request signature is invalid.",
    );
  }
  if (usedNonces.size >= MAX_USED_NONCES) {
    usedNonces.delete(usedNonces.values().next().value!);
  }
  usedNonces.add(envelope.nonce);
}

async function runCommand(command: string[]): Promise<{ output: string; error: string }> {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(error.trim() || `Command exited with code ${String(exitCode)}`);
  }
  return { output: output.trim(), error: error.trim() };
}

function parseVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:[-+][^\s]+)?)\b/);
  return match?.[1] ?? null;
}

async function performUpdate(): Promise<void> {
  let handoff: Awaited<ReturnType<typeof createWorkerHandoffParent>> | undefined;
  try {
    assertStandaloneBinary();
    await runCommand([process.execPath, "update"]);
    const version = await runCommand([process.execPath, "version"]);
    status.targetVersion = parseVersion(version.output);
    if (!status.targetVersion || status.targetVersion === CLANKY_VERSION) {
      status.state = "succeeded";
      status.completedAt = new Date().toISOString();
      await persistStatus();
      return;
    }

    status.state = "handoff";
    await persistStatus();
    handoff = await createWorkerHandoffParent();
    const child = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...workerHandoffEnvironment(handoff.socketPath, handoff.token),
        CLANKY_WORKER_HANDOFF_FROM_VERSION: CLANKY_VERSION,
        CLANKY_WORKER_HANDOFF_TARGET_VERSION: status.targetVersion,
        CLANKY_WORKER_HANDOFF_OPERATION_ID: status.operationId ?? "",
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await handoff.waitForReady();
    if (!stopWorker) {
      throw new Error("Worker shutdown lifecycle is not configured");
    }
    await stopWorker();
    handoff.proceed();
    await handoff.waitForStarted();
    status.state = "succeeded";
    status.completedAt = new Date().toISOString();
    await persistStatus();
    child.unref();
    await handoff.close();
    handoff = undefined;
    process.exit(0);
  } catch (error) {
    status.state = "failed";
    status.error = String(error);
    status.completedAt = new Date().toISOString();
    await persistStatus().catch((persistError) => {
      log.error("Failed to persist Mesh worker update failure", {
        error: String(persistError),
      });
    });
    log.error("Mesh worker update failed", { error: String(error) });
  } finally {
    await handoff?.close().catch((error) => {
      log.warn("Failed to clean up worker handoff socket", { error: String(error) });
    });
  }
}

export const meshWorkerUpdate = {
  async getStatus(operationId: string): Promise<MeshWorkerUpdateStatus> {
    const persisted = await Bun.file(`${getDataDir()}/mesh-worker-update.json`)
      .json()
      .catch(() => null) as MeshWorkerUpdateStatus | null;
    const current = persisted?.operationId === operationId ? persisted : status;
    return { ...current };
  },
  async request(envelope: MeshWorkerUpdateRequest): Promise<MeshWorkerUpdateStatus> {
    await verifyRequest(envelope);
    if (envelope.action === "status") {
      return await this.getStatus(envelope.operationId);
    }
    if (status.state === "updating" || status.state === "handoff") {
      if (status.operationId !== envelope.operationId) {
        throw new DomainError(
          "mesh_worker_update_in_progress",
          "Another worker update is already in progress.",
        );
      }
      return { ...status };
    }
    status.operationId = envelope.operationId;
    status.state = "updating";
    status.fromVersion = CLANKY_VERSION;
    status.targetVersion = null;
    status.startedAt = new Date().toISOString();
    status.completedAt = null;
    status.error = null;
    await persistStatus();
    void performUpdate();
    return { ...status };
  },
};
