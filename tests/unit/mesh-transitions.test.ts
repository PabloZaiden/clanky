import { describe, expect, test } from "bun:test";
import {
  decideAcceptEnrollment,
  decideEnrollWorker,
  decideRevokeWorker,
} from "../../src/domain/mesh-transitions";
import type {
  MeshControllerGrant,
  MeshWorkerRegistration,
} from "../../src/shared/mesh";
import { DomainError } from "../../src/domain/domain-error";

const registration: MeshWorkerRegistration = {
  workerNodeId: "worker",
  workerInstanceName: "Worker",
  workerEndpoint: "https://worker.example",
  workerTransport: "https",
  workerPublicKey: "public",
  workerFingerprint: "fingerprint",
  workerEncryptionPublicKey: null,
  workerDirectory: "/srv/worker",
  workerCapabilities: {},
  workerAcceptRemoteExecution: true,
  workerConfigRevision: 1,
  grantStatus: "active",
  localUserId: "owner",
  lastSeenAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const grant: MeshControllerGrant = {
  controllerNodeId: "controller",
  controllerInstanceName: "Controller",
  controllerPublicKey: "public",
  controllerFingerprint: "fingerprint",
  controllerEncryptionPublicKey: null,
  grantStatus: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("controller-worker Mesh transitions", () => {
  test("enrollment is idempotent and revoked grants can be re-enrolled", () => {
    expect(decideEnrollWorker({
      existingRegistration: registration,
      workerNodeId: "worker",
      localNodeId: "controller",
    })).toEqual({ kind: "idempotent" });
    expect(decideAcceptEnrollment({
      existingGrant: { ...grant, grantStatus: "revoked" },
      controllerNodeId: "controller",
      localNodeId: "worker",
    })).toEqual({ kind: "apply" });
  });

  test("revocation changes only an active registration", () => {
    expect(decideRevokeWorker({ registration })).toEqual({ kind: "apply" });
    expect(decideRevokeWorker({
      registration: { ...registration, grantStatus: "revoked" },
    })).toEqual({ kind: "idempotent" });
  });

  test("rejects self-enrollment", () => {
    expect(() => decideEnrollWorker({
      existingRegistration: null,
      workerNodeId: "same",
      localNodeId: "same",
    })).toThrow(DomainError);
  });
});
