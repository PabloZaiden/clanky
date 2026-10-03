/**
 * Local Piper speech synthesis and language-based voice selection.
 */

import { franc } from "franc-min";
import { createLogger } from "@pablozaiden/webapp/server";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { VoiceLanguageHint } from "@/shared";
import { getDataDir } from "../persistence/database";
import { DomainError } from "../domain/domain-error";
import {
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_TEXT_CHARS,
} from "./voice-provider";
import {
  piperAssetManager,
  type PiperAssets,
  type PiperRuntimeFiles,
  type PiperSpeechStatus,
  type PiperVoiceFiles,
} from "./piper-assets";

const log = createLogger("core:piper-tts");
const PIPER_SYNTHESIS_TIMEOUT_MS = 300_000;
const LANGUAGE_DETECTION_MIN_LENGTH = 10;
const WAV_HEADER_LENGTH = 12;

export interface PiperSpeechResult {
  audio: ArrayBuffer;
  contentType: "audio/wav";
}

export interface PiperSpeechService {
  getStatus(): Promise<PiperSpeechStatus>;
  synthesizeSpeech(text: string, signal?: AbortSignal): Promise<PiperSpeechResult>;
}

export function detectPiperLanguage(text: string): VoiceLanguageHint {
  const languageInput = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (languageInput.length < LANGUAGE_DETECTION_MIN_LENGTH) {
    return "es";
  }

  const language = franc(languageInput, { minLength: LANGUAGE_DETECTION_MIN_LENGTH });
  if (language === "eng") {
    return "en";
  }
  if (language === "spa") {
    return "es";
  }
  return "es";
}

function createAbortError(): DOMException {
  return new DOMException("Piper speech synthesis was aborted.", "AbortError");
}

function isWavAudio(audio: ArrayBuffer): boolean {
  if (audio.byteLength < WAV_HEADER_LENGTH) {
    return false;
  }
  const header = new Uint8Array(audio, 0, WAV_HEADER_LENGTH);
  const ascii = (offset: number, length: number): string => (
    String.fromCharCode(...header.subarray(offset, offset + length))
  );
  return ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE";
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
      const remaining = maxBytes - total;
      if (remaining > 0) {
        const retained = value.subarray(0, remaining);
        chunks.push(retained);
        total += retained.byteLength;
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

async function runPiper(
  runtime: PiperRuntimeFiles,
  voice: PiperVoiceFiles,
  outputPath: string,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError();
  }

  let child: Bun.Subprocess;
  try {
    child = Bun.spawn([
      runtime.executablePath,
      "--model",
      voice.modelPath,
      "--config",
      voice.configPath,
      "--output_file",
      outputPath,
      "--espeak_data",
      runtime.espeakDataPath,
      "--quiet",
    ], {
      cwd: runtime.directory,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
  } catch (error) {
    throw new DomainError(
      "voice_piper_synthesis_failed",
      "Local Piper speech synthesis could not start.",
      { cause: error },
    );
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, PIPER_SYNTHESIS_TIMEOUT_MS);
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
      "voice_piper_synthesis_failed",
      "Local Piper speech diagnostics are unavailable.",
    );
  }
  const stderrPromise = readBoundedText(stderrStream, 8 * 1024);

  try {
    const stdin = child.stdin;
    if (!stdin || typeof stdin === "number") {
      throw new Error("Piper process stdin is unavailable.");
    }
    stdin.write(`${text.replace(/\s+/g, " ").trim()}\n`);
    stdin.end();

    const exitCode = await child.exited;
    await stderrPromise;
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (timedOut) {
      throw new DomainError(
        "voice_piper_timeout",
        "Local Piper speech synthesis timed out.",
      );
    }
    if (exitCode !== 0) {
      log.error("Piper speech synthesis process failed", {
        exitCode,
      });
      throw new DomainError(
        "voice_piper_synthesis_failed",
        "Local Piper speech synthesis failed.",
      );
    }
  } catch (error) {
    child.kill();
    await child.exited;
    await stderrPromise.catch((stderrError: unknown) => {
      log.warn("Failed to read Piper process diagnostics", {
        error: String(stderrError),
      });
    });
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (timedOut) {
      throw new DomainError(
        "voice_piper_timeout",
        "Local Piper speech synthesis timed out.",
        { cause: error },
      );
    }
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError(
      "voice_piper_synthesis_failed",
      "Local Piper speech synthesis failed.",
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function removeTemporaryDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    log.warn("Failed to clean a temporary Piper audio file", {
      error: String(error),
    });
  }
}

export class PiperTtsProvider implements PiperSpeechService {
  constructor(private readonly assets: PiperAssets = piperAssetManager) {}

  async getStatus(): Promise<PiperSpeechStatus> {
    return await this.assets.getStatus();
  }

  async synthesizeSpeech(
    text: string,
    signal?: AbortSignal,
  ): Promise<PiperSpeechResult> {
    if (!text.trim() || text.length > VOICE_MAX_TEXT_CHARS) {
      throw new DomainError(
        "voice_text_too_large",
        "The text for speech is empty or too long.",
      );
    }
    if (signal?.aborted) {
      throw createAbortError();
    }

    const language = detectPiperLanguage(text);
    const [runtime, voice] = await Promise.all([
      this.assets.ensureRuntime(signal),
      this.assets.ensureVoice(language, signal),
    ]);
    if (signal?.aborted) {
      throw createAbortError();
    }

    const temporaryRoot = join(getDataDir(), "piper-tmp");
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const temporaryDirectory = await mkdtemp(join(temporaryRoot, "speech-"));
    const outputPath = join(temporaryDirectory, "speech.wav");
    try {
      await runPiper(runtime, voice, outputPath, text, signal);
      const output = Bun.file(outputPath);
      if (!await output.exists() || output.size === 0) {
        throw new DomainError(
          "voice_piper_invalid_audio",
          "Piper did not produce an audio file.",
        );
      }
      if (output.size > VOICE_MAX_AUDIO_BYTES) {
        throw new DomainError(
          "voice_piper_audio_too_large",
          "The generated audio exceeds the 20 MB limit.",
        );
      }
      const audio = await output.arrayBuffer();
      if (!isWavAudio(audio)) {
        throw new DomainError(
          "voice_piper_invalid_audio",
          "Piper returned invalid audio.",
        );
      }
      return { audio, contentType: "audio/wav" };
    } finally {
      await removeTemporaryDirectory(temporaryDirectory);
    }
  }
}

export const piperTtsProvider = new PiperTtsProvider();
