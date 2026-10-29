import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger } from "@pablozaiden/webapp/server";
import type { ClankyControlContext, ControlUiAction } from "@/shared/clanky-control";
import type { ControlRequestSnapshot, ControlRequestSummary } from "@/contracts/schemas/control";
import { requireCurrentUserId } from "../context/user-context";
import { DomainError, isDomainError } from "../domain/domain-error";
import { readBytes, isReadRecord } from "../client-sdk/collaboration/resource-read";
import { ControlActions, type ControlInteractionOutcome } from "./control-actions";
import type { ControlGrant, ControlOperationAuthority } from "./control-authority";
import type { ClankyOperationService } from "./clanky-operation-service";
import { controlToolDefinitions, isControlToolName } from "./control-tool-contracts";
import { controlUiToolDefinitions, isControlUiToolName } from "./control-ui-tools";
import { executeControlTool } from "./control-tools";
import { requireControlChat, resolveControlOrigin } from "./control-origin";
import { controlUiActionService } from "./control-ui-action-service";

const log = createLogger("core:control-sessions");
const SESSION_TTL_MS = 10 * 60_000;
const CONFIRMATION_TTL_MS = 60 * 60_000;
const RESULT_TTL_MS = 60_000;
const EXECUTION_TIMEOUT_MS = 90_000;
const MAX_SESSIONS = 128;
const MAX_REQUESTS = 256;
const MAX_IN_FLIGHT = 16;
const MAX_RESULT_BYTES = 200_000;
const GENERAL_TOOLS = new Set(["clanky_list_servers", "clanky_create_workspace"]);

export interface ControlAccess {
  readonly grant: ControlGrant;
  readonly revalidate: () => Promise<ControlGrant>;
}

interface ControlRun {
  controller: AbortController;
  pending: ReturnType<typeof Promise.withResolvers<unknown>>;
  browser?: ClankyControlContext;
  requests: Set<string>;
  work?: Promise<unknown>;
  detach: () => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ControlSession {
  access: ControlAccess;
  authority: ControlOperationAuthority;
  actions: ControlActions;
  expiresAt: number;
  runs: Set<ControlRun>;
}

interface HumanRequest {
  session: ControlSession;
  snapshot: ControlRequestSnapshot;
  browser?: ClankyControlContext;
  run?: ControlRun;
  removeAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class ControlSessionService {
  private readonly sessions = new Map<string, ControlSession>();
  private readonly requests = new Map<string, HumanRequest>();
  private readonly invocation = new AsyncLocalStorage<{ session: ControlSession; run: ControlRun }>();
  private readonly actor = new AsyncLocalStorage<string>();
  private readonly pruning: ReturnType<typeof setInterval>;

  constructor(private readonly options: {
    service: ClankyOperationService;
    createAuthority: (access: ControlAccess) => ControlOperationAuthority;
    approvalUrl: (requestId: string) => string;
    changed: (userId: string, requestId: string) => void;
  }) {
    this.pruning = setInterval(() => this.prune(), 30_000);
    this.pruning.unref();
  }

  withCredential<T>(credentialId: string, invoke: () => T): T {
    return this.actor.run(credentialId, invoke);
  }

  async tools(access: ControlAccess, chatId?: string) {
    const session = this.session(access);
    if (chatId) await requireControlChat(access.grant, chatId);
    return [
      ...controlToolDefinitions.filter(({ name }) => session.authority.general || !GENERAL_TOOLS.has(name)),
      ...(chatId ? controlUiToolDefinitions : []),
    ];
  }

  async call(access: ControlAccess, input: {
    name: string; input: unknown; browser?: ClankyControlContext; signal: AbortSignal;
  }): Promise<unknown> {
    const session = this.session(access);
    if ((!isControlToolName(input.name) && !isControlUiToolName(input.name))
      || GENERAL_TOOLS.has(input.name) && !session.authority.general) {
      throw new DomainError("control_tool_unavailable", "This tool is outside the authorized catalog.");
    }
    if (isControlUiToolName(input.name) && !input.browser?.clientId) {
      throw new DomainError("control_client_unavailable", "This operation needs the real originating browser tab.");
    }
    const origin = await resolveControlOrigin(access.grant, input.browser);
    return await this.start(session, input.signal, input.browser, async () => await executeControlTool({
      service: this.options.service, actions: session.actions, requestId: crypto.randomUUID(),
      name: input.name, input: input.input, origin,
    }));
  }

  getRequest(id: string): ControlRequestSnapshot {
    const request = this.requireRequest(id);
    this.expire(request);
    return structuredClone(request.snapshot);
  }

  listPendingRequests(): ControlRequestSummary[] {
    this.prune();
    const userId = requireCurrentUserId();
    return [...this.requests.values()]
      .filter(({ session, snapshot }) => session.access.grant.user.id === userId && snapshot.status === "pending")
      .map(({ snapshot: { id, kind, status, description, expiresAt, serverName } }) => ({
        id, kind, status, description, expiresAt, ...(serverName ? { serverName } : {}),
      }))
      .sort((left, right) => left.expiresAt - right.expiresAt || left.id.localeCompare(right.id));
  }

  async decide(id: string, approved: boolean, signal: AbortSignal): Promise<unknown> {
    const request = this.requireRequest(id);
    this.requirePending(request, "confirmation");
    await request.session.access.revalidate();
    return await this.start(request.session, signal, request.browser,
      async () => await request.session.actions.confirm(id, approved), request);
  }

  async supplyCredential(id: string, token: string | null): Promise<unknown> {
    const request = this.requireRequest(id);
    this.requirePending(request, "ssh_credential");
    await request.session.access.revalidate();
    this.requirePending(request, "ssh_credential");
    const run = request.run;
    if (!run?.work || run.controller.signal.aborted) {
      throw new DomainError("control_request_unavailable", "The operation that requested the credential has ended.");
    }
    run.pending = Promise.withResolvers<unknown>();
    request.session.actions.supplyCredential(id, token);
    request.snapshot.status = "running";
    clearTimeout(request.timer);
    this.changed(request);
    return await Promise.race([run.work, run.pending.promise]);
  }

  private session(access: ControlAccess): ControlSession {
    if (access.grant.user.id !== requireCurrentUserId()) {
      throw new DomainError("control_actor_mismatch", "The control actor does not match the authenticated user.");
    }
    this.prune();
    const id = access.grant.credentialId;
    let session = this.sessions.get(id);
    const authority = this.options.createAuthority(access);
    if (session) {
      session.authority.refresh(authority);
      session.access = access;
      session.expiresAt = Date.now() + SESSION_TTL_MS;
      return session;
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      authority.release();
      throw new DomainError("control_busy", "Too many control sessions are active.");
    }
    const actions = new ControlActions({
      context: { revision: 0, route: {} }, authority, service: this.options.service,
      confirmationTtlMs: CONFIRMATION_TTL_MS,
      interact: async (action, _requestId, signal) => await this.interact(action, signal),
    });
    session = { access, authority, actions, expiresAt: Date.now() + SESSION_TTL_MS, runs: new Set() };
    this.sessions.set(id, session);
    return session;
  }

  private async start(
    session: ControlSession, callerSignal: AbortSignal, browser: ClankyControlContext | undefined,
    invoke: () => Promise<unknown>, parent?: HumanRequest,
  ): Promise<unknown> {
    if (callerSignal.aborted) throw new DomainError("control_cancelled", "The originating request was cancelled.");
    if (session.runs.size >= MAX_IN_FLIGHT) throw new DomainError("control_busy", "Too many control operations are running.");
    if (parent) {
      this.requirePending(parent, "confirmation");
      parent.snapshot.status = "running";
      parent.removeAt = Date.now() + EXECUTION_TIMEOUT_MS + RESULT_TTL_MS;
      clearTimeout(parent.timer);
      this.changed(parent);
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    const run: ControlRun = {
      controller, browser, pending: Promise.withResolvers<unknown>(), requests: new Set(parent ? [parent.snapshot.id] : []),
      detach: () => callerSignal.removeEventListener("abort", onAbort),
      timer: setTimeout(() => controller.abort(), EXECUTION_TIMEOUT_MS),
    };
    session.runs.add(run);
    callerSignal.addEventListener("abort", onAbort, { once: true });
    if (callerSignal.aborted) onAbort();
    const work = this.withCredential(session.access.grant.credentialId, () => this.invocation.run({ session, run }, async () => await session.actions.withInvocation({
      signal: controller.signal, ...(browser?.clientId ? { clientId: browser.clientId } : {}),
    }, invoke)));
    run.work = work.then(
      (result) => this.finish(session, run, readBytes(result) <= MAX_RESULT_BYTES ? result : {
        ok: false, code: "control_result_too_large", completion: "outcome_unknown",
        message: "The result exceeded the transport bound. Read the affected resource before deciding what to do next.",
      }),
    ).catch((error: unknown) => {
        log[isDomainError(error) ? "warn" : "error"]("Control execution failed", {
          code: isDomainError(error) ? error.code : "unexpected_error",
        });
        return this.finish(session, run, {
          ok: false, code: isDomainError(error) ? error.code : "control_execution_failed",
          message: isDomainError(error) ? error.message : "The operation could not be completed. Inspect its target before retrying.",
          completion: "outcome_unknown",
        });
    });
    return await Promise.race([run.work, run.pending.promise]);
  }

  private finish(session: ControlSession, run: ControlRun, result: unknown): unknown {
    run.detach();
    clearTimeout(run.timer);
    run.controller.abort();
    session.runs.delete(run);
    for (const id of run.requests) {
      const request = this.requests.get(id);
      if (!request) continue;
      if (request.snapshot.kind === "confirmation" && isReadRecord(result)
        && result["code"] === "confirmation_required" && result["requestId"] === id) continue;
      clearTimeout(request.timer);
      if (request.snapshot.status !== "expired") request.snapshot.status = "completed";
      request.snapshot.result = result;
      request.removeAt = Date.now() + RESULT_TTL_MS;
      request.run = undefined;
      this.changed(request);
    }
    return result;
  }

  private async interact(action: ControlUiAction, signal: AbortSignal): Promise<ControlInteractionOutcome> {
    const invocation = this.invocation.getStore();
    if (!invocation) throw new DomainError("control_context_unavailable", "No active control invocation owns this interaction.");
    const { session, run } = invocation;
    if (action.type === "confirm_operation" || action.type === "request_ssh_credential") {
      this.prune();
      if (this.requests.size >= MAX_REQUESTS) throw new DomainError("control_busy", "Too many human requests are awaiting review.");
      const id = action.type === "confirm_operation" ? action.confirmation.requestId : action.requestId;
      const snapshot: ControlRequestSnapshot = action.type === "confirm_operation"
        ? { id, kind: "confirmation", status: "pending", ...session.actions.getConfirmation(id) }
        : { id, kind: "ssh_credential", status: "pending", description: `Supply the private SSH credential for ${action.serverName}.`,
          serverId: action.serverId, serverName: action.serverName, expiresAt: action.expiresAt };
      const request: HumanRequest = {
        session, snapshot, browser: run.browser,
        ...(action.type === "request_ssh_credential" ? { run } : {}),
        removeAt: snapshot.expiresAt + RESULT_TTL_MS,
        timer: setTimeout(() => this.expire(request), Math.max(0, snapshot.expiresAt - Date.now())),
      };
      this.requests.set(id, request);
      run.requests.add(id);
      this.changed(request);
      const url = this.options.approvalUrl(id);
      if (action.type === "request_ssh_credential") {
        // The session owns this bounded wait after returning the private handoff link.
        run.detach();
        run.pending.resolve({
          ok: true, code: "credential_required", completion: "not_executed", requestId: id,
          approvalUrl: url, expiresAt: snapshot.expiresAt,
        });
      }
      return { status: "pending", url };
    }
    const browser = run.browser;
    if (!browser?.clientId) {
      throw new DomainError("control_client_unavailable", "The originating browser tab is unavailable.");
    }
    await requireControlChat(await session.access.revalidate(), browser.chatId);
    return (await controlUiActionService.dispatch({
      ownerId: session.access.grant.user.id, clientId: browser.clientId,
      source: { kind: "chat_turn", chatId: browser.chatId, workspaceId: browser.workspaceId, turnId: browser.turnId }, action,
    }, signal)).outcome;
  }

  private requireRequest(id: string): HumanRequest {
    const request = this.requests.get(id);
    const credentialId = this.actor.getStore();
    if (!request || request.session.access.grant.user.id !== requireCurrentUserId()
      || credentialId && credentialId !== request.session.access.grant.credentialId) {
      throw new DomainError("control_request_unavailable", "The control request is unavailable.");
    }
    return request;
  }

  private requirePending(request: HumanRequest, kind: ControlRequestSnapshot["kind"]): void {
    this.expire(request);
    if (request.snapshot.kind !== kind || request.snapshot.status !== "pending") {
      throw new DomainError("control_request_unavailable", "This request expired or was already consumed.");
    }
  }

  private expire(request: HumanRequest): void {
    if (request.snapshot.status !== "pending" || request.snapshot.expiresAt > Date.now()) return;
    request.snapshot.status = "expired";
    request.session.actions.cancelRequest(request.snapshot.id);
    clearTimeout(request.timer);
    this.changed(request);
  }

  private changed(request: HumanRequest): void {
    this.options.changed(request.session.access.grant.user.id, request.snapshot.id);
  }

  private prune(): void {
    const now = Date.now();
    const waitingSessions = new Set<ControlSession>();
    for (const [id, request] of this.requests) {
      this.expire(request);
      if (request.removeAt <= now) {
        clearTimeout(request.timer);
        this.requests.delete(id);
      } else if (request.snapshot.status === "pending" || request.snapshot.status === "running") {
        waitingSessions.add(request.session);
      }
    }
    for (const [id, session] of this.sessions) {
      if (session.expiresAt > now || waitingSessions.has(session)) continue;
      for (const run of session.runs) { run.detach(); run.controller.abort(); }
      session.actions.dispose();
      session.authority.release();
      this.sessions.delete(id);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.pruning);
    const pending: Promise<unknown>[] = [];
    for (const request of this.requests.values()) clearTimeout(request.timer);
    for (const session of this.sessions.values()) {
      for (const run of session.runs) {
        run.detach(); clearTimeout(run.timer); run.controller.abort();
        if (run.work) pending.push(run.work);
      }
      session.actions.dispose();
      session.authority.release();
    }
    this.requests.clear();
    this.sessions.clear();
    await Promise.all(pending);
  }
}
