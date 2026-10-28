/**
 * OpenAI-compatible provider adapter for transcription and text.
 */

import { DomainError } from "../domain/domain-error";
import { getVoiceAudioExtension } from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { textResponseUsage } from "./live-voice-latency";

const textLog = createLogger("core:voice-text");

export const VOICE_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const VOICE_MAX_SUMMARY_CHARS = 8_000;
export const VOICE_PROVIDER_TIMEOUT_MS = 120_000;
export const VOICE_AZURE_API_VERSION = "2025-03-01-preview";
export const VOICE_TEXT_REASONING = { effort: "none" } as const;
const VOICE_MAX_PROVIDER_JSON_BYTES = 1 * 1024 * 1024;

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
  signal?: AbortSignal;
}

function isAzureOpenAiUrl(url: URL): boolean {
  return url.hostname.toLowerCase().endsWith(".openai.azure.com");
}

function assertAllowedQueryParams(url: URL): void {
  const keys = Array.from(url.searchParams.keys());
  if (keys.some((key) => key.toLowerCase() !== "api-version")) {
    throw new DomainError(
      "voice_invalid_base_url",
      "The voice provider base URL may only include the api-version query parameter.",
    );
  }
  if (keys.filter((key) => key.toLowerCase() === "api-version").length > 1) {
    throw new DomainError(
      "voice_invalid_base_url",
      "The voice provider base URL may only include one api-version query parameter.",
    );
  }
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
  if (normalizedPath === "responses") {
    return buildVoiceV1Url(normalizedBaseUrl, normalizedPath);
  }

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

export function buildVoiceV1Url(baseUrl: string, path: string): string {
  const base = new URL(normalizeVoiceBaseUrl(baseUrl));
  if (isAzureOpenAiUrl(base)) {
    base.pathname = `${azureResourcePath(base.pathname).replace(/\/+$/, "")}/openai/v1`;
    base.search = "";
  } else if (base.pathname === "/") {
    base.pathname = "/v1";
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
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
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
  ) {
    throw new DomainError(
      "voice_invalid_base_url",
      "The voice provider base URL must be an HTTPS URL without credentials or a fragment.",
    );
  }
  assertAllowedQueryParams(url);
  return url.toString().replace(/\/+$/, "");
}

export function providerError(
  status: number,
  retryAfter?: string | null,
): DomainError {
  if (status === 429) {
    return new DomainError(
      "voice_provider_rate_limited",
      "The voice provider rate limit was reached.",
      {
        details: {
          status,
          ...(retryAfter ? { retryAfter } : {}),
        },
      },
    );
  }
  return new DomainError(
    "voice_provider_request_failed",
    "The voice provider rejected the request.",
    { details: { status } },
  );
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new DomainError(
      "voice_provider_response_too_large",
      "The voice provider response is too large.",
    );
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("The voice provider request was aborted.", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {
          // The size violation remains the authoritative provider error.
        });
        throw new DomainError(
          "voice_provider_response_too_large",
          "The voice provider response is too large.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readJsonResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  const body = await readBoundedResponseBody(
    response,
    VOICE_MAX_PROVIDER_JSON_BYTES,
    signal,
  );
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch (error) {
    throw new DomainError(
      "voice_provider_invalid_response",
      "The voice provider returned invalid data.",
      { cause: error },
    );
  }
}

export async function fetchWithTimeout<T>(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  consume: (response: Response, requestSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    VOICE_PROVIDER_TIMEOUT_MS,
  );
  const abortCaller = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abortCaller, { once: true });
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      throw new DomainError(
        "voice_provider_redirect",
        "The voice provider must not redirect requests.",
        { details: { status: response.status } },
      );
    }
    return await consume(response, controller.signal);
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    if (signal?.aborted) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new DomainError(
        "voice_provider_timeout",
        "The voice provider request timed out.",
        { cause: error },
      );
    }
    throw new DomainError(
      "voice_provider_unreachable",
      "The voice provider could not be reached.",
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortCaller);
  }
}

function extractResponseText(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  if (record["status"] !== "completed" || record["error"]) {
    throw new DomainError("voice_provider_invalid_response", "The text provider did not complete its response.");
  }
  const output = record["output"];
  if (!Array.isArray(output)) return "";
  const texts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === "output_text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  return texts.join("\n").trim();
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

    return await fetchWithTimeout(
      this.url("/audio/transcriptions", options.model),
      {
        method: "POST",
        headers: this.headers,
        body: form,
      },
      options.signal,
      async (response, requestSignal) => {
        if (!response.ok) {
          throw providerError(response.status, response.headers.get("retry-after"));
        }

        const payload = await readJsonResponse(response, requestSignal);
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
      },
    );
  }

  async completeText(
    model: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    textLog.info("Shared text generation started", { requestId, reasoningEffort: VOICE_TEXT_REASONING.effort });
    try {
      return await fetchWithTimeout(
        this.url("/responses", model),
        {
          method: "POST",
          headers: {
            ...this.headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            reasoning: VOICE_TEXT_REASONING,
            input: [{ role: "user", content: prompt }],
            max_output_tokens: 4096,
            store: false,
          }),
        },
        signal,
        async (response, requestSignal) => {
          if (!response.ok) {
            throw providerError(response.status, response.headers.get("retry-after"));
          }

          const payload = await readJsonResponse(response, requestSignal);
          const text = extractResponseText(payload);
          if (!text) {
            throw new DomainError(
              "voice_provider_invalid_response",
              "The text provider returned an empty response.",
            );
          }
          textLog.info("Shared text generation completed", {
            requestId, elapsedMs: Math.round(performance.now() - startedAt),
            ...textResponseUsage(payload),
          });
          return text;
        },
      );
    } catch (error) {
      textLog.error("Shared text generation failed", {
        requestId, elapsedMs: Math.round(performance.now() - startedAt),
        code: error instanceof DomainError ? error.code : "unexpected_error",
      });
      throw error;
    }
  }

  async validateTranscription(
    model: string,
    languageHints: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.transcribe({
      audio: createValidationWav(),
      filename: "voice-validation.wav",
      mimeType: "audio/wav",
      model,
      languageHints,
      signal,
    });
  }

  private url(path: string, model: string): string {
    return buildVoiceProviderUrl(this.baseUrl, path, model);
  }
}
