/**
 * Streams authorized responses to disk; export is a separate user action.
 */

import type { WebAppSaveResourceOptions } from "@pablozaiden/webapp/web";
import { DomainError } from "../../domain/domain-error";
import type { CollaborationClientLogger } from "./types";
import {
  BrowserDownloadMetadataSchema, BrowserDownloadStore,
  BROWSER_DOWNLOAD_MAX_BYTES, BROWSER_DOWNLOAD_MAX_RECORDS,
  type BrowserDownloadMetadata,
} from "./browser-download-store";

export interface BrowserDownload {
  readonly id: string;
  readonly name: string;
  readonly status: BrowserDownloadMetadata["status"] | "failed" | "cancelled";
  readonly receivedBytes: number;
  readonly totalBytes?: number;
  readonly error?: string;
}

export interface BrowserDownloadsSnapshot {
  readonly downloads: readonly BrowserDownload[];
  readonly loading: boolean;
  readonly error: Error | null;
}

export class BrowserCollaborationDownloads {
  private readonly store: BrowserDownloadStore;
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly active = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly urls = new Map<string, string>();
  private snapshot: BrowserDownloadsSnapshot = { downloads: [], loading: false, error: null };
  private disposed = false;
  private refreshing?: Promise<void>;
  private stopping?: Promise<void>;

  constructor(private readonly options: {
    scope: string;
    request: (path: string, signal: AbortSignal) => Promise<Response>;
    logger: CollaborationClientLogger;
  }) {
    this.store = new BrowserDownloadStore(options.scope);
  }

  readonly getSnapshot = (): BrowserDownloadsSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.assertOpen();
    if (this.listeners.size >= 256) throw new DomainError("collaboration_download_capacity", "Too many download observers.");
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private emit(patch: Partial<BrowserDownloadsSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) {
      try { listener(); } catch (error) {
        this.options.logger.error("Browser download observer failed", { error: String(error) });
      }
    }
  }

  private update(download: BrowserDownload): void {
    this.emit({ downloads: [...this.snapshot.downloads.filter((entry) => entry.id !== download.id), download] });
  }

  private assertOpen(): void {
    if (this.disposed) throw new DomainError("collaboration_disconnected", "The browser download manager is closed.");
  }

  private async track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    try { return await operation; } finally { this.pending.delete(operation); }
  }

  private async exclusive<T>(invoke: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return await navigator.locks.request(this.store.lock, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new DomainError("collaboration_download_in_use", "Another browser download is active. Wait for it to finish.");
      this.lifetime.signal.throwIfAborted();
      this.assertOpen();
      return await invoke();
    });
  }

  async refresh(): Promise<void> {
    this.assertOpen();
    this.refreshing ??= this.readStoredDownloads().finally(() => { this.refreshing = undefined; });
    await this.refreshing;
  }

  private async readStoredDownloads(): Promise<void> {
    this.emit({ loading: true, error: null });
    try {
      const downloads = await this.exclusive(async () => {
        const found: BrowserDownload[] = [];
        for (const id of await this.store.list()) {
          try {
            this.lifetime.signal.throwIfAborted();
            const record = await this.store.read(id);
            this.lifetime.signal.throwIfAborted();
            if (record.status === "transferring") {
              await this.store.remove(id);
              continue;
            }
            const file = await (await this.store.content(id)).getFile();
            if (file.size !== record.receivedBytes) throw new Error("The browser copy is incomplete.");
            found.push(record);
          } catch (error) {
            this.lifetime.signal.throwIfAborted();
            this.options.logger.warn("Browser download could not be recovered", { error: String(error) });
            found.push({ id, name: "Unreadable browser download", status: "failed", receivedBytes: 0, error: String(error) });
          }
        }
        return found;
      });
      this.lifetime.signal.throwIfAborted();
      this.emit({ downloads, loading: false });
    } catch (error) {
      this.lifetime.signal.throwIfAborted();
      this.emit({ loading: false, error: error instanceof Error ? error : new Error(String(error)) });
      throw error;
    }
  }

  async save(path: string, options: WebAppSaveResourceOptions): Promise<void> {
    this.assertOpen();
    await this.track(this.exclusive(async () => await this.transfer(path, options)));
  }

  private async transfer(path: string, options: WebAppSaveResourceOptions): Promise<void> {
    options.signal?.throwIfAborted();
    if (this.snapshot.downloads.length >= BROWSER_DOWNLOAD_MAX_RECORDS
      || (await this.store.list()).length >= BROWSER_DOWNLOAD_MAX_RECORDS) {
      throw new DomainError("collaboration_download_capacity", "Remove earlier browser download copies before starting another.");
    }
    const initial = BrowserDownloadMetadataSchema.parse({
      id: crypto.randomUUID(), name: options.suggestedName, status: "transferring", receivedBytes: 0,
    });
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    this.active.set(initial.id, controller);
    let record: BrowserDownloadMetadata = initial;
    let response: Response | undefined;
    let lastProgress = -Infinity;
    try {
      await this.store.write(record);
      this.update(record);
      response = await this.options.request(path, signal);
      if (!response.ok || !response.body) {
        throw new DomainError("collaboration_download_failed", `The controller could not provide the download (HTTP ${response.status}).`);
      }
      const length = response.headers.get("x-clanky-download-size") ?? response.headers.get("content-length");
      if (length !== null) {
        const totalBytes = Number(length);
        if (!/^\d+$/.test(length) || !Number.isSafeInteger(totalBytes) || totalBytes > BROWSER_DOWNLOAD_MAX_BYTES) {
          throw new DomainError("collaboration_download_too_large", "Browser downloads support files up to 4 GiB.");
        }
        record = { ...record, totalBytes };
      }
      const handle = await this.store.content(record.id, true);
      const writer = await handle.createWritable();
      await response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, output) => {
          const receivedBytes = record.receivedBytes + chunk.byteLength;
          if (receivedBytes > BROWSER_DOWNLOAD_MAX_BYTES
            || (record.totalBytes !== undefined && receivedBytes > record.totalBytes)) {
            throw new DomainError("collaboration_download_too_large", "The download exceeds its declared size or the 4 GiB limit.");
          }
          record = { ...record, receivedBytes };
          if (performance.now() - lastProgress >= 100) {
            lastProgress = performance.now();
            this.update(record);
            options.onProgress?.({ receivedBytes, ...(record.totalBytes === undefined ? {} : { totalBytes: record.totalBytes }) });
          }
          output.enqueue(Uint8Array.from(chunk));
        },
      })).pipeTo(writer, { signal });
      if (record.totalBytes !== undefined && record.receivedBytes !== record.totalBytes) {
        throw new DomainError("collaboration_download_truncated", "The controller ended the download before all bytes arrived.");
      }
      signal.throwIfAborted();
      record = { ...record, status: "ready" };
      await this.store.write(record);
      options.onProgress?.({ receivedBytes: record.receivedBytes, totalBytes: record.totalBytes });
      this.update(record);
    } catch (cause) {
      let error = cause;
      const cleanup = await Promise.allSettled([
        ...(response?.body && !response.body.locked ? [response.body.cancel(cause)] : []),
        this.store.remove(record.id),
      ]);
      const failures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) {
        error = new AggregateError([cause, ...failures], "The download failed and its browser copy could not be fully removed.", { cause });
      }
      this.update({
        ...record, status: signal.aborted && !failures.length ? "cancelled" : "failed",
        error: signal.aborted && !failures.length ? "Download cancelled." : String(error),
      });
      throw signal.aborted && !failures.length ? signal.reason : error;
    } finally {
      this.active.delete(record.id);
    }
  }

  cancel(id: string): void {
    this.assertOpen();
    const controller = this.active.get(id);
    if (!controller) throw new DomainError("collaboration_download_unavailable", "This download is no longer transferring.");
    controller.abort(new DOMException("Download cancelled.", "AbortError"));
  }

  async export(id: string): Promise<void> {
    this.assertOpen();
    await this.track(this.exclusive(async () => {
      const record = await this.store.read(id);
      if (record.status === "transferring") throw new DomainError("collaboration_download_unavailable", "Wait for the download to finish.");
      const file = await (await this.store.content(id)).getFile();
      if (file.size !== record.receivedBytes) throw new DomainError("collaboration_download_truncated", "The browser copy is incomplete.");
      const namedFile = new File([file], record.name, { type: "application/octet-stream" });
      this.lifetime.signal.throwIfAborted();
      if (navigator.canShare?.({ files: [namedFile] })) {
        await this.share(namedFile);
      } else {
        const previous = this.urls.get(id);
        if (previous) URL.revokeObjectURL(previous);
        const url = URL.createObjectURL(namedFile);
        this.urls.set(id, url);
        const link = document.createElement("a");
        link.href = url;
        link.download = record.name;
        link.click();
      }
      this.lifetime.signal.throwIfAborted();
      const exported: BrowserDownloadMetadata = { ...record, status: "export-started" };
      await this.store.write(exported);
      this.lifetime.signal.throwIfAborted();
      this.update(exported);
    }));
  }

  private async share(file: File): Promise<void> {
    const signal = this.lifetime.signal;
    const cancelled = Promise.withResolvers<void>();
    const abort = () => cancelled.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      // The native sheet belongs to the browser; cancellation prevents late client state writes.
      signal.throwIfAborted();
      await Promise.race([navigator.share({ files: [file] }), cancelled.promise]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  async discard(id: string): Promise<void> {
    this.assertOpen();
    await this.track(this.exclusive(async () => {
      const record = this.snapshot.downloads.find((entry) => entry.id === id);
      if (!record) throw new DomainError("collaboration_download_unavailable", "The browser download is unavailable.");
      if (record.status === "transferring") throw new DomainError("collaboration_download_in_use", "Cancel the transfer before removing it.");
      if (record.status !== "failed" && record.status !== "cancelled") await this.store.remove(id);
      else {
        const ids = await this.store.list();
        if (ids.includes(id)) await this.store.remove(id);
      }
      this.lifetime.signal.throwIfAborted();
      const url = this.urls.get(id);
      if (url) URL.revokeObjectURL(url);
      this.urls.delete(id);
      this.emit({ downloads: this.snapshot.downloads.filter((entry) => entry.id !== id) });
    }));
  }

  async stop(): Promise<void> {
    if (this.stopping) return await this.stopping;
    this.disposed = true;
    this.lifetime.abort();
    this.stopping = (async () => {
      const results = await Promise.allSettled([...this.pending, ...(this.refreshing ? [this.refreshing] : [])]);
      for (const url of this.urls.values()) URL.revokeObjectURL(url);
      this.urls.clear();
      this.listeners.clear();
      const failures = results.flatMap((result) => result.status === "rejected"
        && result.reason !== this.lifetime.signal.reason
        && !(result.reason instanceof DOMException && result.reason.name === "AbortError") ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Browser download cleanup failed.");
    })();
    await this.stopping;
  }
}
