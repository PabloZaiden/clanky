/**
 * Scoped HTTP client for the common application-control boundary.
 */

import { z } from "zod";
import { ClankyControlContextSchema, type ClankyControlContext } from "@/shared/clanky-control";

const MAX_RESPONSE_BYTES = 200_000;
const REQUEST_TIMEOUT_MS = 30_000;

const ToolInventorySchema = z.object({
  tools: z.array(z.object({
    name: z.string().regex(/^[A-Za-z0-9_-]+$/).max(128),
    description: z.string().max(30_000),
    inputSchema: z.record(z.string(), z.json()),
  }).strict()).max(100),
}).strict();

export type ClankyControlToolDefinition = z.infer<typeof ToolInventorySchema>["tools"][number];
export type ClankyControlToolResult = unknown;
interface ToolDiscoveryOptions { chatId?: string; signal?: AbortSignal }

interface ToolFailure {
  ok: false;
  completion?: "outcome_unknown";
  error: { code: string; message: string; status?: number };
}

type HttpResult =
  | { ok: true; data: unknown }
  | { ok: false; failure: ToolFailure };

async function readResponseBodyLimited(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function toolFailure(code: string, message: string, status?: number, uncertain = false): ToolFailure {
  return {
    ok: false,
    ...(uncertain ? { completion: "outcome_unknown" as const } : {}),
    error: { code, message, ...(status === undefined ? {} : { status }) },
  };
}

export class ClankyControlApiClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string;

  constructor(environment: Record<string, string | undefined>) {
    const baseUrl = environment["CLANKY_BASE_URL"]?.trim();
    const apiKey = environment["CLANKY_API_KEY"]?.trim();
    if (!baseUrl || !apiKey) {
      throw new Error("Managed Clanky API credentials are required for control tools.");
    }
    this.baseUrl = new URL(baseUrl);
    if (
      (this.baseUrl.protocol !== "http:" && this.baseUrl.protocol !== "https:")
      || this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash
    ) {
      throw new Error("The managed Clanky API base URL is invalid.");
    }
    this.apiKey = apiKey;
  }

  async listTools({ chatId, signal }: ToolDiscoveryOptions = {}): Promise<readonly ClankyControlToolDefinition[]> {
    const query = new URLSearchParams();
    if (chatId) query.set("chatId", chatId);
    const result = await this.request(`/api/control/tools${query.size ? `?${query}` : ""}`, undefined, signal);
    if (!result.ok) throw new Error(result.failure.error.message);
    const inventory = ToolInventorySchema.parse(result.data);
    if (new Set(inventory.tools.map((tool) => tool.name)).size !== inventory.tools.length) {
      throw new Error("The Clanky control inventory contains duplicate tool names.");
    }
    return inventory.tools;
  }

  async invoke(name: string, input: unknown, context?: ClankyControlContext, signal?: AbortSignal): Promise<unknown> {
    const result = await this.request(`/api/control/tools/${encodeURIComponent(name)}`, {
      input, ...(context ? { context } : {}),
    }, signal);
    return result.ok ? result.data : result.failure;
  }

  private async request(path: string, body: unknown | undefined, signal?: AbortSignal): Promise<HttpResult> {
    const url = new URL(path, this.baseUrl);
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const failure = (code: string, message: string, status?: number, uncertain = body !== undefined): HttpResult =>
      ({ ok: false, failure: toolFailure(code, message, status, uncertain) });
    try {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          Origin: this.baseUrl.origin,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
      const responseBody = await readResponseBodyLimited(response);
      if (responseBody === null) {
        return failure("clanky_response_too_large", "The Clanky control response exceeds the tool output limit.", response.status);
      }
      let data: unknown;
      try {
        data = JSON.parse(responseBody) as unknown;
      } catch {
        return failure("invalid_control_response", "Clanky returned an invalid control response.", response.status);
      }
      if (!response.ok) {
        // A common failure envelope is already safe, structured tool output.
        if (typeof data === "object" && data !== null && "ok" in data && data.ok === false) {
          return { ok: true, data };
        }
        return failure("clanky_control_error", `Clanky returned HTTP ${response.status}.`, response.status, response.status >= 500 && body !== undefined);
      }
      return { ok: true, data };
    } catch {
      if (controller.signal.aborted) {
        return failure(
          signal?.aborted ? "control_tool_cancelled" : "clanky_api_timeout",
          signal?.aborted ? "The control tool was cancelled." : "The Clanky control request timed out.",
        );
      }
      return failure("clanky_api_unavailable", "The Clanky control request could not be completed.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

export class ClankyControlToolService {
  private readonly api: ClankyControlApiClient;
  private readonly toolsByName = new Set<string>();
  private readonly lifetime = new AbortController();

  constructor(environment: Record<string, string | undefined>) {
    this.api = new ClankyControlApiClient(environment);
  }

  async listTools({ chatId, signal }: ToolDiscoveryOptions = {}): Promise<readonly ClankyControlToolDefinition[]> {
    const definitions = await this.api.listTools({
      chatId,
      signal: AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
    });
    for (const definition of definitions) this.toolsByName.add(definition.name);
    return definitions;
  }

  async invoke(
    name: string,
    input: unknown,
    context: ClankyControlContext | undefined,
    signal?: AbortSignal,
  ): Promise<ClankyControlToolResult> {
    const parsed = ClankyControlContextSchema.optional().safeParse(context);
    if (!parsed.success) {
      return toolFailure("control_context_invalid", "The supplied Clanky chat-turn context is invalid.");
    }
    if (!this.toolsByName.has(name)) {
      return toolFailure("unknown_control_tool", "The requested Clanky tool is not available.");
    }
    return await this.api.invoke(name, input, parsed.data, AbortSignal.any([
      this.lifetime.signal, ...(signal ? [signal] : []),
    ]));
  }

  close(): void {
    this.lifetime.abort();
    this.toolsByName.clear();
  }
}
