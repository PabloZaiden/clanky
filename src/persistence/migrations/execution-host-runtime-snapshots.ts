/**
 * Backfills canonical Mesh execution hosts from their worker registrations.
 */

import type { Database } from "bun:sqlite";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  executionHostRefFromParts,
  parseExecutionHostRuntimeSnapshot,
} from "../../shared/execution-host";

const log = createLogger(
  "persistence:migrations:execution-host-runtime-snapshots",
);

interface MeshHostRow {
  id: string;
  user_id: string;
  source_id: string;
}

interface MeshRegistrationRow {
  worker_node_id: string;
  local_user_id: string;
  worker_capabilities_json: string | null;
  worker_platform_os: string | null;
  worker_platform_architecture: string | null;
  registration_scope: string;
  workspace_worker_enrollment_id: string | null;
  workspace_id: string | null;
}

function registrationMatchesHost(
  host: MeshHostRow,
  registration: MeshRegistrationRow,
): boolean {
  if (host.user_id !== registration.local_user_id) {
    return false;
  }
  const ref = executionHostRefFromParts("mesh", host.source_id);
  if (
    !ref
    || ref.kind !== "mesh"
    || ref.nodeId !== registration.worker_node_id
  ) {
    return false;
  }
  if (!("scope" in ref)) {
    return registration.registration_scope === "global";
  }
  if (ref.scope === "enrollment") {
    return registration.registration_scope === "workspace"
      && ref.enrollmentId === registration.workspace_worker_enrollment_id;
  }
  return registration.registration_scope === "workspace"
    && ref.workspaceId === registration.workspace_id;
}

export function backfillMeshExecutionHostRuntimeSnapshots(
  db: Database,
): void {
  const hosts = db.query(`
    SELECT id, user_id, source_id
    FROM execution_hosts
    WHERE kind = 'mesh'
  `).all() as MeshHostRow[];
  const registrations = db.query(`
    SELECT
      worker_node_id,
      local_user_id,
      worker_capabilities_json,
      worker_platform_os,
      worker_platform_architecture,
      registration_scope,
      workspace_worker_enrollment_id,
      workspace_id
    FROM mesh_worker_registrations
  `).all() as MeshRegistrationRow[];
  const updateHost = db.query(`
    UPDATE execution_hosts
    SET platform_os = ?,
        platform_architecture = ?,
        capabilities_json = ?
    WHERE id = ? AND user_id = ?
  `);

  for (const host of hosts) {
    const registration = registrations.find((candidate) =>
      registrationMatchesHost(host, candidate)
    );
    if (!registration) {
      continue;
    }

    let capabilities: unknown;
    try {
      capabilities = JSON.parse(
        registration.worker_capabilities_json ?? "{}",
      ) as unknown;
    } catch (error) {
      log.warn("Skipping invalid Mesh runtime snapshot during migration", {
        hostId: host.id,
        workerNodeId: registration.worker_node_id,
        error: String(error),
      });
      continue;
    }
    const runtime = parseExecutionHostRuntimeSnapshot(
      {
        os: registration.worker_platform_os,
        architecture: registration.worker_platform_architecture,
      },
      capabilities,
    );
    if (!runtime) {
      log.warn("Skipping inconsistent Mesh runtime snapshot during migration", {
        hostId: host.id,
        workerNodeId: registration.worker_node_id,
      });
      continue;
    }

    updateHost.run(
      runtime.platform?.os ?? null,
      runtime.platform?.architecture ?? null,
      JSON.stringify(runtime.capabilities),
      host.id,
      host.user_id,
    );
  }
}
