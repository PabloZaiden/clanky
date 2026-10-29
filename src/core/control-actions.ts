/**
 * Ordered control execution, frozen approvals and private credential handoffs.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ControlUiAction, ControlUiActionOutcome } from "@/shared/clanky-control";
import type { ExecuteOperationInput } from "@/contracts/schemas/control";
import { ControlConfirmationDescriptionSchema, type ControlClientContext } from "@/shared/control-interactions";
import { sshCredentialManager } from "./ssh-credential-manager";
import { sshServerManager } from "./ssh-server-manager";
import { ExecutionHostRefSchema } from "@/contracts/schemas/execution-host";
import { getExecutionHostSourceId } from "@/shared/execution-host";
import { resolveControlCredentialTargets } from "./control-credential-targets";
import {
  type ClankyOperationService, type OperationAuthority,
  type OperationResult, type PreparedOperation,
} from "./clanky-operation-service";
import { DomainError } from "../domain/domain-error";

const PENDING_TTL_MS = 60_000;
const MAX_PENDING = 16;

export type ConfirmedWriteExecutor = (input: ExecuteOperationInput, maxBytes?: number) => Promise<OperationResult>;
export type ConfirmationContinuation = (result: OperationResult, executeWrite: ConfirmedWriteExecutor) => Promise<OperationResult>;
export type ControlInteractionOutcome = ControlUiActionOutcome | { status: "pending"; url: string };

interface PendingConfirmation {
  operation: PreparedOperation;
  description: string;
  revision: string | null;
  credentialRevision: string;
  expiresAt: number;
  afterConfirmed?: ConfirmationContinuation;
}
interface PendingCredential {
  serverId: string;
  expiresAt: number;
  resolve: (token: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ControlActions {
  private readonly controller = new AbortController();
  private readonly invocation = new AsyncLocalStorage<{ signal: AbortSignal; clientId?: string }>();
  private mutationTail: Promise<unknown> = Promise.resolve();
  private readonly confirmations = new Map<string, PendingConfirmation>();
  private readonly credentials = new Map<string, PendingCredential>();
  private context: ControlClientContext;

  constructor(private readonly options: {
    clientId?: string;
    context: ControlClientContext;
    authority: OperationAuthority;
    service: ClankyOperationService;
    confirmationTtlMs?: number;
    requiresConfirmation?: () => Promise<boolean>;
    notify?: (content: string) => void;
    remember?: (operation: PreparedOperation, result: OperationResult) => void;
    interact: (action: ControlUiAction, requestId: string, signal: AbortSignal) => Promise<ControlInteractionOutcome>;
  }) { this.context = options.context; }

  get signal(): AbortSignal { return this.invocation.getStore()?.signal ?? this.controller.signal; }
  private get clientId(): string | undefined { return this.invocation.getStore()?.clientId ?? this.options.clientId; }
  get authority(): OperationAuthority { return this.options.authority; }
  get uiContext(): ControlClientContext { return this.context; }

  async withInvocation<T>(
    context: { signal: AbortSignal; clientId?: string },
    invoke: () => Promise<T>,
  ): Promise<T> {
    return await this.invocation.run({
      ...context, signal: AbortSignal.any([this.controller.signal, context.signal]),
    }, invoke);
  }

  getConfirmation(requestId: string): {
    description: string; expiresAt: number; operation: PreparedOperation;
  } {
    this.prune();
    const pending = this.confirmations.get(requestId);
    if (!pending || this.controller.signal.aborted) {
      throw new DomainError("control_request_unavailable", "The confirmation expired or was already consumed.");
    }
    return {
      description: pending.description, expiresAt: pending.expiresAt,
      operation: pending.operation,
    };
  }

  updateContext(context: ControlClientContext): void {
    if (context.revision > this.context.revision) this.context = context;
  }

  private async dispatch(action: ControlUiAction, requestId: string): Promise<ControlInteractionOutcome> {
    return await this.options.interact(action, requestId, this.signal);
  }

  async getUiState(requestId: string) {
    const outcome = await this.dispatch({ type: "get_context" }, requestId);
    if (outcome.status === "context") this.updateContext(outcome.context);
    return outcome;
  }

  async uiAction(action: ControlUiAction, requestId: string) {
    await this.authorizeTarget(action);
    return await this.dispatch(action, requestId);
  }

  private async authorizeTarget(action: ControlUiAction): Promise<void> {
    let operationId: string | undefined;
    let id: string | undefined;
    switch (action.type) {
      case "open_workspace":
      case "open_workspace_file": operationId = "GET /api/workspaces/:id"; id = action.workspaceId; break;
      case "open_chat": operationId = "GET /api/chats/:id"; id = action.chatId; break;
      case "open_task": operationId = "GET /api/tasks/:id"; id = action.taskId; break;
      case "open_agent": operationId = "GET /api/agents/:id"; id = action.agentId; break;
      case "open_terminal": operationId = "GET /api/terminal-sessions/:id"; id = action.terminalSessionId; break;
      case "open_ssh_server": operationId = "GET /api/ssh-servers/:id"; id = action.serverId; break;
      case "open_execution_host": {
        const read = this.options.service.prepare(this.authority, { operationId: "GET /api/execution-hosts", parameters: [], query: [], bodyJson: null });
        const result = await this.options.service.execute(this.authority, read, { signal: this.signal, clientId: this.clientId });
        const hosts = Array.isArray(result.data) ? result.data : [];
        if (!result.ok || !hosts.some((host: unknown) => {
          if (!host || typeof host !== "object" || !("ref" in host)) return false;
          const parsed = ExecutionHostRefSchema.safeParse(host.ref);
          return parsed.success && parsed.data.kind === action.kind && getExecutionHostSourceId(parsed.data) === action.id;
        })) throw new DomainError("voice_operation_target", "The execution host is unavailable.");
        return;
      }
      default: return;
    }
    const prepared = this.options.service.prepare(this.authority, {
      operationId, parameters: [{ name: "id", value: id! }], query: [], bodyJson: null,
    });
    const result = await this.options.service.execute(this.authority, prepared, { signal: this.signal, clientId: this.clientId });
    if (!result.ok) throw new DomainError("voice_operation_target", "The requested UI target is unavailable.");
  }

  async execute(input: ExecuteOperationInput, options: {
    requestId: string; confirmationDescription: string | null; maxBytes?: number;
    afterConfirmed?: ConfirmationContinuation;
  }): Promise<OperationResult | Record<string, unknown>> {
    const { requestId, confirmationDescription, maxBytes } = options;
    const prepared = this.options.service.prepare(this.authority, input, { bounded: true, maxBytes });
    await this.authority.validate?.(prepared, this.signal);
    if (prepared.metadata.automation!.policy === "read") return await this.perform(prepared, requestId);
    return await this.serial(async () => {
      if (prepared.metadata.automation!.policy !== "confirm") return await this.perform(prepared, requestId);
      if (this.options.requiresConfirmation && !await this.options.requiresConfirmation()) {
        return await this.performWithContinuation(prepared, requestId, options.afterConfirmed);
      }
      if (confirmationDescription === null) {
        throw new DomainError("voice_confirmation_description_required", "Supply a short description of this action, its named target and consequences in the user's language.");
      }
      const description = ControlConfirmationDescriptionSchema.parse(confirmationDescription);
      this.prune();
      if (this.confirmations.size >= MAX_PENDING) throw new DomainError("voice_live_busy", "Too many actions are awaiting confirmation.");
      const id = crypto.randomUUID();
      const revision = await this.options.service.targetRevision(this.authority, prepared, this.signal);
      const expiresAt = Date.now() + (this.options.confirmationTtlMs ?? PENDING_TTL_MS);
      const credentials = await resolveControlCredentialTargets(prepared);
      const argumentsSize = JSON.stringify({ parameters: input.parameters, query: input.query, body: prepared.body ?? null }, null, 2).length;
      if (argumentsSize > 40_000) throw new DomainError("voice_operation_invalid", "The arguments exceed the confirmation limit. Request a smaller operation.");
      const pending = {
        operation: prepared, description, revision, credentialRevision: credentials.revision, expiresAt,
        ...(options.afterConfirmed ? { afterConfirmed: options.afterConfirmed } : {}),
      };
      this.confirmations.set(id, pending);
      const outcome = await this.dispatch({
        type: "confirm_operation",
        confirmation: {
          requestId: id, description: pending.description, expiresAt,
        },
      }, requestId);
      if (outcome.status !== "presented" && outcome.status !== "pending") {
        this.confirmations.delete(id);
        return { ok: false, completion: "not_executed", outcome };
      }
      return {
        ok: true, completion: "not_executed", code: "confirmation_required", requestId: id, expiresAt,
        ...(outcome.status === "pending" ? { approvalUrl: outcome.url } : {}),
      };
    });
  }

  async confirm(requestId: string, approved: boolean): Promise<OperationResult | Record<string, unknown>> {
    this.prune();
    const pending = this.confirmations.get(requestId);
    if (!pending || this.signal.aborted) throw new DomainError("voice_confirmation_not_found", "The confirmation expired or was already consumed.");
    this.confirmations.delete(requestId);
    if (!approved) {
      this.options.remember?.(pending.operation, {
        ok: true, operationId: pending.operation.id, code: "confirmation_rejected", completion: "not_executed",
      });
      this.options.notify?.("The user rejected the pending operation. No operation was executed.");
      return { ok: true, code: "confirmation_rejected", completion: "not_executed" };
    }
    const result = await this.serial<OperationResult>(async () => {
      await this.authority.validate?.(pending.operation, this.signal);
      const revision = await this.options.service.targetRevision(this.authority, pending.operation, this.signal);
      const credentials = await resolveControlCredentialTargets(pending.operation);
      if (revision !== pending.revision || credentials.revision !== pending.credentialRevision) {
        this.options.remember?.(pending.operation, {
          ok: false, operationId: pending.operation.id, code: "confirmation_target_changed", completion: "not_executed",
        });
        return { ok: false, operationId: pending.operation.id, code: "confirmation_target_changed", completion: "not_executed",
          message: "The target changed since the dialog opened. Read it again and request a new confirmation." };
      }
      return await this.performWithContinuation(pending.operation, requestId, pending.afterConfirmed);
    });
    this.options.notify?.(`Visual confirmation result (authoritative data): ${JSON.stringify(result)}`);
    return result;
  }

  async read(input: ExecuteOperationInput, requestId: string): Promise<OperationResult> {
    const prepared = this.options.service.prepare(this.authority, input);
    if (prepared.metadata.automation!.policy !== "read") {
      throw new DomainError("voice_operation_invalid", "Internal preparation may only read authorized data.");
    }
    return await this.perform(prepared, requestId);
  }

  private async performWithContinuation(
    operation: PreparedOperation, requestId: string, continuation?: ConfirmationContinuation,
  ): Promise<OperationResult> {
    const created = await this.perform(operation, requestId);
    if (!created.ok || !continuation) return created;
    return await continuation(created, async (input, maxBytes) => {
      const prepared = this.options.service.prepare(this.authority, input, { bounded: true, maxBytes });
      if (prepared.metadata.automation!.policy !== "write") {
        throw new DomainError("voice_operation_invalid", "Follow-on stages may only execute ordinary write operations.");
      }
      // The continuation owns this queue slot; re-entering execute() would deadlock.
      return await this.perform(prepared, requestId);
    });
  }

  private async perform(prepared: PreparedOperation, requestId: string): Promise<OperationResult> {
    if (this.signal.aborted) throw new DomainError("voice_live_not_found", "The call has ended.");
    await this.authority.validate?.(prepared, this.signal);
    const credential = prepared.metadata.automation!.credential;
    let credentialToken: string | null = null;
    const credentialTokens: Record<string, string> = {};
    const unavailableServerIds: string[] = [];
    if (credential) {
      const targets = await resolveControlCredentialTargets(prepared);
      for (const serverId of targets.serverIds) {
        const token = await this.requestCredential(serverId, requestId);
        if (token) { credentialTokens[serverId] = token; credentialToken = token; }
        else unavailableServerIds.push(serverId);
      }
      if (!credential.mapInput && unavailableServerIds.length) {
        return { ok: false, operationId: prepared.id, completion: "not_executed",
          code: "ssh_credential_required", message: "Supply the SSH credential in this browser, then request the operation again." };
      }
      if ((await resolveControlCredentialTargets(prepared)).revision !== targets.revision) {
        return { ok: false, operationId: prepared.id, completion: "not_executed",
          code: "voice_credential_target_changed", message: "The execution binding changed during credential handoff. Read it again before requesting the operation." };
      }
    }
    const result = await this.options.service.execute(this.authority, prepared, {
      signal: this.signal, clientId: this.clientId, credentialToken, credentialTokens, unavailableServerIds,
    });
    this.options.remember?.(prepared, result);
    return result;
  }

  private async requestCredential(serverId: string, requestId: string): Promise<string | null> {
    const server = await sshServerManager.getServer(serverId);
    if (!server) throw new DomainError("ssh_server_not_found", "The SSH server is unavailable.");
    this.prune();
    if (this.credentials.size >= MAX_PENDING) throw new DomainError("voice_live_busy", "Too many credential handoffs are pending.");
    const id = crypto.randomUUID();
    const ready = Promise.withResolvers<string | null>();
    const timer = setTimeout(() => this.finishCredential(id, null), PENDING_TTL_MS);
    this.credentials.set(id, { serverId, expiresAt: Date.now() + PENDING_TTL_MS, resolve: ready.resolve, timer });
    try {
      const outcome = await this.dispatch({ type: "request_ssh_credential", requestId: id, serverId,
        serverName: server.config.name.slice(0, 500), expiresAt: Date.now() + PENDING_TTL_MS }, requestId);
      if (outcome.status !== "presented" && outcome.status !== "pending") this.finishCredential(id, null);
      const onAbort = () => this.finishCredential(id, null);
      this.signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (this.signal.aborted) onAbort();
        return await ready.promise;
      } finally { this.signal.removeEventListener("abort", onAbort); }
    } finally { this.finishCredential(id, null); }
  }

  supplyCredential(requestId: string, token: string | null): void {
    this.prune();
    const pending = this.credentials.get(requestId);
    if (!pending || this.signal.aborted) throw new DomainError("voice_credential_not_found", "The credential request expired.");
    if (token) sshCredentialManager.getPasswordForToken(pending.serverId, token);
    this.finishCredential(requestId, token);
  }

  cancelRequest(requestId: string): void {
    this.confirmations.delete(requestId);
    this.finishCredential(requestId, null);
  }

  private finishCredential(id: string, token: string | null): void {
    const pending = this.credentials.get(id);
    if (!pending) return;
    this.credentials.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(token);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.mutationTail;
    const ready = Promise.withResolvers<void>();
    this.mutationTail = ready.promise;
    try {
      await predecessor;
      if (this.signal.aborted) throw new DomainError("voice_live_not_found", "The call has ended.");
      return await operation();
    } finally { ready.resolve(); }
  }

  private prune(): void {
    for (const [id, pending] of this.confirmations) if (pending.expiresAt <= Date.now()) this.confirmations.delete(id);
    for (const [id, pending] of this.credentials) if (pending.expiresAt <= Date.now()) this.finishCredential(id, null);
  }

  dispose(): void {
    this.controller.abort();
    this.confirmations.clear();
    for (const id of this.credentials.keys()) this.finishCredential(id, null);
  }
}
