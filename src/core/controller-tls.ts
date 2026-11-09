import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { readWebAppConfig, webAppConfigPath } from "@pablozaiden/webapp/server";
import { DomainError } from "../domain/domain-error";
import { getDataDir } from "../persistence/database";
import {
  createControllerTlsIdentity,
  readControllerTlsIdentity,
  writeControllerTlsIdentity,
  type ControllerTlsIdentity,
} from "../persistence/controller-tls";
import { normalizeMeshEnrollmentTarget } from "./mesh-target-discovery";
import { assertSelfSignedTlsCertificate } from "../lib/tls-certificate";

let activeIdentity: ControllerTlsIdentity | undefined;

function controllerEndpoint(endpoint: string): string {
  const normalized = normalizeMeshEnrollmentTarget(endpoint);
  if (["0.0.0.0", "[::]"].includes(new URL(normalized).hostname)) {
    throw new DomainError("controller_tls_endpoint_invalid", "The controller endpoint must name a reachable host, not a wildcard bind address.");
  }
  if (new URL(normalized).hostname.startsWith("[")) {
    throw new DomainError("controller_tls_endpoint_unsupported", "Use an IPv4 address or DNS hostname. This Bun runtime cannot validate WebSockets addressed by a literal IPv6 URL.");
  }
  return normalized;
}

export async function configureControllerTls(input: {
  enabled: boolean;
  endpoint?: string;
  rotate?: boolean;
}): Promise<ControllerTlsIdentity | null> {
  const dataDir = getDataDir();
  const config = readWebAppConfig(dataDir);
  let identity: ControllerTlsIdentity | null = null;
  if (input.enabled) {
    const endpoint = controllerEndpoint(input.endpoint ?? String(config.serve?.options?.["managed-tls-endpoint"] ?? ""));
    // Deliberate rotation can recover a lost, malformed or expired identity.
    const existing = input.rotate ? null : await readControllerTlsIdentity();
    if (!existing && config.serve?.options?.["managed-tls"] === true && !input.rotate) {
      throw new DomainError("controller_tls_identity_missing", "The enabled controller has lost its TLS identity. Explicitly rotate it and re-enroll workers.");
    }
    if (existing && new URL(existing.endpoint).hostname !== new URL(endpoint).hostname) {
      throw new DomainError("controller_tls_endpoint_changed", "Changing the controller hostname requires explicit TLS rotation and fresh worker enrollment.");
    }
    identity = existing ? { ...existing, endpoint } : await createControllerTlsIdentity(endpoint);
    await writeControllerTlsIdentity(identity, { replace: Boolean(existing || input.rotate) });
  }
  const next = {
    ...config,
    ...(identity ? {
      server: {
        ...config.server,
        port: Number(new URL(identity.endpoint).port || "443"),
      },
    } : {}),
    serve: {
      ...config.serve,
      options: {
        ...config.serve?.options,
        "managed-tls": input.enabled,
        ...(identity ? { "managed-tls-endpoint": identity.endpoint } : {}),
      },
    },
  };
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = webAppConfigPath(dataDir);
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return identity;
}

export async function loadManagedControllerTls(endpoint: string): Promise<ControllerTlsIdentity> {
  const normalized = controllerEndpoint(endpoint);
  const identity = await readControllerTlsIdentity();
  if (!identity || readWebAppConfig(getDataDir()).serve?.options?.["managed-tls"] !== true) {
    const configured = await configureControllerTls({ enabled: true, endpoint: normalized });
    if (!configured) throw new Error("Managed controller TLS initialization did not create an identity.");
    return configured;
  }
  if (new URL(identity.endpoint).hostname !== new URL(normalized).hostname) {
    throw new DomainError("controller_tls_endpoint_changed", "Changing the controller hostname requires explicit TLS rotation.");
  }
  return { ...identity, endpoint: normalized };
}

export function setActiveControllerTls(identity: ControllerTlsIdentity | undefined): void {
  activeIdentity = identity;
}

export function getControllerEnrollmentCertificate(target: string): string | undefined {
  if (!activeIdentity) return undefined;
  if (new URL(target).origin !== activeIdentity.endpoint) {
    throw new DomainError("controller_tls_endpoint_mismatch", "The invitation endpoint does not match the managed HTTPS listener.");
  }
  assertSelfSignedTlsCertificate(activeIdentity.certificate, new URL(target).hostname, activeIdentity.fingerprint);
  return activeIdentity.certificate;
}
