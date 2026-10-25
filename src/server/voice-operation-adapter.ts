/**
 * Private request authorization and in-process framework dispatch for voice.
 */

import type {
  RouteCatalogEntry, RouteContext, WebAppServer,
} from "@pablozaiden/webapp/server";
import { getRequestOriginInfo, createLogger } from "@pablozaiden/webapp/server";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type { ClankyRealtimeEvent } from "@/shared/realtime";
import type {
  OperationAuthority, OperationRequest, OperationResult,
} from "../core/clanky-operation-service";
import { DomainError } from "../domain/domain-error";

const log = createLogger("server:voice-operations");
const MAX_RESPONSE_BYTES = 200_000;

interface AuthorityState {
  user: CurrentUser;
  scopes: readonly string[] | null;
  headers: Headers;
  origin: string;
}

function capture(req: Request, ctx: RouteContext, app: WebAppServer<ClankyRealtimeEvent>): AuthorityState {
  const headers = new Headers();
  for (const name of ["authorization", "cookie"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const scopes = ctx.auth.kind === "api-key" ? [...ctx.auth.scopes]
    : ctx.auth.kind === "bearer" ? ctx.auth.claims.scope.split(/\s+/).filter(Boolean) : null;
  return { user: ctx.requireUser(), scopes, headers, origin: getRequestOriginInfo(req, app.config).origin };
}

function permits(state: Pick<AuthorityState, "user" | "scopes">, entry: RouteCatalogEntry): boolean {
  if (entry.auth === "owner" && !state.user.isOwner
    || entry.auth === "admin" && !state.user.isAdmin) return false;
  return state.scopes === null || state.scopes.includes("*")
    || entry.scopes.every((scope) => state.scopes!.includes(scope));
}

class VoiceOperationAuthority implements OperationAuthority {
  private current: AuthorityState;
  private readonly ceiling: Pick<AuthorityState, "user" | "scopes">;
  private released = false;

  constructor(private readonly app: WebAppServer<ClankyRealtimeEvent>, state: AuthorityState) {
    this.current = state;
    this.ceiling = { user: { ...state.user }, scopes: state.scopes ? [...state.scopes] : null };
  }

  allows = (entry: RouteCatalogEntry): boolean =>
    !this.released && permits(this.ceiling, entry) && permits(this.current, entry);

  refresh(next: OperationAuthority): void {
    if (!(next instanceof VoiceOperationAuthority) || next.current.user.id !== this.current.user.id || this.released) {
      next.release();
      throw new DomainError("voice_live_not_found", "The originating authorization is unavailable.");
    }
    this.current.headers = new Headers();
    this.current = { ...next.current, headers: new Headers(next.current.headers) };
    next.release();
  }

  async request(input: OperationRequest): Promise<Omit<OperationResult, "operationId" | "completion">> {
    if (this.released || input.signal.aborted) throw new DomainError("voice_live_not_found", "The call has ended.");
    const headers = new Headers(this.current.headers);
    headers.set("origin", this.current.origin);
    headers.set("content-type", "application/json");
    for (const [name, value] of Object.entries(input.headers ?? {})) headers.set(name, value);
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      const dispatch = async () => {
        const response = await this.app.handleRequest(new Request(new URL(input.path, this.current.origin), {
          method: input.method, headers,
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          signal,
        }));
        if (!response) throw new DomainError("voice_operation_response", "The operation returned no HTTP response.");
        if (response.status === 204) return { ok: true, status: 204, data: null };
        if (!response.headers.get("content-type")?.includes("application/json")) {
          await response.body?.cancel();
          return { ok: false, status: response.status, code: "voice_operation_response", message: "The operation did not return JSON." };
        }
        const reader = response.body?.getReader();
        if (!reader) throw new DomainError("voice_operation_response", "The operation returned an empty response.");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              return { ok: false, status: response.status, code: "voice_operation_response_too_large",
                message: `The response exceeds ${MAX_RESPONSE_BYTES} bytes. Use paging or a targeted read. A successful mutation may already have taken effect; do not repeat it.` };
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
        return { ok: response.ok, status: response.status, data };
      };
      return await Promise.race([
        dispatch(),
        new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(new DomainError("voice_operation_interrupted", "The operation was interrupted; inspect its state before repeating a mutation."));
          signal.addEventListener("abort", abortListener, { once: true });
          timer = setTimeout(() => controller.abort(), 30_000);
          if (signal.aborted) abortListener();
        }),
      ]);
    } catch (error) {
      log[error instanceof DomainError ? "warn" : "error"]("Voice API dispatch failed", {
        method: input.method, code: error instanceof DomainError ? error.code : "unexpected_error",
      });
      return { ok: false, code: error instanceof DomainError ? error.code : "voice_operation_failed",
        message: "No authoritative result was received. Inspect the target before repeating a mutation." };
    } finally {
      clearTimeout(timer);
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
  }

  release(): void {
    this.released = true;
    this.current.headers = new Headers();
  }
}

export function createVoiceOperationAuthority(
  app: WebAppServer<ClankyRealtimeEvent>, req: Request, ctx: RouteContext,
): OperationAuthority {
  return new VoiceOperationAuthority(app, capture(req, ctx, app));
}
