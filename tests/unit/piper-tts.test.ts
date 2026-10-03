/**
 * Stable local-language selection and verified-download data-safety contracts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import {
  detectPiperLanguage,
  PiperSynthesisGate,
  PiperTtsProvider,
} from "../../src/core/piper-tts";
import {
  downloadVerifiedAsset,
  PiperAssetManager,
  type PiperAssets,
  type PiperFileAsset,
} from "../../src/core/piper-assets";
import { DomainError } from "../../src/domain/domain-error";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("local Piper speech", () => {
  let server: Server<unknown> | null = null;
  let temporaryDirectory: string | null = null;
  let originalFetch: typeof fetch | null = null;

  afterEach(async () => {
    server?.stop();
    server = null;
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = null;
    }
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = null;
    }
  });

  test("selects Spanish and English locally and falls back to Argentina Spanish", () => {
    expect(
      detectPiperLanguage("La respuesta quedó lista y solo falta revisarla."),
    ).toBe("es");
    expect(
      detectPiperLanguage("The response is ready and only needs a final review."),
    ).toBe("en");
    expect(detectPiperLanguage("OK")).toBe("es");
  });

  test("bounds Piper subprocess capacity and permits reuse after release", () => {
    // A Piper subprocess loads a large voice model; this contract protects server memory under concurrent speech requests.
    const gate = new PiperSynthesisGate();
    const release = gate.acquire();
    let busyError: unknown;
    try {
      gate.acquire();
    } catch (error) {
      busyError = error;
    }
    expect(busyError).toMatchObject({ code: "voice_piper_busy" });
    release();
    release();

    const canceled = new AbortController();
    canceled.abort();
    let abortError: unknown;
    try {
      gate.acquire(canceled.signal);
    } catch (error) {
      abortError = error;
    }
    expect(abortError).toMatchObject({ name: "AbortError" });

    const nextRelease = gate.acquire();
    nextRelease();
  });

  test("retries a shared voice install after its last waiter aborts", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "clanky-piper-retry-"));
    const firstFetchStarted = deferred<void>();
    const firstFetchAborted = deferred<void>();
    const releaseFirstFetch = deferred<void>();
    const fetchBeforeMock = globalThis.fetch;
    originalFetch = fetchBeforeMock;
    let fetchCount = 0;
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCount += 1;
        if (fetchCount > 1) {
          return new Response(new Uint8Array([1]));
        }

        const signal = init?.signal;
        if (!signal) {
          throw new Error("Expected the Piper download to be abortable.");
        }
        firstFetchStarted.resolve(undefined);
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            firstFetchAborted.resolve(undefined);
            void releaseFirstFetch.promise.then(() => {
              reject(new DOMException("Piper test download aborted.", "AbortError"));
            });
          }, { once: true });
        });
      },
      { preconnect: fetchBeforeMock.preconnect },
    );

    const assets = new PiperAssetManager(() => temporaryDirectory!);
    const controller = new AbortController();
    const firstRequest = assets.ensureVoice("es", controller.signal);
    await firstFetchStarted.promise;
    controller.abort();
    await expect(firstRequest).rejects.toMatchObject({ name: "AbortError" });
    await firstFetchAborted.promise;

    const retry = assets.ensureVoice("es");
    releaseFirstFetch.resolve(undefined);
    await expect(retry).rejects.toMatchObject({ code: "voice_piper_download_failed" });
  });

  test("keeps a shared voice install active for a remaining caller", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "clanky-piper-shared-"));
    const fetchStarted = deferred<void>();
    const releaseResponse = deferred<Response>();
    const fetchBeforeMock = globalThis.fetch;
    originalFetch = fetchBeforeMock;
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("Expected the Piper download to be abortable.");
        }
        fetchStarted.resolve(undefined);
        return await new Promise<Response>((resolve, reject) => {
          const onAbort = (): void => {
            reject(new DOMException("Piper test download aborted.", "AbortError"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          void releaseResponse.promise.then((response) => {
            signal.removeEventListener("abort", onAbort);
            resolve(response);
          });
        });
      },
      { preconnect: fetchBeforeMock.preconnect },
    );

    const assets = new PiperAssetManager(() => temporaryDirectory!);
    const controller = new AbortController();
    const canceledRequest = assets.ensureVoice("en", controller.signal);
    const remainingRequest = assets.ensureVoice("en");
    await fetchStarted.promise;
    controller.abort();
    await expect(canceledRequest).rejects.toMatchObject({ name: "AbortError" });

    releaseResponse.resolve(new Response(new Uint8Array([1])));
    await expect(remainingRequest).rejects.toMatchObject({
      code: "voice_piper_download_failed",
    });
  });

  test("stops a sibling asset waiter when setup fails", async () => {
    const voiceWaitStarted = deferred<void>();
    const voiceWaitStopped = deferred<void>();
    let voiceWaitActive = false;
    const assets: PiperAssets = {
      async getStatus() {
        return { available: true };
      },
      async ensureRuntime() {
        await voiceWaitStarted.promise;
        throw new DomainError(
          "voice_piper_download_failed",
          "The local Piper runtime could not be installed.",
        );
      },
      async ensureVoice(_language, signal) {
        voiceWaitActive = true;
        voiceWaitStarted.resolve(undefined);
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            voiceWaitActive = false;
            voiceWaitStopped.resolve(undefined);
            reject(new DOMException("Piper asset wait aborted.", "AbortError"));
          }, { once: true });
        });
        throw new Error("The voice wait should be cancelled.");
      },
    };
    const provider = new PiperTtsProvider(assets);

    await expect(provider.synthesizeSpeech(
      "The response is ready for local speech synthesis.",
    )).rejects.toMatchObject({ code: "voice_piper_download_failed" });
    await voiceWaitStopped.promise;
    expect(voiceWaitActive).toBe(false);
  });

  test("installs only checksum-verified asset data and removes failed downloads", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "clanky-piper-assets-"));
    const expectedContent = new TextEncoder().encode("verified voice model config");
    const corruptedContent = expectedContent.slice();
    corruptedContent[0] = corruptedContent[0]! ^ 1;
    let servedContent = expectedContent;
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(servedContent),
    });
    const destination = join(temporaryDirectory, "voice", "model.json");
    const asset: PiperFileAsset = {
      url: `${server.url}model.json`,
      size: expectedContent.byteLength,
      sha256: createHash("sha256").update(expectedContent).digest("hex"),
    };

    await downloadVerifiedAsset(asset, destination);
    expect(await Bun.file(destination).text()).toBe("verified voice model config");

    servedContent = corruptedContent;
    const corruptedDestination = join(temporaryDirectory, "voice", "corrupted-model.json");
    await expect(downloadVerifiedAsset(asset, corruptedDestination)).rejects.toMatchObject({
      code: "voice_piper_download_failed",
    });
    expect(await Bun.file(corruptedDestination).exists()).toBe(false);
    expect(await readdir(join(temporaryDirectory, "voice"))).toEqual(["model.json"]);
  });
});
