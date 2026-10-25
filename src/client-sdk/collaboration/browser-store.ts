/**
 * Browser-only pairing metadata and nonextractable private-key custody.
 */

import {
  CollaborationConnectionSchema, type CreateCollaborationConnection,
} from "@/contracts/schemas/collaboration";
import type { CollaborationConnection, CollaborationGuestGrant } from "@/shared/collaboration";
import { COLLABORATION_MAX_CONNECTIONS } from "@/shared/collaboration";
import { DomainError } from "../../domain/domain-error";
import {
  generateClientSigningKey, signClientPayload, verifyClientSignature,
} from "./crypto";
import {
  activateCollaborationPairing, assertCollaborationPairingRevision, assertCollaborationPairingUsable,
  collaborationPairingRevision, createPendingCollaborationPairing,
} from "./pairing-state";
import type { CollaborationPairingSnapshot, CollaborationPairingStore } from "./store";
import type { CollaborationSigningIdentity } from "./types";
import { browserStorageTransaction, openBrowserPairingDatabase } from "./browser-storage";

interface BrowserPairingRecord {
  connection: CollaborationConnection;
  privateKey: CryptoKey | null;
}

function decodeRecord(value: unknown): BrowserPairingRecord {
  if (typeof value !== "object" || value === null || !("connection" in value) || !("privateKey" in value)) {
    throw new DomainError("collaboration_storage_failed", "The stored browser pairing is invalid.");
  }
  const parsed = CollaborationConnectionSchema.safeParse(value.connection);
  if (!parsed.success) {
    throw new DomainError("collaboration_storage_failed", "The stored browser pairing metadata is invalid.", { cause: parsed.error });
  }
  const key = value.privateKey;
  if (key !== null && (!(key instanceof CryptoKey) || key.type !== "private" || key.extractable
    || key.algorithm.name !== "Ed25519" || !key.usages.includes("sign"))) {
    throw new DomainError("collaboration_identity_unavailable", "The stored pairing key is not a nonextractable Ed25519 key.");
  }
  if (parsed.data.status !== "revoked" && key === null) {
    throw new DomainError("collaboration_identity_unavailable", "The stored pairing key is missing. Forget this pairing and accept a new invitation.");
  }
  return { connection: parsed.data, privateKey: key };
}

function snapshot(connection: CollaborationConnection): CollaborationPairingSnapshot {
  return { connection, revision: collaborationPairingRevision(connection) };
}

export async function requireBrowserCollaborationSupport(): Promise<void> {
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle || !globalThis.indexedDB
    || !globalThis.navigator?.locks?.request) {
    throw new DomainError("collaboration_browser_unsupported",
      "Use a browser with IndexedDB, Web Locks and Ed25519 Web Crypto on HTTPS or localhost.");
  }
  try {
    const key = await generateClientSigningKey();
    const payload = "clanky-browser-key-capability-v1";
    if (!await verifyClientSignature(payload, await signClientPayload(key.privateKey, payload), key.publicKey)) {
      throw new Error("The browser could not verify its own Ed25519 signature.");
    }
  } catch (error) {
    throw new DomainError("collaboration_browser_unsupported", "This browser does not support the required Ed25519 keys.", {
      cause: error,
    });
  }
}

export class BrowserCollaborationPairingStore implements CollaborationPairingStore {
  private closed = false;

  private constructor(
    private readonly database: IDBDatabase,
    readonly scope: string,
    onUnavailable?: (error: DomainError) => void,
  ) {
    database.onversionchange = (): void => {
      this.close();
      onUnavailable?.(new DomainError("collaboration_storage_unavailable",
        "Browser pairing storage changed or was removed. Reload Clanky to reconnect."));
    };
    database.onclose = (): void => {
      if (this.closed) return;
      this.closed = true;
      onUnavailable?.(new DomainError("collaboration_storage_unavailable", "Browser pairing storage closed unexpectedly."));
    };
  }

  static async open(options: {
    databaseName: string;
    onUnavailable?(error: DomainError): void;
  }): Promise<BrowserCollaborationPairingStore> {
    await requireBrowserCollaborationSupport();
    const database = await openBrowserPairingDatabase(options.databaseName);
    try {
      const candidateScope = `browser:${crypto.randomUUID()}`;
      const scope = await browserStorageTransaction<string>(database, ["metadata", "pairings"], "readwrite", (tx, task) => {
        const metadata = tx.objectStore("metadata");
        task.request(metadata.get("profile"), (value: unknown) => {
          if (value !== undefined) {
            if (typeof value !== "string" || !/^browser:[a-f0-9-]{36}$/.test(value)) {
              throw new DomainError("collaboration_storage_failed", "The browser pairing profile is invalid.");
            }
            task.result(value);
            return;
          }
          task.request(tx.objectStore("pairings").count(), (count: number) => {
            if (count > 0) {
              throw new DomainError("collaboration_storage_failed", "The pairing profile is missing but stored identities remain.");
            }
            metadata.add(candidateScope, "profile");
            task.result(candidateScope);
          });
        });
      });
      return new BrowserCollaborationPairingStore(database, scope, options.onUnavailable);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new DomainError("collaboration_storage_unavailable", "Browser pairing storage is closed.");
  }

  async list(): Promise<CollaborationConnection[]> {
    this.assertOpen();
    return await browserStorageTransaction(this.database, ["pairings"], "readonly", (tx, task) => {
      task.request(tx.objectStore("pairings").getAll(), (values: unknown[]) => {
        task.result(values.map((value) => decodeRecord(value).connection)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)));
      });
    });
  }

  private async read(connectionId: string): Promise<BrowserPairingRecord> {
    this.assertOpen();
    return await browserStorageTransaction(this.database, ["pairings"], "readonly", (tx, task) => {
      task.request(tx.objectStore("pairings").get(connectionId), (value: unknown) => {
        if (value === undefined) throw new DomainError("collaboration_connection_not_found", "Connection not found.");
        task.result(decodeRecord(value));
      });
    });
  }

  async get(connectionId: string): Promise<CollaborationPairingSnapshot> {
    return snapshot((await this.read(connectionId)).connection);
  }

  async createPending(input: CreateCollaborationConnection): Promise<CollaborationPairingSnapshot> {
    this.assertOpen();
    const key = await generateClientSigningKey();
    const connection = await createPendingCollaborationPairing(input, {
      nodeId: crypto.randomUUID(), publicKey: key.publicKey, fingerprint: key.fingerprint,
    });
    this.assertOpen();
    return await browserStorageTransaction(this.database, ["pairings"], "readwrite", (tx, task) => {
      const pairings = tx.objectStore("pairings");
      task.request(pairings.getAll(), (values: unknown[]) => {
        const records = values.map(decodeRecord);
        const previous = records.find((record) => record.connection.status === "pending"
          && Date.parse(record.connection.pendingExpiresAt) > Date.now()
          && record.connection.controller.nodeId === connection.controller.nodeId
          && record.connection.controller.fingerprint === connection.controller.fingerprint
          && record.connection.relayUrl === connection.relayUrl
          && record.connection.relayFingerprint === connection.relayFingerprint);
        if (previous) {
          task.result(snapshot(previous.connection));
          return;
        }
        if (records.length >= COLLABORATION_MAX_CONNECTIONS) {
          throw new DomainError("collaboration_connection_limit", "Remove an unused connection before creating another.");
        }
        pairings.add({ connection, privateKey: key.privateKey } satisfies BrowserPairingRecord);
        task.result(snapshot(connection));
      });
    });
  }

  async loadIdentity(expected: CollaborationPairingSnapshot): Promise<CollaborationSigningIdentity> {
    const record = await this.read(expected.connection.id);
    assertCollaborationPairingRevision(record.connection, expected.revision);
    assertCollaborationPairingUsable(record.connection);
    const identity = record.connection.identity;
    const sign = async (payload: string): Promise<string> => {
      const current = await this.read(record.connection.id);
      assertCollaborationPairingUsable(current.connection);
      if (!current.privateKey || current.connection.identity.nodeId !== identity.nodeId
        || current.connection.identity.publicKey !== identity.publicKey
        || current.connection.identity.fingerprint !== identity.fingerprint) {
        throw new DomainError("collaboration_identity_unavailable", "The persisted pairing identity changed.");
      }
      const signature = await signClientPayload(current.privateKey, payload);
      if (!await verifyClientSignature(payload, signature, identity.publicKey)) {
        throw new DomainError("collaboration_identity_unavailable", "The stored pairing key does not match its public identity.");
      }
      const after = await this.read(record.connection.id);
      assertCollaborationPairingUsable(after.connection);
      if (after.connection.identity.publicKey !== identity.publicKey
        || after.connection.identity.nodeId !== identity.nodeId
        || after.connection.identity.fingerprint !== identity.fingerprint || !after.privateKey) {
        throw new DomainError("collaboration_identity_unavailable", "The persisted pairing identity changed while signing.");
      }
      return signature;
    };
    await sign(`clanky-pairing-key-check-v1:${record.connection.id}`);
    return { ...identity, sign };
  }

  private async update<T>(
    expected: CollaborationPairingSnapshot,
    operation: (record: BrowserPairingRecord, pairings: IDBObjectStore) => T,
  ): Promise<T> {
    this.assertOpen();
    return await browserStorageTransaction(this.database, ["pairings"], "readwrite", (tx, task) => {
      const pairings = tx.objectStore("pairings");
      task.request(pairings.get(expected.connection.id), (value: unknown) => {
        if (value === undefined) throw new DomainError("collaboration_connection_not_found", "Connection not found.");
        const record = decodeRecord(value);
        assertCollaborationPairingRevision(record.connection, expected.revision);
        task.result(operation(record, pairings));
      });
    });
  }

  async activate(expected: CollaborationPairingSnapshot, grant: CollaborationGuestGrant): Promise<CollaborationPairingSnapshot> {
    return await this.update(expected, (record, pairings) => {
      const connection = activateCollaborationPairing(record.connection, grant.id, expected.revision);
      pairings.put({ connection, privateKey: record.privateKey } satisfies BrowserPairingRecord);
      return snapshot(connection);
    });
  }

  async revoke(expected: CollaborationPairingSnapshot): Promise<void> {
    await this.update(expected, (record, pairings) => {
      pairings.put({
        connection: { ...record.connection, status: "revoked" }, privateKey: null,
      } satisfies BrowserPairingRecord);
    });
  }

  async forget(expected: CollaborationPairingSnapshot): Promise<void> {
    await this.update(expected, (_record, pairings) => { pairings.delete(expected.connection.id); });
  }

  close(): void {
    this.closed = true;
    this.database.onversionchange = null;
    this.database.onclose = null;
    this.database.close();
  }
}
