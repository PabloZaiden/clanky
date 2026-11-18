import { closeSync, ftruncateSync, lstatSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "../domain/domain-error";
import type { HarnessEvent } from "@/shared/harness-events";
import type { EventStream } from "../utils/event-stream";

type Record = { event: HarnessEvent } | { offset: number; bytes: number };
const cleanedSpoolRoots = new Set<string>();

/** Unacknowledged execution events; only a detached or catching-up queue uses disk. */
export class MeshHarnessBacklog {
  readonly executionId = crypto.randomUUID();
  private readonly records = new Map<number, Record>();
  private sequence = 0;
  private acknowledged = 0;
  private file?: number;
  private directory?: string;
  private bytes = 0;
  private discardedBytes = 0;
  private detached = false;
  private closed = false;
  private failure?: Error;
  private readonly waiters = new Set<() => void>();
  private readonly text = new Map<string, { messages: Map<string, number>; reasoning: Map<string, number>; currentReasoning?: string }>();
  private readonly spoolPrefix: string;

  constructor(nodeId: string) {
    this.spoolPrefix = `clanky-mesh-events-${createHash("sha256").update(nodeId).digest("hex")}-`;
    const root = join(tmpdir(), this.spoolPrefix);
    if (cleanedSpoolRoots.has(root)) return;
    try {
      for (const name of readdirSync(tmpdir())) {
        if (!name.startsWith(this.spoolPrefix)) continue;
        const pid = Number(name.slice(this.spoolPrefix.length).split("-", 1)[0]);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        try { process.kill(pid, 0); continue; }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EPERM") continue;
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
        }
        const directory = join(tmpdir(), name);
        try {
          const stat = lstatSync(directory);
          if (stat.isDirectory() && (process.getuid === undefined || stat.uid === process.getuid())) {
            rmSync(directory, { recursive: true });
          }
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        }
      }
      cleanedSpoolRoots.add(root);
    } catch (error) { throw this.fail(error); }
  }

  get hasPending(): boolean { return this.records.size > 0; }
  get position(): { executionId: string; sequence: number; acknowledgedSequence: number } {
    return { executionId: this.executionId, sequence: this.sequence, acknowledgedSequence: this.acknowledged };
  }

  append(event: HarnessEvent): HarnessEvent {
    this.assertOpen();
    const scope = event.scope.kind === "child" ? event.scope.activityId : "principal";
    let text = this.text.get(scope);
    if (!text) {
      text = { messages: new Map(), reasoning: new Map() };
      this.text.set(scope, text);
    }
    let offset: number | undefined;
    if (event.type === "message.delta" && event.messageId) {
      offset = text.messages.get(event.messageId) ?? 0;
      text.messages.set(event.messageId, offset + event.content.length);
    } else if (event.type === "message.complete" && event.messageId) text.messages.delete(event.messageId);
    if (event.type === "reasoning.delta") {
      const reasoningId = event.reasoningId ?? text.currentReasoning ?? crypto.randomUUID();
      text.currentReasoning = reasoningId;
      offset = event.complete ? 0 : text.reasoning.get(reasoningId) ?? 0;
      text.reasoning.set(reasoningId, offset + event.content.length);
      event = { ...event, reasoningId };
    } else if (["message.start", "message.delta", "message.complete", "tool.start", "tool.complete", "prompt.complete", "error"].includes(event.type)) {
      text.currentReasoning = undefined;
      if (event.type === "prompt.complete") {
        text.reasoning.clear();
        if (!text.messages.size) this.text.delete(scope);
      }
    }
    const delivered: HarnessEvent = {
      ...event,
      delivery: { executionId: this.executionId, sequence: ++this.sequence, ...(offset === undefined ? {} : { offset }) },
    };
    try {
      this.records.set(this.sequence, this.file === undefined
        ? { event: delivered } : this.write(delivered));
      if (this.detached && this.file === undefined) this.detach();
    } catch (error) {
      throw this.fail(error);
    }
    this.wake();
    return delivered;
  }

  detach(): void {
    if (this.closed) return;
    this.assertOpen();
    this.detached = true;
    try {
      if (this.file === undefined && this.records.size) {
        this.directory = mkdtempSync(join(tmpdir(), `${this.spoolPrefix}${process.pid}-`));
        this.file = openSync(join(this.directory, "events.ndjson"), "wx+", 0o600);
        for (const [sequence, record] of this.records) {
          if ("event" in record) this.records.set(sequence, this.write(record.event));
        }
      }
    } catch (error) {
      throw this.fail(error);
    }
    this.wake();
  }

  subscribe(): EventStream<HarnessEvent> {
    this.assertOpen();
    this.detached = false;
    if (!this.records.size) {
      try { this.removeSpool(); } catch (error) { throw this.fail(error); }
    }
    let cursor = this.acknowledged;
    let closed = false;
    return {
      next: async () => {
        while (!closed && !this.closed) {
          this.assertOpen();
          const sequence = Math.max(cursor + 1, this.acknowledged + 1);
          const record = this.records.get(sequence);
          if (record) {
            cursor = sequence;
            try { return "event" in record ? record.event : this.read(record); }
            catch (error) { throw this.fail(error); }
          }
          await new Promise<void>((resolve) => {
            const wake = (): void => { this.waiters.delete(wake); resolve(); };
            this.waiters.add(wake);
            if (closed || this.closed || this.failure || this.records.has(sequence)) wake();
          });
        }
        if (this.failure) throw this.failure;
        return null;
      },
      close: () => { closed = true; this.wake(); },
    };
  }

  acknowledge(executionId: string, sequence: number): void {
    this.assertOpen();
    if (executionId !== this.executionId || !Number.isSafeInteger(sequence)
      || sequence < 0 || sequence > this.sequence) {
      throw new DomainError("harness_event_gap", "The remote event acknowledgement is invalid.");
    }
    if (sequence <= this.acknowledged) return;
    for (const [id, record] of this.records) {
      if (id > sequence) break;
      if ("bytes" in record) this.discardedBytes += record.bytes;
      this.records.delete(id);
    }
    this.acknowledged = sequence;
    try {
      if (!this.records.size && !this.detached) this.removeSpool();
      else if (this.file !== undefined && (!this.records.size
        || this.discardedBytes >= 1024 * 1024 && this.discardedBytes >= this.bytes / 2)) {
        this.bytes = 0;
        for (const [id, record] of this.records) {
          if ("offset" in record) this.records.set(id, this.write(this.read(record)));
        }
        ftruncateSync(this.file, this.bytes);
        this.discardedBytes = 0;
      }
    } catch (error) { throw this.fail(error); }
    this.wake();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.records.clear();
    this.text.clear();
    this.wake();
    this.removeSpool();
  }

  private write(event: HarnessEvent): { offset: number; bytes: number } {
    const buffer = Buffer.from(`${JSON.stringify(event)}\n`);
    const record = { offset: this.bytes, bytes: buffer.length };
    let written = 0;
    while (written < buffer.length) {
      const count = writeSync(this.file!, buffer, written, buffer.length - written, this.bytes + written);
      if (!count) throw new Error("The temporary remote event queue could not be written.");
      written += count;
    }
    this.bytes += written;
    return record;
  }

  private read(record: { offset: number; bytes: number }): HarnessEvent {
    const buffer = Buffer.allocUnsafe(record.bytes);
    let read = 0;
    while (read < record.bytes) {
      const count = readSync(this.file!, buffer, read, record.bytes - read, record.offset + read);
      if (!count) throw new Error("The temporary remote event queue is incomplete.");
      read += count;
    }
    return JSON.parse(buffer.toString()) as HarnessEvent;
  }

  private removeSpool(): void {
    const errors: unknown[] = [];
    if (this.file !== undefined) {
      const file = this.file;
      this.file = undefined;
      try { closeSync(file); } catch (error) { errors.push(error); }
    }
    if (this.directory) {
      try { rmSync(this.directory, { recursive: true }); this.directory = undefined; }
      catch (error) { errors.push(error); }
    }
    this.bytes = 0;
    this.discardedBytes = 0;
    if (errors.length) throw new AggregateError(errors, "The temporary remote event queue could not be removed.");
  }

  private fail(cause: unknown): Error {
    this.failure = new DomainError("harness_event_gap", "The temporary remote event queue could not be stored or read.", {
      cause,
      details: { reason: "remote_event_storage_failed" },
    });
    this.wake();
    return this.failure;
  }

  private assertOpen(): void {
    if (this.failure) throw this.failure;
    if (this.closed) throw new DomainError("harness_transport_closed", "The remote event queue is closed.");
  }

  private wake(): void {
    for (const wake of [...this.waiters]) wake();
  }
}
