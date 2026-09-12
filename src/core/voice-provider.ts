/**
 * OpenAI-compatible provider adapter for transcription, speech, and text.
 */

import { DomainError } from "../domain/domain-error";
import { getVoiceAudioExtension } from "@/shared";

export const VOICE_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const VOICE_MAX_TEXT_CHARS = 30_000;
export const VOICE_MAX_SUMMARY_CHARS = 8_000;
export const VOICE_PROVIDER_TIMEOUT_MS = 120_000;
export const VOICE_AZURE_API_VERSION = "2025-03-01-preview";

export interface VoiceProviderCredentials {
  baseUrl: string;
  apiKey: string;
}

export interface VoiceTranscriptionOptions {
  audio: Blob;
  filename: string;
  mimeType: string;
  model: string;
  languageHints: readonly string[];
}

export interface VoiceSpeechOptions {
  text: string;
  model: string;
  voice: string;
}

export interface VoiceAudioResult {
  audio: ArrayBuffer;
  contentType: string;
}

function isAzureOpenAiUrl(url: URL): boolean {
  return url.hostname.toLowerCase().endsWith(".openai.azure.com");
}

function azureResourcePath(pathname: string): string {
  const openAiPathIndex = pathname.indexOf("/openai");
  return openAiPathIndex >= 0 ? pathname.slice(0, openAiPathIndex) : pathname;
}

export function buildVoiceProviderUrl(
  baseUrl: string,
  path: string,
  model?: string,
): string {
  const normalizedBaseUrl = normalizeVoiceBaseUrl(baseUrl);
  const base = new URL(normalizedBaseUrl);
  const normalizedPath = path.replace(/^\/+/, "");

  if (isAzureOpenAiUrl(base)) {
    if (!model?.trim()) {
      throw new DomainError(
        "voice_provider_invalid_request",
        "An Azure deployment model is required.",
      );
    }
    base.pathname = [
      azureResourcePath(base.pathname).replace(/\/+$/, ""),
      "openai",
      "deployments",
      encodeURIComponent(model.trim()),
      normalizedPath,
    ].filter(Boolean).join("/");
    if (!base.searchParams.has("api-version")) {
      base.searchParams.set("api-version", VOICE_AZURE_API_VERSION);
    }
    return base.toString();
  }

  base.pathname = [
    base.pathname.replace(/\/+$/, ""),
    normalizedPath,
  ].filter(Boolean).join("/");
  return base.toString();
}

export function normalizeVoiceBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new DomainError(
      "voice_invalid_base_url",
      "The voice provider base URL is invalid.",
      { cause: error },
    );
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username
    || url.password
    || url.hash
  ) {
    throw new DomainError(
      "voice_invalid_base_url",
      "The voice provider base URL must be an HTTP(S) URL without credentials or a fragment.",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function providerError(
  status: number,
): DomainError {
  if (status === 429) {
    return new DomainError(
      "voice_provider_rate_limited",
      "The voice provider rate limit was reached.",
      { details: { status } },
    );
  }
  return new DomainError(
    "voice_provider_request_failed",
    "The voice provider rejected the request.",
    { details: { status } },
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VOICE_PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError(
      "voice_provider_unreachable",
      "The voice provider could not be reached.",
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}

function extractResponseText(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  const choices = record["choices"];
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
    return "";
  }
  const choice = choices[0] as Record<string, unknown>;
  const message = choice["message"];
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const text = (part as Record<string, unknown>)["text"];
      return typeof text === "string" ? text : "";
    })
    .join("")
    .trim();
}

function createValidationWav(): Blob {
  const sampleRate = 8_000;
  const sampleCount = sampleRate / 4;
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  return new Blob([bytes], { type: "audio/wav" });
}

function ensureAudioFilenameExtension(filename: string, mimeType: string): string {
  const normalizedFilename = filename.trim() || "recording";
  if (/\.[a-z0-9]+$/i.test(normalizedFilename)) {
    return normalizedFilename;
  }

  return `${normalizedFilename}.${getVoiceAudioExtension(mimeType)}`;
}

export class OpenAiCompatibleVoiceProvider {
  private readonly baseUrl: string;
  private readonly headers: HeadersInit;

  constructor(credentials: VoiceProviderCredentials) {
    const baseUrl = normalizeVoiceBaseUrl(credentials.baseUrl);
    if (!baseUrl || !credentials.apiKey.trim()) {
      throw new DomainError(
        "voice_not_configured",
        "The voice provider is not configured.",
      );
    }
    this.baseUrl = baseUrl;
    this.headers = {
      Accept: "application/json",
      Authorization: `Bearer ${credentials.apiKey}`,
      // Azure AI Foundry accepts api-key while OpenAI accepts Authorization.
      // Sending both keeps the adapter endpoint-neutral without exposing either
      // credential to the browser.
      "api-key": credentials.apiKey,
    };
  }

  async transcribe(options: VoiceTranscriptionOptions): Promise<string> {
    if (options.audio.size <= 0 || options.audio.size > VOICE_MAX_AUDIO_BYTES) {
      throw new DomainError(
        "voice_audio_too_large",
        "The recording is empty or exceeds the 20 MB limit.",
      );
    }

    const form = new FormData();
    const mimeType = options.mimeType || options.audio.type || "application/octet-stream";
    form.append(
      "file",
      new File([options.audio], ensureAudioFilenameExtension(options.filename, mimeType), {
        type: mimeType,
      }),
    );
    form.append("model", options.model);
    form.append("response_format", "json");
    form.append(
      "prompt",
      [
        "Transcribe exactly what the speaker says.",
        "The speaker may switch between multiple languages in the same sentence.",
        options.languageHints.length > 0
          ? `Possible languages: ${options.languageHints.join(", ")}.`
          : "Detect the language automatically.",
        "Preserve code, product, workspace, Git, and programming terms accurately.",
      ].join(" "),
    );

    const response = await fetchWithTimeout(
      this.url("/audio/transcriptions", options.model),
      {
        method: "POST",
        headers: this.headers,
        body: form,
      },
    );
    if (!response.ok) {
      throw providerError(response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new DomainError(
        "voice_provider_invalid_response",
        "The transcription provider returned invalid data.",
        { cause: error },
      );
    }
    const text = payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)["text"]
      : undefined;
    if (typeof text !== "string") {
      throw new DomainError(
        "voice_provider_invalid_response",
        "The transcription provider did not return transcript text.",
      );
    }
    return text.trim();
  }

  async synthesizeSpeech(options: VoiceSpeechOptions): Promise<VoiceAudioResult> {
    const response = await fetchWithTimeout(
      this.url("/audio/speech", options.model),
      {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
          Accept: "audio/mpeg, audio/wav, application/octet-stream",
        },
        body: JSON.stringify({
          model: options.model,
          input: options.text,
          voice: options.voice,
          response_format: "mp3",
        }),
      },
    );
    if (!response.ok) {
      throw providerError(response.status);
    }

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > VOICE_MAX_AUDIO_BYTES) {
      throw new DomainError(
        "voice_provider_response_too_large",
        "The speech provider returned an audio response that is too large.",
      );
    }
    const audio = await response.arrayBuffer();
    if (audio.byteLength === 0 || audio.byteLength > VOICE_MAX_AUDIO_BYTES) {
      throw new DomainError(
        "voice_provider_invalid_response",
        "The speech provider returned invalid audio.",
      );
    }
    return {
      audio,
      contentType: response.headers.get("content-type")?.split(";")[0]?.trim()
        || "audio/mpeg",
    };
  }

  async completeText(model: string, prompt: string): Promise<string> {
    const response = await fetchWithTimeout(
      this.url("/chat/completions", model),
      {
        method: "POST",
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_completion_tokens: 512,
        }),
      },
    );
    if (!response.ok) {
      throw providerError(response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new DomainError(
        "voice_provider_invalid_response",
        "The text provider returned invalid data.",
        { cause: error },
      );
    }
    const text = extractResponseText(payload);
    if (!text) {
      throw new DomainError(
        "voice_provider_invalid_response",
        "The text provider returned an empty response.",
      );
    }
    return text;
  }

  async validateTranscription(model: string, languageHints: readonly string[]): Promise<void> {
    await this.transcribe({
      audio: createValidationWav(),
      filename: "voice-validation.wav",
      mimeType: "audio/wav",
      model,
      languageHints,
    });
  }

  private url(path: string, model: string): string {
    return buildVoiceProviderUrl(this.baseUrl, path, model);
  }
}
