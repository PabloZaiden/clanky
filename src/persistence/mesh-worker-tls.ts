/**
 * Durable TLS identity for a Mesh worker.
 *
 * The certificate is public and is sent during enrollment. The private key
 * remains in the worker data directory and is only loaded by the worker
 * server.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  X509Certificate as NodeX509Certificate,
} from "node:crypto";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { DomainError } from "../domain/domain-error";
import { assertMeshEndpointAllowed } from "../core/mesh-transport-config";
import { getDataDir } from "./database";

const WORKER_TLS_FILE_NAME = "worker-tls.json";
const WORKER_TLS_FILE_VERSION = 1;
const WORKER_TLS_VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const WORKER_TLS_NOT_BEFORE_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

export interface MeshWorkerTlsIdentity {
  endpoint: string;
  certificate: string;
  privateKey: string;
  fingerprint: string;
  createdAt: string;
}

interface StoredMeshWorkerTlsIdentity extends MeshWorkerTlsIdentity {
  version: number;
}

let tlsIdentityMutationTail: Promise<void> = Promise.resolve();

async function withTlsIdentityMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previousMutation = tlsIdentityMutationTail;
  let releaseMutation: () => void = () => {};
  tlsIdentityMutationTail = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  await previousMutation;
  try {
    return await operation();
  } finally {
    releaseMutation();
  }
}

function workerTlsFilePath(): string {
  return join(getDataDir(), "mesh", WORKER_TLS_FILE_NAME);
}

function asPem(value: ArrayBuffer): string {
  const base64 = Buffer.from(value).toString("base64");
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

export function getMeshWorkerTlsFingerprint(certificate: string): string {
  try {
    const parsed = new NodeX509Certificate(certificate);
    return `sha256:${createHash("sha256").update(parsed.raw).digest("hex")}`;
  } catch (error) {
    throw new DomainError(
      "mesh_worker_tls_certificate_invalid",
      "The stored Mesh worker TLS certificate is invalid.",
      { cause: error },
    );
  }
}

function endpointHostname(endpoint: string): string {
  const parsed = assertMeshEndpointAllowed(endpoint, "https");
  return parsed.hostname.replace(/^\[|\]$/g, "");
}

export function assertMeshWorkerTlsCertificate(
  certificate: string,
  endpoint: string,
  expectedFingerprint?: string,
): string {
  let parsedCertificate: NodeX509Certificate;
  try {
    parsedCertificate = new NodeX509Certificate(certificate);
  } catch (error) {
    throw new DomainError(
      "mesh_worker_tls_certificate_invalid",
      "The Mesh worker TLS certificate is invalid.",
      { cause: error },
    );
  }
  try {
    if (!parsedCertificate.verify(parsedCertificate.publicKey)) {
      throw new Error("certificate is not self-signed");
    }
    const hostname = endpointHostname(endpoint);
    const matchesEndpoint = isIP(hostname) > 0
      ? parsedCertificate.checkIP(hostname)
      : parsedCertificate.checkHost(hostname);
    if (!matchesEndpoint) {
      throw new Error(`certificate does not cover ${hostname}`);
    }
  } catch (error) {
    throw new DomainError(
      "mesh_worker_tls_certificate_invalid",
      "The Mesh worker TLS certificate does not match its endpoint.",
      { cause: error },
    );
  }
  const fingerprint = getMeshWorkerTlsFingerprint(certificate);
  if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) {
    throw new DomainError(
      "mesh_worker_tls_certificate_invalid",
      "The Mesh worker TLS certificate fingerprint does not match the certificate.",
    );
  }
  return fingerprint;
}

function validateTlsIdentity(identity: StoredMeshWorkerTlsIdentity): StoredMeshWorkerTlsIdentity {
  if (
    identity.version !== WORKER_TLS_FILE_VERSION
    || typeof identity.endpoint !== "string"
    || typeof identity.certificate !== "string"
    || typeof identity.privateKey !== "string"
    || typeof identity.fingerprint !== "string"
    || typeof identity.createdAt !== "string"
  ) {
    throw new DomainError(
      "mesh_worker_tls_identity_invalid",
      "The stored Mesh worker TLS identity has an invalid shape.",
    );
  }
  let parsedCertificate: NodeX509Certificate;
  try {
    parsedCertificate = new NodeX509Certificate(identity.certificate);
  } catch (error) {
    throw new DomainError(
      "mesh_worker_tls_certificate_invalid",
      "The stored Mesh worker TLS certificate is invalid.",
      { cause: error },
    );
  }
  assertMeshWorkerTlsCertificate(
    identity.certificate,
    identity.endpoint,
    identity.fingerprint,
  );
  try {
    // Parsing the key here makes startup fail before Bun.serve receives a
    // malformed identity.
    const privateKey = createPrivateKey(identity.privateKey);
    const privatePublicKey = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });
    const certificatePublicKey = parsedCertificate.publicKey.export({
      format: "der",
      type: "spki",
    });
    if (!Buffer.from(privatePublicKey).equals(Buffer.from(certificatePublicKey))) {
      throw new Error("private key does not match certificate");
    }
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError(
      "mesh_worker_tls_certificate_invalid",
      "The stored Mesh worker TLS certificate does not match its endpoint.",
      { cause: error },
    );
  }
  if (!identity.privateKey.includes("BEGIN PRIVATE KEY")) {
    throw new DomainError(
      "mesh_worker_tls_private_key_invalid",
      "The stored Mesh worker TLS private key is invalid.",
    );
  }
  return identity;
}

async function readStoredTlsIdentity(): Promise<StoredMeshWorkerTlsIdentity | null> {
  const file = Bun.file(workerTlsFilePath());
  if (!(await file.exists())) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    throw new DomainError(
      "mesh_worker_tls_identity_invalid",
      "The stored Mesh worker TLS identity is not valid JSON.",
      { cause: error },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DomainError(
      "mesh_worker_tls_identity_invalid",
      "The stored Mesh worker TLS identity has an invalid shape.",
    );
  }
  return validateTlsIdentity(parsed as StoredMeshWorkerTlsIdentity);
}

async function writeStoredTlsIdentity(identity: StoredMeshWorkerTlsIdentity): Promise<void> {
  const path = workerTlsFilePath();
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${path}.tmp-${String(process.pid)}-${crypto.randomUUID()}`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`);
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function createTlsIdentity(endpoint: string): Promise<StoredMeshWorkerTlsIdentity> {
  const hostname = endpointHostname(endpoint);
  const algorithm = {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
    publicExponent: new Uint8Array([1, 0, 1]),
    modulusLength: 2048,
  } as const;
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const now = new Date();
  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: "CN=Clanky Mesh Worker",
    keys,
    signingAlgorithm: algorithm,
    notBefore: new Date(now.getTime() - WORKER_TLS_NOT_BEFORE_SKEW_MS),
    notAfter: new Date(now.getTime() + WORKER_TLS_VALIDITY_MS),
    extensions: [
      // Bun's per-connection CA validation requires the pinned self-signed
      // certificate to be a trust anchor.
      new BasicConstraintsExtension(true, 0, true),
      new KeyUsagesExtension(
        KeyUsageFlags.digitalSignature
          | KeyUsageFlags.keyEncipherment
          | KeyUsageFlags.keyCertSign,
        true,
      ),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth], true),
      new SubjectAlternativeNameExtension([
        { type: isIP(hostname) > 0 ? "ip" : "dns", value: hostname },
      ]),
      await SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const certificatePem = certificate.toString("pem");
  return {
    version: WORKER_TLS_FILE_VERSION,
    endpoint,
    certificate: certificatePem,
    privateKey: asPem(await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
    fingerprint: getMeshWorkerTlsFingerprint(certificatePem),
    createdAt: now.toISOString(),
  };
}

/**
 * Load or create the worker certificate. A hostname change requires explicit
 * rotation so already-enrolled controllers never silently lose their pin.
 */
export async function ensureMeshWorkerTlsIdentity(
  endpoint: string,
  options: { rotate?: boolean } = {},
): Promise<MeshWorkerTlsIdentity> {
  return await withTlsIdentityMutation(async () => {
    const normalizedEndpoint = assertMeshEndpointAllowed(endpoint, "https").origin;
    const existing = await readStoredTlsIdentity();
    if (existing && !options.rotate) {
      if (endpointHostname(existing.endpoint) !== endpointHostname(normalizedEndpoint)) {
        throw new DomainError(
          "mesh_worker_tls_endpoint_changed",
          "The Mesh worker endpoint hostname changed; rotate the worker TLS identity before restarting.",
        );
      }
      return existing;
    }
    const created = await createTlsIdentity(normalizedEndpoint);
    await writeStoredTlsIdentity(created);
    return created;
  });
}

export async function getMeshWorkerTlsIdentity(): Promise<MeshWorkerTlsIdentity | null> {
  const identity = await readStoredTlsIdentity();
  return identity;
}

export function getMeshWorkerServerTls(
  identity: MeshWorkerTlsIdentity,
): Bun.TLSOptions {
  return {
    cert: identity.certificate,
    key: identity.privateKey,
  };
}
