/**
 * Authorized local composition and bounded resolution of spoken references.
 */
import type { ClankyOperationService } from "./clanky-operation-service";
import type { LiveVoiceActions, ConfirmationContinuation, ConfirmedWriteExecutor } from "./live-voice-actions";
import { compactResource, isReadRecord, readBytes } from "../client-sdk/collaboration/resource-read";
import { DomainError } from "../domain/domain-error";
import { ExecutionHostRefSchema } from "@/contracts/schemas/execution-host";
import { getExecutionHostSourceId } from "@/shared/execution-host";

export function directRecord(value: unknown): Record<string, unknown> {
  if (!isReadRecord(value)) throw new DomainError("voice_operation_response", "The operation returned an invalid object.");
  return value;
}

export function directItems(value: unknown): Record<string, unknown>[] {
  const page = directRecord(value);
  if (!Array.isArray(page["items"]) || !page["items"].every(isReadRecord)) {
    throw new DomainError("voice_operation_response", "The operation returned an invalid collection.");
  }
  return page["items"];
}

export class LiveVoiceDirectContext {
  constructor(readonly options: {
    service: ClankyOperationService; actions: LiveVoiceActions; requestId: string; maxBytes: number;
  }) {}

  async execute(input: {
    operationId: string; parameters?: Record<string, string>; query?: Record<string, string | number>;
    body?: unknown; confirmationDescription?: string | null; maxBytes?: number;
    afterConfirmed?: ConfirmationContinuation;
  }, executeWrite?: ConfirmedWriteExecutor): Promise<unknown> {
    const operation = {
      operationId: input.operationId,
      parameters: Object.entries(input.parameters ?? {}).map(([name, value]) => ({ name, value })),
      query: Object.entries(input.query ?? {}).map(([name, value]) => ({ name, value: String(value) })),
      bodyJson: input.body === undefined ? null : JSON.stringify(input.body),
    };
    if (executeWrite) return await executeWrite(operation, input.maxBytes ?? this.options.maxBytes);
    return await this.options.actions.execute(operation, {
      requestId: this.options.requestId, confirmationDescription: input.confirmationDescription ?? null,
      maxBytes: input.maxBytes ?? this.options.maxBytes,
      ...(input.afterConfirmed ? { afterConfirmed: input.afterConfirmed } : {}),
    });
  }

  async read(input: Parameters<LiveVoiceDirectContext["execute"]>[0]): Promise<unknown> {
    const result = directRecord(await this.execute(input));
    if (result["ok"] !== true) {
      throw new DomainError("voice_direct_read_failed", "Required authorized data could not be read.", {
        details: { operationId: input.operationId, code: result["code"], status: result["status"] },
      });
    }
    return result["data"];
  }

  async readExact(operationId: string, parameters: Record<string, string> = {}, options: {
    query?: Record<string, string>; body?: unknown;
  } = {}): Promise<unknown> {
    const result = await this.options.actions.read({
      operationId, parameters: Object.entries(parameters).map(([name, value]) => ({ name, value })),
      query: Object.entries(options.query ?? {}).map(([name, value]) => ({ name, value })),
      bodyJson: options.body === undefined ? null : JSON.stringify(options.body),
    }, this.options.requestId);
    if (!result.ok) throw new DomainError("voice_direct_read_failed", "Required authorized preparation could not be read.", {
      details: { operationId, code: result.code, status: result.status },
    });
    return result.data;
  }

  async collect(operationId: string, query: Record<string, string | number> = {}): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 100; pages++) {
      const page = directRecord(await this.read({
        operationId, query: { ...query, limit: 100, ...(cursor ? { cursor } : {}) }, maxBytes: 16_384,
      }));
      items.push(...directItems(page));
      if (page["nextCursor"] === null) return items;
      if (typeof page["nextCursor"] !== "string" || page["nextCursor"] === cursor) {
        throw new DomainError("voice_operation_response", "The collection has an invalid continuation.");
      }
      cursor = page["nextCursor"];
    }
    throw new DomainError("voice_target_lookup_limit", "Narrow the target by ID or workspace; the lookup exceeded its bound.");
  }

  private choose(items: Record<string, unknown>[], target: string): Record<string, unknown> {
    const matches = items.filter((item) => item["id"] === target
      || typeof item["name"] === "string" && item["name"].toLocaleLowerCase() === target.toLocaleLowerCase());
    if (matches.length === 1) return matches[0]!;
    throw new DomainError(matches.length ? "voice_target_ambiguous" : "voice_target_not_found",
      matches.length ? "Choose the target by workspace or ID; this name is ambiguous." : "The named target is unavailable.", {
        details: { candidates: matches.slice(0, 8).map(({ id, name, workspaceId }) => ({ id, name, workspaceId })) },
      });
  }

  async uiContext() {
    const outcome = await this.options.actions.getUiState(this.options.requestId);
    if (outcome.status !== "context") throw new DomainError("voice_client_context_unavailable", "The originating client context could not be acknowledged.");
    return outcome.context;
  }

  async resolve(kind: "chat" | "task" | "workspace" | "server", target: string, workspace: string | null = null): Promise<Record<string, unknown>> {
    const paths = { chat: "chats", task: "tasks", workspace: "workspaces", server: "ssh-servers" } as const;
    if (target === "current") {
      if (kind === "server") {
        const ref = ExecutionHostRefSchema.parse((await this.host(target))["ref"]);
        if (ref.kind !== "ssh" || !("serverId" in ref)) {
          throw new DomainError("voice_target_not_found", "The originating client has no selected standalone SSH server.");
        }
        target = ref.serverId;
      } else {
        const context = await this.uiContext();
        const id = context.route[`${kind}Id`];
        if (!id) throw new DomainError("voice_target_not_found", "The originating client has no selected target of that kind.");
        target = id;
      }
    }
    const workspaceId = workspace ? String((await this.resolve("workspace", workspace))["id"]) : undefined;
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(target)) {
      const operationId = `GET /api/${paths[kind]}/:id`;
      const item = directRecord(kind === "server"
        ? compactResource(await this.readExact(operationId, { id: target }))
        : await this.read({ operationId, parameters: { id: target } }));
      if (workspaceId && item["workspaceId"] !== workspaceId) throw new DomainError("voice_target_not_found", "The target is not in the selected workspace.");
      return item;
    }
    const items = await this.collect(`GET /api/${paths[kind]}`, {
      ...(workspaceId ? { workspaceId } : {}),
      ...(["chat", "task"].includes(kind) ? { name: target } : {}),
    });
    return this.choose(items, target);
  }

  async host(target: string): Promise<Record<string, unknown>> {
    const selected = target === "current" ? (await this.uiContext()).route : null;
    if (selected && (selected["view"] !== "execution-host" || !selected["hostKind"] || !selected["hostId"])) {
      throw new DomainError("voice_target_not_found", "The originating client has no selected execution host.");
    }
    const source = await this.readExact("GET /api/execution-hosts");
    if (!Array.isArray(source)) throw new DomainError("voice_operation_response", "The execution hosts are unavailable.");
    const items = source.map((value: unknown) => {
      const item = directRecord(value);
      const ref = ExecutionHostRefSchema.parse(item["ref"]);
      return { ...item, ref, id: getExecutionHostSourceId(ref) };
    });
    if (selected) return this.choose(items.filter((item) =>
      item.ref.kind === selected["hostKind"] && item.id === selected["hostId"]), selected["hostId"]!);
    const kind = items.filter((item) => item.ref.kind === target);
    return this.choose(kind.length === 1 ? [{ ...kind[0]!, name: target }] : items, target);
  }

  bounded(value: unknown): unknown {
    if (readBytes(value) <= this.options.maxBytes) return value;
    throw new DomainError("voice_direct_result_too_large", "Request fewer items or a targeted section; this combined result exceeds its budget.");
  }
}
