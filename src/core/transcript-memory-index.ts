/**
 * Mutable in-memory index for transcript collections.
 *
 * Unbounded collections use the supplied array directly. Bounded collections
 * use a ring buffer and a logical array view so ID updates and evictions stay
 * O(1) without retaining evicted entries.
 */
export class TranscriptMemoryIndex<T extends { id: string }> {
  private readonly indexes = new Map<string, number>();
  private readonly entries: T[];
  private readonly capacity: number | null;
  private readonly storage: T[] | null;
  private readonly valuesView: T[] | null;
  private start = 0;
  private size = 0;

  constructor(entries: T[], maxEntries = Number.POSITIVE_INFINITY) {
    if (!Number.isFinite(maxEntries)) {
      this.entries = entries;
      this.capacity = null;
      this.storage = null;
      this.valuesView = null;
      for (let index = 0; index < entries.length; index += 1) {
        this.indexes.set(entries[index]!.id, index);
      }
      return;
    }

    const capacity = Math.max(0, Math.floor(maxEntries));
    this.entries = [];
    this.capacity = capacity;
    this.storage = new Array<T>(capacity);
    this.valuesView = this.createValuesView();

    const initialEntries = capacity === 0 ? [] : entries.slice(-capacity);
    for (const entry of initialEntries) {
      this.storage[this.size] = entry;
      this.indexes.set(entry.id, this.size);
      this.size += 1;
    }
  }

  get values(): T[] {
    return this.valuesView ?? this.entries;
  }

  get(id: string): T | undefined {
    const index = this.indexes.get(id);
    if (index === undefined) {
      return undefined;
    }
    if (this.capacity === null) {
      return this.entries[index];
    }
    return this.storage?.[index];
  }

  has(id: string): boolean {
    return this.indexes.has(id);
  }

  upsert(entry: T): { evicted: T[]; inserted: boolean } {
    const existingIndex = this.indexes.get(entry.id);
    if (existingIndex !== undefined) {
      if (this.capacity === null) {
        if (this.entries[existingIndex]?.id === entry.id) {
          this.entries[existingIndex] = entry;
          return { evicted: [], inserted: false };
        }
      } else if (this.storage?.[existingIndex]?.id === entry.id) {
        this.storage[existingIndex] = entry;
        return { evicted: [], inserted: false };
      }
    }

    if (this.capacity === null) {
      this.entries.push(entry);
      this.indexes.set(entry.id, this.entries.length - 1);
      return { evicted: [], inserted: true };
    }

    if (this.capacity === 0) {
      return { evicted: [entry], inserted: true };
    }

    if (this.size < this.capacity) {
      const index = (this.start + this.size) % this.capacity;
      this.storage![index] = entry;
      this.indexes.set(entry.id, index);
      this.size += 1;
      return { evicted: [], inserted: true };
    }

    const index = this.start;
    const removed = this.storage![index]!;
    this.indexes.delete(removed.id);
    this.storage![index] = entry;
    this.indexes.set(entry.id, index);
    this.start = (this.start + 1) % this.capacity;
    return { evicted: [removed], inserted: true };
  }

  private createValuesView(): T[] {
    const target: T[] = [];
    return new Proxy(target, {
      get: (_target, property, receiver) => {
        if (property === "length") {
          return this.size;
        }
        const index = this.parseArrayIndex(property);
        if (index !== null) {
          return this.getAt(index);
        }
        return Reflect.get(target, property, receiver);
      },
      has: (_target, property) => {
        const index = this.parseArrayIndex(property);
        if (index !== null) {
          return index < this.size;
        }
        return Reflect.has(target, property);
      },
    });
  }

  private getAt(index: number): T | undefined {
    if (index < 0 || index >= this.size || this.capacity === null) {
      return undefined;
    }
    const storageIndex = (this.start + index) % this.capacity;
    return this.storage?.[storageIndex];
  }

  private parseArrayIndex(property: PropertyKey): number | null {
    if (typeof property !== "string" || property.length === 0) {
      return null;
    }
    const index = Number(property);
    return Number.isInteger(index) && index >= 0 && String(index) === property
      ? index
      : null;
  }
}
