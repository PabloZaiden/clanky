/**
 * Serializes memory-first checkpoints while preserving mutations that arrive
 * during an in-flight write.
 */
export class MemoryFirstPersistenceQueue {
  private persistenceInFlight: Promise<void> | null = null;
  private persistenceRequested = false;
  private operationalPersistenceDirty: boolean;
  private operationalPersistenceVersion = 0;

  constructor(initialOperationalPersistenceDirty = false) {
    this.operationalPersistenceDirty = initialOperationalPersistenceDirty;
  }

  get isOperationalPersistenceDirty(): boolean {
    return this.operationalPersistenceDirty;
  }

  get operationalVersion(): number {
    return this.operationalPersistenceVersion;
  }

  markOperationalPersistenceDirty(): void {
    this.operationalPersistenceDirty = true;
    this.operationalPersistenceVersion += 1;
    if (this.persistenceInFlight) {
      this.persistenceRequested = true;
    }
  }

  acknowledgeOperationalPersistence(version: number): void {
    if (this.operationalPersistenceVersion === version) {
      this.operationalPersistenceDirty = false;
    } else {
      this.persistenceRequested = true;
    }
  }

  request(persistCurrentState: () => Promise<void>): Promise<void> {
    this.persistenceRequested = true;
    if (!this.persistenceInFlight) {
      this.persistenceInFlight = this.drain(persistCurrentState);
    }
    return this.persistenceInFlight;
  }

  private async drain(persistCurrentState: () => Promise<void>): Promise<void> {
    try {
      do {
        this.persistenceRequested = false;
        await persistCurrentState();
      } while (this.persistenceRequested);
    } finally {
      this.persistenceInFlight = null;
    }
  }
}
