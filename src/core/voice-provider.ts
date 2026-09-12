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
const VOICE_MAX_PROVIDER_JSON_BYTES = 1 * 1024 * 1024;
const VOICE_TEST_CONTEXT_ENV = "CLANKY_TEST_OWNER_CONTEXT";

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

export interface VoiceSpeechOptions {
  text: string;
  model: string;
  voice: string;
  signal?: AbortSignal;
}

export interface VoiceAudioResult {
  audio: ArrayBuffer;
  contentType: string;
}

function isAzureOpenAiUrl(url: URL): boolean {
  return url.hostname.toLowerCase().endsWith(".openai.azure.com");
}

function isTestContext(): boolean {
  return process.env[VOICE_TEST_CONTEXT_ENV] === "1";
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1";
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number(part));
  if (
    octets.some((octet, index) => (
      !Number.isInteger(octet)
      || octet < 0
      || octet > 255
      || parts[index] !== String(octet)
    ))
  ) {
    return null;
  }
  return octets;
}

function isPrivateIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) {
    return false;
  }
  const [first = 0, second = 0] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0)
    || (first === 192 && second === 168)
    || (first === 192 && second === 2)
    || (first === 198 && second >= 18 && second <= 19)
    || (first === 198 && second === 51)
    || (first === 203 && second === 0)
    || first >= 224;
}

function parseIpv6Words(address: string): number[] | null {
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase().split("%", 1)[0] ?? "";
  const sections = normalized.split("::");
  if (sections.length > 2) {
    return null;
  }
  const parseSection = (section: string): number[] | null => {
    if (!section) {
      return [];
    }
    const words: number[] = [];
    for (const segment of section.split(":")) {
      if (segment.includes(".")) {
        const octets = parseIpv4(segment);
        if (!octets) {
          return null;
        }
        const [first = 0, second = 0, third = 0, fourth = 0] = octets;
        words.push((first << 8) | second, (third << 8) | fourth);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(segment)) {
        return null;
      }
      words.push(Number.parseInt(segment, 16));
    }
    return words;
  };

  const left = parseSection(sections[0] ?? "");
  const right = parseSection(sections.length === 2 ? sections[1] ?? "" : "");
  if (!left || !right) {
    return null;
  }
  if (sections.length === 1) {
    return left.length === 8 ? left : null;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 1) {
    return null;
  }
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function isPrivateIpv6(address: string): boolean {
  if (!address.includes(":")) {
    return false;
  }
  const words = parseIpv6Words(address);
  if (!words) {
    return false;
  }
  const first = words[0] ?? 0;
  const isMappedIpv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const mappedIpv4 = isMappedIpv4
    ? `${(words[6] ?? 0) >> 8}.${(words[6] ?? 0) & 0xff}.${(words[7] ?? 0) >> 8}.${(words[7] ?? 0) & 0xff}`
    : null;
  return words.every((word) => word === 0)
    || words.slice(0, 7).every((word) => word === 0) && words[7] === 1
    || (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00
    || (first === 0x2001 && words[1] === 0x0db8)
    || (mappedIpv4 !== null && isPrivateIpv4(mappedIpv4));
}

function isPrivateAddress(address: string): boolean {
  return address.includes(":")
    ? isPrivateIpv6(address)
    : isPrivateIpv4(address);
}

function assertSafeBaseUrlHost(url: URL): void {
  const hostname = url.hostname;
  if (isPrivateAddress(hostname) && !(isTestContext() && isLoopbackHostname(hostname))) {
    throw new DomainError(
      "voice_unsafe_provider_url",
      "The voice provider URL must resolve to a public address.",
    );
  }
  if (url.protocol === "http:" && !(isTestContext() && isLoopbackHostname(hostname))) {
    throw new DomainError(
      "voice_invalid_base_url",
      "The voice provider base URL must use HTTPS.",
    );
  }
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
  assertAllowedQueryParams(url);
  assertSafeBaseUrlHost(url);
  return url.toString().replace(/\/+$/, "");
}

function providerError(
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

async function assertSafeProviderDestination(url: string): Promise<void> {
  const parsed = new URL(url);
  assertSafeBaseUrlHost(parsed);
  if (isTestContext() && isLoopbackHostname(parsed.hostname)) {
    return;
  }

  let addresses: Bun.DNSLookup[];
  try {
    addresses = await Bun.dns.lookup(parsed.hostname, { family: "any" });
  } catch (error) {
    throw new DomainError(
      "voice_provider_unreachable",
      "The voice provider could not be reached.",
      { cause: error },
    );
  }
  if (
    addresses.length === 0
    || addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new DomainError(
      "voice_unsafe_provider_url",
      "The voice provider URL must resolve to a public address.",
    );
  }
  // Resolve immediately before fetch so a later request does not reuse an
  // earlier hostname decision; prefetch also narrows the DNS rebinding window.
  Bun.dns.prefetch(
    parsed.hostname,
    parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80,
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

async function readJsonResponse(
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

async function fetchWithTimeout<T>(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  consume: (response: Response, requestSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  await assertSafeProviderDestination(url);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    VOICE_PROVIDER_TIMEOUT_MS,
  );
  const abortCaller = (): void => controller.abort();
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

  async synthesizeSpeech(options: VoiceSpeechOptions): Promise<VoiceAudioResult> {
    return await fetchWithTimeout(
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
      options.signal,
      async (response, requestSignal) => {
        if (!response.ok) {
          throw providerError(response.status, response.headers.get("retry-after"));
        }

        const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        if (!contentType || (!contentType.startsWith("audio/") && contentType !== "application/octet-stream")) {
          throw new DomainError(
            "voice_provider_invalid_response",
            "The speech provider did not return audio.",
          );
        }
        const audio = await readBoundedResponseBody(
          response,
          VOICE_MAX_AUDIO_BYTES,
          requestSignal,
        );
        if (audio.byteLength === 0) {
          throw new DomainError(
            "voice_provider_invalid_response",
            "The speech provider returned invalid audio.",
          );
        }
        const audioBuffer = new Uint8Array(audio.byteLength);
        audioBuffer.set(audio);
        return {
          audio: audioBuffer.buffer,
          contentType,
        };
      },
    );
  }

  async completeText(
    model: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return await fetchWithTimeout(
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
        return text;
      },
    );
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
