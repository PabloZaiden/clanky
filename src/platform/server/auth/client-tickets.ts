import type { ClientTicketRequest, ClientTicketResponse } from "../../contracts";
import { randomToken, sha256 } from "./crypto";
import { AuthError, type AuthenticatedRequestState } from "./types";

export const CLIENT_TICKET_PARAMETER = "webapp_ticket";
const MAX_TICKETS = 4096;
const MAX_SESSION_TICKETS = 128;
const TICKET_TTL = { websocket: 30_000, resource: 60_000 } as const;
const TICKET_SUFFIX = new RegExp(`[?&]${CLIENT_TICKET_PARAMETER}=[A-Za-z0-9_%~-]+$`);
type BearerAuth = Extract<AuthenticatedRequestState, { kind: "bearer" }>;

interface ClientTicket {
  token: string;
  target: string;
  kind: ClientTicketRequest["kind"];
  origin: string | null;
  userId: string;
  sessionId: string;
  expiresAt: number;
}

function targetUrl(target: string, kind: ClientTicketRequest["kind"], realtimePath: string): URL {
  if (
    !target.startsWith("/") || target.startsWith("//") || target.length > 16_384
    || /[\\#\u0000-\u0020\u007f]/.test(target)
    || /%(?![a-f\d]{2})/i.test(target)
  ) {
    throw new AuthError("invalid_ticket_target", "Ticket target must be an application-relative API or realtime URL", 400);
  }
  const url = new URL(target, "https://ticket.invalid");
  if (
    url.origin !== "https://ticket.invalid"
    || !(url.pathname.startsWith("/api/") || (kind === "websocket" && url.pathname === realtimePath))
    || url.pathname + url.search !== target
    || /%00/i.test(url.pathname)
    || url.searchParams.has(CLIENT_TICKET_PARAMETER)
  ) {
    throw new AuthError("invalid_ticket_target", "Invalid ticket target", 400);
  }
  return url;
}

export function createClientTickets(verify: (token: string) => Promise<BearerAuth>, realtimePath: string) {
  const tickets = new Map<string, ClientTicket>();
  const prepared = new WeakMap<Request, BearerAuth>();

  function prune(): void {
    const now = Date.now();
    for (const [key, ticket] of tickets) {
      if (ticket.expiresAt <= now) tickets.delete(key);
    }
  }

  return {
    issue(req: Request, auth: BearerAuth, input: ClientTicketRequest, token: string): ClientTicketResponse {
      const origin = req.headers.get("origin");
      const target = targetUrl(input.url, input.kind, realtimePath);
      prune();
      let count = 0;
      for (const ticket of tickets.values()) {
        if (ticket.sessionId === auth.claims.sid) count += 1;
      }
      if (tickets.size >= MAX_TICKETS || count >= MAX_SESSION_TICKETS) {
        throw new AuthError("client_ticket_limit", "Too many outstanding client tickets", 429);
      }
      const opaque = randomToken(32);
      const expiresAt = Date.now() + TICKET_TTL[input.kind];
      tickets.set(sha256(opaque), {
        token, target: target.pathname + target.search, kind: input.kind, origin,
        userId: auth.user.id, sessionId: auth.claims.sid, expiresAt,
      });
      const separator = target.search ? "&" : "?";
      return { url: `${input.url}${separator}${CLIENT_TICKET_PARAMETER}=${encodeURIComponent(opaque)}`, expiresAt };
    },
    async prepare(req: Request): Promise<Request> {
      const url = new URL(req.url);
      if (!url.searchParams.has(CLIENT_TICKET_PARAMETER)) return req;
      prune();
      const values = url.searchParams.getAll(CLIENT_TICKET_PARAMETER);
      const key = sha256(values[0] ?? "");
      const ticket = values.length === 1 ? tickets.get(key) : undefined;
      const websocket = req.headers.get("upgrade")?.toLowerCase() === "websocket";
      const origin = req.headers.get("origin");
      // Removing only the final parameter preserves the original query byte-for-byte.
      const target = (url.pathname + url.search).replace(TICKET_SUFFIX, "");
      if (
        !ticket || ticket.target !== target || req.headers.has("authorization")
        || (ticket.kind === "websocket" ? req.method !== "GET" || !websocket || origin !== ticket.origin
          : !["GET", "HEAD"].includes(req.method) || websocket || (origin !== null && origin !== ticket.origin))
      ) {
        throw new AuthError("invalid_client_ticket", "Client ticket is invalid or expired", 401);
      }
      if (ticket.kind === "websocket") tickets.delete(key);
      let auth: BearerAuth;
      try {
        auth = await verify(ticket.token);
      } catch {
        tickets.delete(key);
        throw new AuthError("invalid_client_ticket", "Client ticket session is no longer valid", 401);
      }
      if (auth.user.id !== ticket.userId || auth.claims.sid !== ticket.sessionId) {
        tickets.delete(key);
        throw new AuthError("invalid_client_ticket", "Client ticket session is no longer valid", 401);
      }
      const clean = new URL(req.url);
      clean.search = target.slice(url.pathname.length);
      const request = new Request(clean, req);
      prepared.set(request, { ...auth, clientTicket: { kind: ticket.kind, origin: ticket.origin } });
      return request;
    },
    authentication(req: Request): BearerAuth | undefined {
      return prepared.get(req);
    },
    clear(): void {
      tickets.clear();
    },
  };
}
