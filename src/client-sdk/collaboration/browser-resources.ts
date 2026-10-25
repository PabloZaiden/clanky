/**
 * Bounded, explicitly owned image URLs; downloads never use this RAM path.
 */

import type { WebAppResourceUrl } from "@pablozaiden/webapp/web";
import { MESSAGE_ATTACHMENT_MAX_BYTES, MESSAGE_ATTACHMENT_MAX_TURN_BYTES } from "@/shared/message-attachments";
import { DomainError } from "../../domain/domain-error";

export class BrowserCollaborationResources {
  private readonly lifetime = new AbortController();
  private readonly urls = new Map<string, number>();
  private readonly pending = new Set<Promise<WebAppResourceUrl>>();
  private bytes = 0;
  private disposed = false;

  constructor(private readonly request: (path: string, signal: AbortSignal) => Promise<Response>) {}

  async url(path: string, options: { signal?: AbortSignal }): Promise<WebAppResourceUrl> {
    if (this.disposed) throw new DomainError("collaboration_disconnected", "Browser resources are closed.");
    if (this.urls.size + this.pending.size >= 64) {
      throw new DomainError("collaboration_resource_capacity", "Too many browser image resources are open.");
    }
    const pending = this.load(path, AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]));
    this.pending.add(pending);
    try { return await pending; } finally { this.pending.delete(pending); }
  }

  private async load(path: string, signal: AbortSignal): Promise<WebAppResourceUrl> {
    const response = await this.request(path, signal);
    const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!response.ok || !type.startsWith("image/")) {
      const error = new DomainError("collaboration_resource_unavailable", "This browser URL supports images only. Save other resources as downloads.");
      try { await response.body?.cancel(); } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Image validation and cleanup failed.", { cause: error });
      }
      throw error;
    }
    if (!response.body) throw new DomainError("collaboration_resource_unavailable", "The controller returned an empty image resource.");
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    let retained = false;
    try {
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        if (received + next.value.byteLength > MESSAGE_ATTACHMENT_MAX_BYTES
          || this.bytes + next.value.byteLength > MESSAGE_ATTACHMENT_MAX_TURN_BYTES
          || chunks.length >= 4096) {
          throw new DomainError("collaboration_resource_capacity", "Browser image resources exceed the image memory budget. Download the file instead.");
        }
        received += next.value.byteLength;
        this.bytes += next.value.byteLength;
        chunks.push(Uint8Array.from(next.value));
      }
      await reader.cancel();
      signal.throwIfAborted();
      const url = URL.createObjectURL(new Blob(chunks, { type }));
      this.urls.set(url, received);
      retained = true;
      return { url, expiresAt: null, dispose: () => this.release(url) };
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Image loading and cleanup failed.", { cause: error });
      }
      throw signal.aborted ? signal.reason : error;
    } finally {
      reader.releaseLock();
      if (!retained) this.bytes -= received;
    }
  }

  private release(url: string): void {
    const bytes = this.urls.get(url);
    if (bytes === undefined) return;
    URL.revokeObjectURL(url);
    this.urls.delete(url);
    this.bytes -= bytes;
  }

  async stop(): Promise<void> {
    this.disposed = true;
    this.lifetime.abort();
    const results = await Promise.allSettled(this.pending);
    for (const url of this.urls.keys()) this.release(url);
    const failures = results.flatMap((result) => result.status === "rejected"
      && result.reason !== this.lifetime.signal.reason
      && !(result.reason instanceof DOMException && result.reason.name === "AbortError") ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Browser image cleanup failed.");
  }
}
