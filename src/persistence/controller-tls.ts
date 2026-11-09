import { chmod, link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  assertSelfSignedTlsCertificate,
  assertTlsPrivateKey,
  getTlsCertificateFingerprint,
} from "../lib/tls-certificate";
import { createSelfSignedTlsIdentity } from "../lib/self-signed-tls";
import { DomainError } from "../domain/domain-error";
import { getDataDir } from "./database";

const identitySchema = z.object({
  version: z.literal(1),
  endpoint: z.url(),
  certificate: z.string().max(32 * 1024),
  privateKey: z.string().max(32 * 1024),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
});

export type ControllerTlsIdentity = z.infer<typeof identitySchema>;

function identityPath(dataDir = getDataDir()): string {
  return join(dataDir, "mesh", "controller-tls.json");
}

export function validateControllerTlsIdentity(identity: ControllerTlsIdentity): void {
  const endpoint = new URL(identity.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.origin !== identity.endpoint) {
    throw new DomainError("controller_tls_identity_invalid", "The controller TLS endpoint is invalid.");
  }
  try {
    assertSelfSignedTlsCertificate(identity.certificate, endpoint.hostname, identity.fingerprint);
    assertTlsPrivateKey(identity.certificate, identity.privateKey);
  } catch (error) {
    throw new DomainError("controller_tls_identity_invalid", "The controller TLS identity is invalid or expired.", { cause: error });
  }
}

export async function readControllerTlsIdentity(dataDir = getDataDir()): Promise<ControllerTlsIdentity | null> {
  const file = Bun.file(identityPath(dataDir));
  if (!await file.exists()) return null;
  let identity: ControllerTlsIdentity;
  try {
    identity = identitySchema.parse(await file.json());
  } catch (error) {
    throw new DomainError("controller_tls_identity_invalid", "The stored controller TLS identity is malformed.", { cause: error });
  }
  validateControllerTlsIdentity(identity);
  return identity;
}

export async function createControllerTlsIdentity(endpoint: string): Promise<ControllerTlsIdentity> {
  const now = new Date();
  const keys = await createSelfSignedTlsIdentity({
    name: "CN=Clanky Controller",
    hostnames: [...new Set([new URL(endpoint).hostname.replace(/^\[|\]$/g, ""), "localhost", "127.0.0.1", "::1"])],
    notBefore: new Date(now.getTime() - 5 * 60 * 1000),
    notAfter: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
  });
  return {
    version: 1,
    endpoint,
    ...keys,
    fingerprint: getTlsCertificateFingerprint(keys.certificate),
    createdAt: now.toISOString(),
  };
}

export async function writeControllerTlsIdentity(
  identity: ControllerTlsIdentity,
  options: { replace: boolean },
): Promise<void> {
  validateControllerTlsIdentity(identity);
  const path = identityPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (options.replace) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
