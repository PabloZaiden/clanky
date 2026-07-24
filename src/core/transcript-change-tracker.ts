import {
  createTranscriptChangeSet,
  type TranscriptChangeSet,
  type TranscriptEntryDelete,
  type TranscriptEntryKind,
  type TranscriptEntryPayload,
  type TranscriptEntryUpsert,
  type PersistedMessage,
  type TaskLogEntry,
  type ToolCallRecord,
} from "@/shared";

interface VersionedChange {
  version: number;
  entry?: TranscriptEntryUpsert;
  deleted: boolean;
}

export interface TranscriptChangeSnapshot {
  changes: TranscriptChangeSet;
  versions: Map<string, number>;
}

/**
 * Tracks live transcript mutations without rebuilding the complete state.
 *
 * Versions let a failed or concurrent checkpoint acknowledge only the changes
 * it actually wrote, leaving newer mutations pending for the next checkpoint.
 */
export class TranscriptChangeTracker {
  private readonly changes = new Map<string, VersionedChange>();
  private nextVersion = 0;

  recordUpsert(
    kind: TranscriptEntryKind,
    payload: TranscriptEntryPayload,
  ): void {
    const key = `${kind}:${payload.id}`;
    this.nextVersion += 1;
    this.changes.set(key, {
      version: this.nextVersion,
      entry: {
        id: payload.id,
        kind,
        timestamp: payload.timestamp,
        payload,
      },
      deleted: false,
    });
  }

  recordDelete(kind: TranscriptEntryKind, id: string): void {
    const key = `${kind}:${id}`;
    this.nextVersion += 1;
    this.changes.set(key, {
      version: this.nextVersion,
      deleted: true,
    });
  }

  snapshot(state: {
    messages: PersistedMessage[];
    logs: TaskLogEntry[];
    toolCalls: ToolCallRecord[];
  }): TranscriptChangeSnapshot {
    const upserts: TranscriptEntryUpsert[] = [];
    const deletes: TranscriptEntryDelete[] = [];
    const versions = new Map<string, number>();

    for (const [key, change] of this.changes) {
      versions.set(key, change.version);
      if (change.deleted) {
        const [kind, ...idParts] = key.split(":");
        deletes.push({
          kind: kind as TranscriptEntryKind,
          id: idParts.join(":"),
        });
      } else if (change.entry) {
        upserts.push(change.entry);
      }
    }

    return {
      changes: createTranscriptChangeSet(state, upserts, deletes),
      versions,
    };
  }

  acknowledge(snapshot: TranscriptChangeSnapshot): void {
    for (const [key, version] of snapshot.versions) {
      if (this.changes.get(key)?.version === version) {
        this.changes.delete(key);
      }
    }
  }

  hasPendingChanges(): boolean {
    return this.changes.size > 0;
  }
}
