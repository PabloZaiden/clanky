import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database, SQLiteError } from "bun:sqlite";
import { createLogger } from "@pablozaiden/webapp/server";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import { SECRET_FILE_TTL_MS, type SecretFileReference } from "@/shared/harness-secrets";
import { getDataDir } from "../persistence/database";
import { DomainError } from "../domain/domain-error";
import { KeyedOperationQueue } from "../utils/keyed-operation-queue";

const log = createLogger("harness-secret-files");

export function secretNamespace(binding: HarnessConversationBinding, identifier: string): string {
  return JSON.stringify([binding.ownerId, binding.contextId, binding.executionHost, binding.directory, identifier]);
}

class HarnessSecretFiles {
  private readonly files = new Map<string, SecretFileReference>();
  private readonly operations = new KeyedOperationQueue();
  private opening?: Promise<void>;
  private directory?: string;
  private ownership?: Database;
  private sweepTimer?: ReturnType<typeof setInterval>;

  initialize(): Promise<void> {
    return this.opening ??= this.open();
  }

  private async open(): Promise<void> {
    const root = join(getDataDir(), "native", "secrets");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await this.secureDirectory(root);
    const startup = this.lock(join(root, "startup.sqlite"), 5000);
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^process-[1-9][0-9]*-[A-Za-z0-9]+$/.test(entry.name)) continue;
        const path = join(root, entry.name);
        try {
          this.lock(join(path, "owner.sqlite")).close();
        } catch (error) {
          if (error instanceof SQLiteError && error.code === "SQLITE_BUSY") continue;
          throw error;
        }
        await rm(path, { recursive: true });
      }
      this.directory = await mkdtemp(join(root, `process-${process.pid}-`));
      await this.secureDirectory(this.directory);
      this.ownership = this.lock(join(this.directory, "owner.sqlite"));
    } finally {
      startup.close();
    }
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch(() => log.error("Expired secret files could not be removed."));
    }, 60_000);
    this.sweepTimer.unref();
  }

  private lock(path: string, timeoutMs = 0): Database {
    const database = new Database(path);
    try {
      database.exec(`PRAGMA busy_timeout = ${timeoutMs}; BEGIN EXCLUSIVE;`);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private async secureDirectory(path: string): Promise<void> {
    await chmod(path, 0o700);
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
      throw new DomainError("secret_file_unavailable", "The private secret directory could not be secured.");
    }
  }

  async get(key: string): Promise<SecretFileReference | undefined> {
    await this.initialize();
    if (!this.directory) throw new DomainError("secret_file_unavailable", "The private secret directory is unavailable.");
    return await this.operations.run(key, async () => {
      const entry = this.files.get(key);
      if (!entry) return undefined;
      if (Date.now() >= entry.expiresAt) {
        await this.remove(key, entry);
        return undefined;
      }
      try {
        const metadata = await lstat(entry.path);
        if (metadata.isFile() && !metadata.isSymbolicLink()
          && (metadata.mode & 0o777) === 0o600) return { ...entry };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await this.remove(key, entry);
      return undefined;
    });
  }

  async save(key: string, value: string, signal: AbortSignal): Promise<SecretFileReference> {
    await this.initialize();
    const directory = this.directory;
    if (!directory) throw new DomainError("secret_file_unavailable", "The private secret directory is unavailable.");
    return await this.operations.run(key, async () => {
      signal.throwIfAborted();
      if (this.files.size >= 1024) throw new DomainError("secret_file_capacity", "Too many private secret files are in use.");
      const path = join(directory, crypto.randomUUID());
      let published = false;
      try {
        const file = await open(path, "wx", 0o600);
        try {
          await file.chmod(0o600);
          if (((await file.stat()).mode & 0o777) !== 0o600) {
            throw new DomainError("secret_file_unavailable", "The private secret file permissions could not be secured.");
          }
          await file.writeFile(value, "utf8");
          await file.sync();
        } finally { await file.close(); }
        signal.throwIfAborted();
        const reference = { path, expiresAt: Date.now() + SECRET_FILE_TTL_MS };
        const previous = this.files.get(key);
        if (previous) await this.remove(key, previous);
        this.files.set(key, reference);
        published = true;
        return { ...reference };
      } finally {
        if (!published) await rm(path, { recursive: true, force: true });
      }
    });
  }

  private async remove(key: string, entry: SecretFileReference): Promise<void> {
    await rm(entry.path, { recursive: true, force: true });
    this.files.delete(key);
  }

  private async sweep(): Promise<void> {
    for (const [key, entry] of this.files) {
      if (Date.now() >= entry.expiresAt) {
        await this.operations.run(key, async () => {
          if (this.files.get(key) === entry) await this.remove(key, entry);
        });
      }
    }
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.opening;
    await this.operations.drain();
    if (this.directory) {
      const startup = this.lock(join(dirname(this.directory), "startup.sqlite"), 5000);
      try {
        await rm(this.directory, { recursive: true, force: true });
      } finally {
        this.ownership?.close();
        this.ownership = undefined;
        startup.close();
      }
    }
    this.files.clear();
  }
}

export const harnessSecretFiles = new HarnessSecretFiles();
