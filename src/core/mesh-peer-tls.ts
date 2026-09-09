/**
 * TLS trust configuration for controller-to-worker connections.
 *
 * HTTP workers are an explicit opt-out. HTTPS workers are trusted only through
 * the certificate captured during enrollment.
 */

import type { MeshWorkerRegistration } from "@/shared/mesh";
import { assertMeshWorkerTlsCertificate } from "../persistence/mesh-worker-tls";
import { DomainError } from "./domain-error";

export function getMeshWorkerTlsOptions(
  registration: Pick<
    MeshWorkerRegistration,
    "workerTransport" | "workerEndpoint" | "workerTlsCertificate" | "workerTlsFingerprint"
  >,
): Bun.TLSOptions | undefined {
  if (registration.workerTransport === "http") {
    return undefined;
  }
  if (!registration.workerTlsCertificate || !registration.workerTlsFingerprint) {
    throw new DomainError(
      "mesh_worker_tls_identity_missing",
      "The HTTPS worker registration has no trusted TLS certificate.",
    );
  }
  assertMeshWorkerTlsCertificate(
    registration.workerTlsCertificate,
    registration.workerEndpoint,
    registration.workerTlsFingerprint,
  );
  return {
    ca: registration.workerTlsCertificate,
    rejectUnauthorized: true,
  };
}
