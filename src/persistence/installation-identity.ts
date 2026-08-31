/**
 * Stable identity for the local Clanky installation.
 *
 * This identifier is deliberately stored outside the Mesh signing identity.
 * Rotating or rejoining Mesh must not change the identity of the local
 * execution host used by workspace terminal bindings.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getDataDir } from "./database";
import { DomainError } from "../domain/domain-error";

const INSTALLATION_ID_FILE_NAME = "installation-id";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let installationIdPromise: Promise<string> | undefined;

function installationIdPath(): string {
  return join(getDataDir(), INSTALLATION_ID_FILE_NAME);
}

function validateInstallationId(value: string): string {
  const normalized = value.trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new DomainError(
      "installation_identity_invalid",
      "The local installation identity is invalid.",
    );
  }
  return normalized;
}

async function loadOrCreateInstallationId(): Promise<string> {
  const path = installationIdPath();
  const file = Bun.file(path);
  if (await file.exists()) {
    return validateInstallationId(await file.text());
  }

  await mkdir(dirname(path), { recursive: true });
  const generated = crypto.randomUUID();
  try {
    await writeFile(path, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      throw new DomainError(
        "installation_identity_write_failed",
        "The local installation identity could not be persisted.",
        { cause: error },
      );
    }
  }
  await chmod(path, 0o600);
  return validateInstallationId((await readFile(path, "utf8")).trim());
}

/**
 * Return the durable local installation ID, coalescing concurrent first-use
 * calls so two startup paths cannot create competing identities.
 */
export async function ensureLocalInstallationId(): Promise<string> {
  installationIdPromise ??= loadOrCreateInstallationId().catch((error: unknown) => {
    installationIdPromise = undefined;
    throw error;
  });
  return await installationIdPromise;
}
