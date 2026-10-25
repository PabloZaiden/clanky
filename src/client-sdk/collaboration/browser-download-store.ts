/**
 * Owns only Clanky's profile-scoped OPFS download directories and metadata.
 */

import { z } from "zod";
import { sha256Text } from "@/shared/hash";
import { DomainError } from "../../domain/domain-error";

export const BROWSER_DOWNLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const BROWSER_DOWNLOAD_MAX_RECORDS = 64;
export const BrowserDownloadMetadataSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(255),
  status: z.enum(["transferring", "ready", "export-started"]),
  receivedBytes: z.number().int().min(0).max(BROWSER_DOWNLOAD_MAX_BYTES),
  totalBytes: z.number().int().min(0).max(BROWSER_DOWNLOAD_MAX_BYTES).optional(),
});
export type BrowserDownloadMetadata = z.infer<typeof BrowserDownloadMetadataSchema>;

export class BrowserDownloadStore {
  readonly lock: string;
  private readonly directoryName: string;

  constructor(scope: string) {
    this.directoryName = `clanky-downloads-${sha256Text(scope)}`;
    this.lock = this.directoryName;
  }

  async directory(): Promise<FileSystemDirectoryHandle> {
    if (!navigator.storage?.getDirectory) {
      throw new DomainError("collaboration_download_unavailable", "This browser does not support disk-backed browser downloads.");
    }
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(this.directoryName, { create: true });
  }

  async list(): Promise<string[]> {
    const ids: string[] = [];
    for await (const [name, handle] of (await this.directory()).entries()) {
      if (handle.kind !== "directory" || !z.uuid().safeParse(name).success) continue;
      if (ids.length >= BROWSER_DOWNLOAD_MAX_RECORDS) {
        throw new DomainError("collaboration_download_capacity", "Too many browser download records. Remove earlier browser copies first.");
      }
      ids.push(name);
    }
    return ids;
  }

  async content(id: string, create = false): Promise<FileSystemFileHandle> {
    const directory = await (await this.directory()).getDirectoryHandle(z.uuid().parse(id), { create });
    return await directory.getFileHandle("content", { create });
  }

  async read(id: string): Promise<BrowserDownloadMetadata> {
    const directory = await (await this.directory()).getDirectoryHandle(z.uuid().parse(id));
    const file = await (await directory.getFileHandle("metadata.json")).getFile();
    if (file.size > 16 * 1024) throw new Error("Browser download metadata is too large.");
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch (cause) {
      throw new Error("Browser download metadata is unreadable.", { cause });
    }
    const metadata = BrowserDownloadMetadataSchema.parse(raw);
    if (metadata.id !== id) throw new Error("Browser download metadata does not match its directory.");
    return metadata;
  }

  async write(metadata: BrowserDownloadMetadata): Promise<void> {
    const record = BrowserDownloadMetadataSchema.parse(metadata);
    const directory = await (await this.directory()).getDirectoryHandle(record.id, { create: true });
    const handle = await directory.getFileHandle("metadata.json", { create: true });
    if (typeof handle.createWritable !== "function") {
      throw new DomainError("collaboration_download_unavailable", "This browser cannot stream writes to browser storage.");
    }
    const writer = await handle.createWritable();
    try {
      await writer.write(JSON.stringify(record));
      await writer.close();
    } catch (error) {
      try {
        await writer.abort();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Browser metadata write and cleanup failed.", { cause: error });
      }
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    const directory = await this.directory();
    try {
      await directory.removeEntry(z.uuid().parse(id), { recursive: true });
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return;
      throw error;
    }
  }
}
