/**
 * Downloads and caches the Piper runtime and its fixed voice assets.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "@pablozaiden/webapp/server";
import type { VoiceLanguageHint } from "@/shared";
import { getDataDir } from "../persistence/database";
import { DomainError } from "../domain/domain-error";

const log = createLogger("core:piper-assets");
const PIPER_VERSION = "2023.11.14-2";
const VOICE_REPOSITORY_REVISION = "c10ece1aade47bb51c153c893d14e5bf8e5b7117";
const PIPER_DATA_DIRECTORY = "piper";
const PIPER_DOWNLOAD_TIMEOUT_MS = 600_000;
const PIPER_EXTRACT_TIMEOUT_MS = 120_000;

export interface PiperSpeechStatus {
  available: boolean;
}

export interface PiperVoiceFiles {
  modelPath: string;
  configPath: string;
}

export interface PiperRuntimeFiles {
  directory: string;
  executablePath: string;
  espeakDataPath: string;
}

export interface PiperAssets {
  getStatus(): Promise<PiperSpeechStatus>;
  ensureRuntime(signal?: AbortSignal): Promise<PiperRuntimeFiles>;
  ensureVoice(
    language: VoiceLanguageHint,
    signal?: AbortSignal,
  ): Promise<PiperVoiceFiles>;
}

export interface PiperFileAsset {
  url: string;
  size: number;
  sha256: string;
}

interface PiperVoiceFileAsset extends PiperFileAsset {
  fileName: string;
}

interface PiperVoiceDefinition {
  directory: string;
  model: PiperVoiceFileAsset;
  config: PiperVoiceFileAsset;
}

interface PiperRuntimeDefinition {
  fileName: string;
  size: number;
  sha256: string;
  executableName: string;
}

interface PendingOperation<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

const voiceDefinitions: Record<VoiceLanguageHint, PiperVoiceDefinition> = {
  es: {
    directory: "es_AR-daniela-high",
    model: {
      fileName: "es_AR-daniela-high.onnx",
      url: `https://huggingface.co/rhasspy/piper-voices/resolve/${VOICE_REPOSITORY_REVISION}/es/es_AR/daniela/high/es_AR-daniela-high.onnx`,
      size: 114_199_011,
      sha256: "7ceb1fc0dab349418c5b54a639ae9ee595212d7c9ea422220d8419163d5cc985",
    },
    config: {
      fileName: "es_AR-daniela-high.onnx.json",
      url: `https://huggingface.co/rhasspy/piper-voices/resolve/${VOICE_REPOSITORY_REVISION}/es/es_AR/daniela/high/es_AR-daniela-high.onnx.json`,
      size: 7_248,
      sha256: "aedbf69647e1d754c62ecf8e0366ca5f16af3e768e3c6b5329af6eb6bde3852b",
    },
  },
  en: {
    directory: "en_US-ljspeech-medium",
    model: {
      fileName: "en_US-ljspeech-medium.onnx",
      url: `https://huggingface.co/rhasspy/piper-voices/resolve/${VOICE_REPOSITORY_REVISION}/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx`,
      size: 63_531_379,
      sha256: "6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22",
    },
    config: {
      fileName: "en_US-ljspeech-medium.onnx.json",
      url: `https://huggingface.co/rhasspy/piper-voices/resolve/${VOICE_REPOSITORY_REVISION}/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx.json`,
      size: 4_972,
      sha256: "141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860",
    },
  },
};

const runtimeDefinitions: Record<string, PiperRuntimeDefinition> = {
  "linux:x64": {
    fileName: "piper_linux_x86_64.tar.gz",
    size: 26_460_462,
    sha256: "a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992",
    executableName: "piper",
  },
  "linux:arm64": {
    fileName: "piper_linux_aarch64.tar.gz",
    size: 26_004_717,
    sha256: "fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb",
    executableName: "piper",
  },
  "darwin:x64": {
    fileName: "piper_macos_x64.tar.gz",
    size: 19_146_927,
    sha256: "ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b",
    executableName: "piper",
  },
  "darwin:arm64": {
    fileName: "piper_macos_aarch64.tar.gz",
    size: 19_146_957,
    sha256: "6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc",
    executableName: "piper",
  },
  "win32:x64": {
    fileName: "piper_windows_amd64.zip",
    size: 22_477_236,
    sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
    executableName: "piper.exe",
  },
};

const pendingOperations = new Map<string, PendingOperation<unknown>>();

function createAbortError(): DOMException {
  return new DOMException("The Piper request was aborted.", "AbortError");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function regularFileHasSize(path: string, expectedSize: number): Promise<boolean> {
  try {
    const fileStats = await stat(path);
    return fileStats.isFile() && fileStats.size === expectedSize;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function getRuntimeDefinition(
  platform: string,
  arch: string,
): PiperRuntimeDefinition | null {
  return runtimeDefinitions[`${platform}:${arch}`] ?? null;
}

function runtimeUrl(definition: PiperRuntimeDefinition): string {
  return `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${definition.fileName}`;
}

function expectedVoiceMarker(definition: PiperVoiceDefinition): string {
  return JSON.stringify({
    version: 1,
    modelSha256: definition.model.sha256,
    configSha256: definition.config.sha256,
  });
}

function expectedRuntimeMarker(definition: PiperRuntimeDefinition): string {
  return JSON.stringify({
    version: PIPER_VERSION,
    archiveSha256: definition.sha256,
  });
}

async function isVoiceInstalled(
  directory: string,
  definition: PiperVoiceDefinition,
): Promise<boolean> {
  const modelPath = join(directory, definition.model.fileName);
  const configPath = join(directory, definition.config.fileName);
  const markerPath = join(directory, ".complete");
  if (
    !await regularFileHasSize(modelPath, definition.model.size)
    || !await regularFileHasSize(configPath, definition.config.size)
    || !await regularFileHasSize(markerPath, expectedVoiceMarker(definition).length)
  ) {
    return false;
  }
  return await Bun.file(markerPath).text() === expectedVoiceMarker(definition);
}

async function isRuntimeInstalled(
  directory: string,
  definition: PiperRuntimeDefinition,
): Promise<boolean> {
  const executablePath = join(directory, definition.executableName);
  const dataPath = join(directory, "espeak-ng-data", "phonindex");
  const markerPath = join(directory, ".complete");
  if (
    !await regularFileHasSize(markerPath, expectedRuntimeMarker(definition).length)
    || !await pathExists(executablePath)
    || !await pathExists(dataPath)
  ) {
    return false;
  }
  return await Bun.file(markerPath).text() === expectedRuntimeMarker(definition);
}

async function writeAll(file: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await file.write(chunk, offset, chunk.byteLength - offset, null);
    if (result.bytesWritten === 0) {
      throw new Error("The Piper asset file write made no progress.");
    }
    offset += result.bytesWritten;
  }
}

async function removeTemporaryPath(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    log.warn("Failed to clean a temporary Piper asset", { error: String(error) });
  }
}

export async function downloadVerifiedAsset(
  asset: PiperFileAsset,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError();
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });

  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PIPER_DOWNLOAD_TIMEOUT_MS);
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    controller.abort();
  }

  let file: FileHandle | null = null;
  let committed = false;
  try {
    const response = await fetch(asset.url, { signal: controller.signal });
    if (!response.ok) {
      throw new DomainError(
        "voice_piper_download_failed",
        "A Piper runtime or voice file could not be downloaded.",
      );
    }
    if (!response.body) {
      throw new DomainError(
        "voice_piper_download_failed",
        "A Piper download returned an empty response.",
      );
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== asset.size) {
      throw new DomainError(
        "voice_piper_download_failed",
        "A Piper download had an unexpected size.",
      );
    }

    file = await open(temporaryPath, "wx", 0o600);
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    let totalBytes = 0;
    try {
      while (true) {
        if (controller.signal.aborted) {
          throw createAbortError();
        }
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        totalBytes += value.byteLength;
        if (totalBytes > asset.size) {
          await reader.cancel();
          throw new DomainError(
            "voice_piper_download_failed",
            "A Piper download exceeded its expected size.",
          );
        }
        hash.update(value);
        await writeAll(file, value);
      }
    } finally {
      reader.releaseLock();
    }
    if (totalBytes !== asset.size || hash.digest("hex") !== asset.sha256) {
      throw new DomainError(
        "voice_piper_download_failed",
        "A Piper download failed its integrity check.",
      );
    }
    await file.sync();
    await file.close();
    file = null;
    await rename(temporaryPath, destination);
    committed = true;
  } catch (error) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (timedOut) {
      throw new DomainError(
        "voice_piper_timeout",
        "Downloading Piper files timed out.",
        { cause: error },
      );
    }
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError(
      "voice_piper_download_failed",
      "A Piper runtime or voice file could not be downloaded.",
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    if (file) {
      try {
        await file.close();
      } catch (error) {
        log.warn("Failed to close a temporary Piper asset", { error: String(error) });
      }
    }
    if (!committed) {
      await removeTemporaryPath(temporaryPath);
    }
  }
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (total < maxBytes) {
        const retained = value.subarray(0, maxBytes - total);
        if (retained.byteLength > 0) {
          chunks.push(retained);
          total += retained.byteLength;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function extractRuntimeArchive(
  archivePath: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError();
  }

  let child: Bun.Subprocess;
  try {
    child = Bun.spawn(["tar", "-xf", archivePath, "-C", destination], {
      cwd: destination,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
  } catch (error) {
    throw new DomainError(
      "voice_piper_download_failed",
      "The Piper runtime archive could not be extracted.",
      { cause: error },
    );
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, PIPER_EXTRACT_TIMEOUT_MS);
  const abort = (): void => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  const stderrStream = child.stderr;
  if (!(stderrStream instanceof ReadableStream)) {
    child.kill();
    await child.exited;
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    throw new DomainError(
      "voice_piper_download_failed",
      "The Piper runtime extraction diagnostics are unavailable.",
    );
  }
  const stderr = readBoundedText(stderrStream, 8 * 1024);
  try {
    const exitCode = await child.exited;
    const stderrText = await stderr;
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (timedOut) {
      throw new DomainError(
        "voice_piper_timeout",
        "Extracting the Piper runtime timed out.",
      );
    }
    if (exitCode !== 0) {
      log.warn("Piper runtime archive extraction failed", {
        exitCode,
        stderr: stderrText.slice(0, 1_000),
      });
      throw new DomainError(
        "voice_piper_download_failed",
        "The Piper runtime archive could not be extracted.",
      );
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function withSharedOperation<T>(
  key: string,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) {
    throw createAbortError();
  }
  let pending = pendingOperations.get(key) as PendingOperation<T> | undefined;
  if (!pending) {
    const controller = new AbortController();
    const entry: PendingOperation<T> = {
      promise: Promise.resolve().then(() => operation(controller.signal)),
      controller,
      waiters: 0,
      settled: false,
    };
    pending = entry;
    pendingOperations.set(key, entry);
    const finish = (): void => {
      entry.settled = true;
      if (pendingOperations.get(key) === entry) {
        pendingOperations.delete(key);
      }
    };
    void entry.promise.then(finish, finish);
  }

  pending.waiters += 1;
  try {
    return await awaitWithAbort(pending.promise, signal);
  } finally {
    pending.waiters -= 1;
    if (pending.waiters === 0 && !pending.settled) {
      pending.controller.abort();
    }
  }
}

function runtimeDirectoryName(platform: string, arch: string): string {
  return `${platform}-${arch}-${PIPER_VERSION}`;
}

export class PiperAssetManager implements PiperAssets {
  constructor(
    private readonly getDataDirectory: () => string = getDataDir,
    private readonly platform: string = process.platform,
    private readonly arch: string = process.arch,
  ) {}

  async getStatus(): Promise<PiperSpeechStatus> {
    return { available: getRuntimeDefinition(this.platform, this.arch) !== null };
  }

  async ensureVoice(
    language: VoiceLanguageHint,
    signal?: AbortSignal,
  ): Promise<PiperVoiceFiles> {
    const definition = voiceDefinitions[language];
    const voiceDirectory = join(
      this.getDataDirectory(),
      PIPER_DATA_DIRECTORY,
      "voices",
      definition.directory,
    );
    return await withSharedOperation(
      `voice:${voiceDirectory}`,
      signal,
      async (operationSignal) => {
        if (await isVoiceInstalled(voiceDirectory, definition)) {
          return this.voiceFiles(voiceDirectory, definition);
        }

        const voiceParent = dirname(voiceDirectory);
        await mkdir(voiceParent, { recursive: true, mode: 0o700 });
        const temporaryDirectory = await mkdtemp(join(
          voiceParent,
          `.${definition.directory}-`,
        ));
        let committed = false;
        try {
          const modelPath = join(temporaryDirectory, definition.model.fileName);
          const configPath = join(temporaryDirectory, definition.config.fileName);
          await downloadVerifiedAsset(definition.model, modelPath, operationSignal);
          await downloadVerifiedAsset(definition.config, configPath, operationSignal);
          await writeFile(
            join(temporaryDirectory, ".complete"),
            expectedVoiceMarker(definition),
            { mode: 0o600 },
          );

          if (await isVoiceInstalled(voiceDirectory, definition)) {
            return this.voiceFiles(voiceDirectory, definition);
          }
          if (await pathExists(voiceDirectory)) {
            await rm(voiceDirectory, { recursive: true, force: true });
          }
          await rename(temporaryDirectory, voiceDirectory);
          committed = true;
          return this.voiceFiles(voiceDirectory, definition);
        } catch (error) {
          if (await isVoiceInstalled(voiceDirectory, definition)) {
            return this.voiceFiles(voiceDirectory, definition);
          }
          throw error;
        } finally {
          if (!committed) {
            await removeTemporaryPath(temporaryDirectory);
          }
        }
      },
    );
  }

  async ensureRuntime(signal?: AbortSignal): Promise<PiperRuntimeFiles> {
    const definition = getRuntimeDefinition(this.platform, this.arch);
    if (!definition) {
      throw new DomainError(
        "voice_piper_unsupported_platform",
        "Local Piper speech is not supported on this server platform.",
      );
    }

    const dataDirectory = this.getDataDirectory();
    const runtimeDirectory = join(
      dataDirectory,
      PIPER_DATA_DIRECTORY,
      "runtime",
      runtimeDirectoryName(this.platform, this.arch),
    );
    return await withSharedOperation(
      `runtime:${runtimeDirectory}`,
      signal,
      async (operationSignal) => {
        if (await isRuntimeInstalled(runtimeDirectory, definition)) {
          return this.runtimeFiles(runtimeDirectory, definition);
        }

        const runtimeParent = dirname(runtimeDirectory);
        await mkdir(runtimeParent, { recursive: true, mode: 0o700 });
        const temporaryDirectory = await mkdtemp(join(
          runtimeParent,
          `.install-${runtimeDirectoryName(this.platform, this.arch)}-`,
        ));
        try {
          const archivePath = join(temporaryDirectory, definition.fileName);
          const extractedDirectory = join(temporaryDirectory, "extracted");
          await mkdir(extractedDirectory, { mode: 0o700 });
          await downloadVerifiedAsset(
            {
              url: runtimeUrl(definition),
              size: definition.size,
              sha256: definition.sha256,
            },
            archivePath,
            operationSignal,
          );
          await extractRuntimeArchive(archivePath, extractedDirectory, operationSignal);

          const packageDirectory = join(extractedDirectory, "piper");
          const executablePath = join(packageDirectory, definition.executableName);
          if (
            !await pathExists(executablePath)
            || !await pathExists(join(packageDirectory, "espeak-ng-data", "phonindex"))
          ) {
            throw new DomainError(
              "voice_piper_download_failed",
              "The Piper runtime archive is missing required files.",
            );
          }
          await writeFile(
            join(packageDirectory, ".complete"),
            expectedRuntimeMarker(definition),
            { mode: 0o600 },
          );
          if (this.platform !== "win32") {
            await chmod(executablePath, 0o700);
          }

          if (await isRuntimeInstalled(runtimeDirectory, definition)) {
            return this.runtimeFiles(runtimeDirectory, definition);
          }
          if (await pathExists(runtimeDirectory)) {
            await rm(runtimeDirectory, { recursive: true, force: true });
          }
          await rename(packageDirectory, runtimeDirectory);
          return this.runtimeFiles(runtimeDirectory, definition);
        } catch (error) {
          if (await isRuntimeInstalled(runtimeDirectory, definition)) {
            return this.runtimeFiles(runtimeDirectory, definition);
          }
          throw error;
        } finally {
          await removeTemporaryPath(temporaryDirectory);
        }
      },
    );
  }

  private voiceFiles(
    directory: string,
    definition: PiperVoiceDefinition,
  ): PiperVoiceFiles {
    return {
      modelPath: join(directory, definition.model.fileName),
      configPath: join(directory, definition.config.fileName),
    };
  }

  private runtimeFiles(
    directory: string,
    definition: PiperRuntimeDefinition,
  ): PiperRuntimeFiles {
    return {
      directory,
      executablePath: join(directory, definition.executableName),
      espeakDataPath: join(directory, "espeak-ng-data"),
    };
  }
}

export const piperAssetManager = new PiperAssetManager();
