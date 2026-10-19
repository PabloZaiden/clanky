/**
 * Owns bounded, expiring native history continuations and their iterators.
 */
import { createLogger } from "@pablozaiden/webapp/server";
import type { HarnessHistoryEvent, HarnessSessionHistory } from "@/shared/harness-history";
import { HarnessError } from "./harness-errors";
import { recoverNativeSessionHistory } from "./native-session-history";

const log = createLogger("native-history-reader");
const MAX_READERS = 8;
const PAGE_EVENTS = 512;
const PAGE_BYTES = 1024 * 1024;
const CURSOR_TTL_MS = 60_000;

interface HistoryReader {
  sessionId: string;
  source: AsyncGenerator<HarnessHistoryEvent[]>;
  processing: () => Promise<boolean>;
  pending?: HarnessHistoryEvent[];
  cursor?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export class NativeHistoryReader {
  private readonly cursors = new Map<string, HistoryReader>();
  private readonly sessions = new Map<string, HistoryReader>();
  private readonly operations = new Set<Promise<HarnessSessionHistory>>();
  private closing = false;

  open(): void { this.closing = false; }

  read(options: {
    sessionId: string;
    cursor?: string;
    source: () => AsyncGenerator<HarnessHistoryEvent[]>;
    processing: () => Promise<boolean>;
  }): Promise<HarnessSessionHistory> {
    if (this.closing) throw new HarnessError("harness_transport_closed", "Native history recovery is closing.");
    let reader: HistoryReader;
    if (options.cursor) {
      const previous = this.cursors.get(options.cursor);
      if (!previous || previous.sessionId !== options.sessionId) throw new HarnessError("harness_event_gap", "The native history cursor expired or belongs to a different conversation.");
      reader = previous;
      this.cursors.delete(options.cursor);
      clearTimeout(reader.timer);
      reader.cursor = undefined;
    } else {
      if (this.sessions.has(options.sessionId)) throw new HarnessError("harness_event_gap", "Native history recovery is already in progress.");
      if (this.sessions.size >= MAX_READERS) throw new HarnessError("harness_input_capacity", "Native history recovery capacity was reached.");
      reader = { sessionId: options.sessionId, source: options.source(), processing: options.processing };
      this.sessions.set(options.sessionId, reader);
    }
    const operation = recoverNativeSessionHistory(() => this.page(reader))
      .finally(() => { this.operations.delete(operation); });
    this.operations.add(operation);
    return operation;
  }

  private async page(reader: HistoryReader): Promise<HarnessSessionHistory> {
    const events: HarnessHistoryEvent[] = [];
    let bytes = 0;
    let done = false;
    try {
      while (!this.closing) {
        const next = reader.pending ? { done: false, value: reader.pending } : await reader.source.next();
        reader.pending = undefined;
        if (next.done) { done = true; break; }
        const size = Buffer.byteLength(JSON.stringify(next.value));
        if (events.length && (events.length + next.value.length > PAGE_EVENTS || bytes + size > PAGE_BYTES)) {
          reader.pending = next.value;
          break;
        }
        events.push(...next.value);
        bytes += size;
        if (events.length >= PAGE_EVENTS || bytes >= PAGE_BYTES) break;
      }
      if (this.closing) throw new HarnessError("harness_transport_closed", "Native history recovery closed.");
      const principalProcessing = await reader.processing();
      if (done) {
        await this.retire(reader);
        return { events, principalProcessing };
      }
      const nextCursor = crypto.randomUUID();
      reader.cursor = nextCursor;
      this.cursors.set(nextCursor, reader);
      reader.timer = setTimeout(() => {
        void this.retire(reader).catch((error: unknown) => {
          log.warn("Native history cursor cleanup failed", { errorType: error instanceof Error ? error.name : typeof error });
        });
      }, CURSOR_TTL_MS);
      return { events, principalProcessing, nextCursor };
    } catch (error) {
      await this.retire(reader);
      throw error;
    }
  }

  async forget(sessionId: string): Promise<void> {
    await Promise.allSettled(this.operations);
    const reader = this.sessions.get(sessionId);
    if (reader) await this.retire(reader);
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.operations);
    await Promise.all([...this.sessions.values()].map((reader) => this.retire(reader)));
  }

  private async retire(reader: HistoryReader): Promise<void> {
    clearTimeout(reader.timer);
    if (reader.cursor) this.cursors.delete(reader.cursor);
    this.sessions.delete(reader.sessionId);
    await reader.source.return(undefined);
  }
}
