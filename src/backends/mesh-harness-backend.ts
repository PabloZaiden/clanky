/**
 * Provider-neutral Mesh host proxy. ACP remains its own ordinary backend path.
 */
import { z } from "zod";
import type { Backend, BackendConnectionConfig, AgentSession, AgentResponse, CreateSessionOptions, ConfigOption, ConnectionInfo, PromptInput } from "./types";
import type { HarnessAdapter } from "@/shared/settings";
import type { MeshPeerRoute } from "@/shared/mesh";
import type { HarnessControl, HarnessCapabilities, HarnessConversationBinding, HarnessActivitySnapshot, HarnessActivityStopResult, HarnessInputAdmission, HarnessSteerRequest, HarnessInputRecoveryRequest, HarnessCleanupResult } from "@/shared/harness-control";
import type { HarnessEvent, ProviderImageFileReference } from "@/shared/harness-events";
import type { HarnessSessionHistory } from "@/shared/harness-history";
import type { ModelInfo } from "@/contracts";
import type { MeshHarnessOperation } from "@/contracts/schemas/mesh-harness";
import { MeshHarnessEventSchema, MeshHarnessSessionHistorySchema, MeshHarnessSubagentHistorySchema } from "@/contracts/schemas/mesh-harness";
import { HarnessConversationBindingSchema, HarnessConversationStateSchema } from "@/contracts/schemas/harness";
import { HarnessUsageSnapshotSchema } from "@/contracts/schemas/harness-usage";
import {
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_IMAGE_ALLOWED_MIME_TYPES,
  type MessageAttachment,
} from "@/shared/message-attachments";
import { MeshCommandExecutorClient } from "../core/mesh-command-executor-client";
import { requestMeshPeer } from "../core/mesh-peer-transport";
import { readMeshPayload, type MeshPayloadFields } from "../core/mesh-payload";
import { MESH_HARNESS_CHANNEL } from "@/shared/mesh-execution";
import { HarnessEventHub } from "./harness-event-hub";
import { HarnessError } from "./harness-errors";
import { DomainError } from "../domain/domain-error";
import type { EventStream } from "../utils/event-stream";
import { requireExecutionOwnerUserId } from "../context/user-context";
import { readMeshControlResponseJson } from "../core/mesh-control-client";
import { requireMatchingHarnessBinding } from "./harness-binding";
import { createLogger } from "@pablozaiden/webapp/server";
import { detectBrowserImageMimeType } from "../utils/workspace-file-images";
import {
  isMeshRelayResponseInterrupted,
  MeshRelayStreamError,
} from "../core/mesh-relay-errors";

const log = createLogger("backend:mesh-harness");
const MAX_PENDING_RESTORED_IMAGE_WARNINGS = 128;
const Capabilities = HarnessConversationStateSchema.shape.capabilities.unwrap();
const Admission = HarnessConversationStateSchema.shape.inputs.unwrap().element.shape.admission;
const Cleanup = HarnessConversationStateSchema.shape.cleanup.unwrap();
const Stop = z.object({ status: z.enum(["stopped", "stopping", "unknown"]), activityId: z.string().min(1) });
const Models = z.array(z.object({
  providerID: z.string(), providerName: z.string(), modelID: z.string(), modelName: z.string(),
  connected: z.boolean(), variants: z.array(z.string()).optional(),
})).max(10_000);
const Session = z.object({
  id: z.string().min(1), binding: HarnessConversationBindingSchema,
  title: z.string().optional(), createdAt: z.string(), model: z.string().optional(),
  configOptions: z.array(z.object({
    id: z.string(), name: z.string(), description: z.string().optional(), category: z.string().optional(),
    type: z.string(), currentValue: z.string(),
    options: z.array(z.object({ value: z.string(), name: z.string(), description: z.string().optional() })),
  })).optional(),
});
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const OBSERVATION_PEER_PROBE_TIMEOUT_MS = 5_000;

export class MeshHarnessBackend implements Backend {
  readonly name: string;
  readonly harness: HarnessControl;
  private client: MeshCommandExecutorClient | null = null;
  private directory = "";
  private capabilities: HarnessCapabilities;
  private readonly hub = new HarnessEventHub();
  private readonly observers = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly requests = new Set<AbortController>();
  private readonly interactions = new Map<string, string>();
  private readonly restoredProviderImageWarnings = new Map<string, Set<string>>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly observationFailures = new Map<string, Error>();
  private readonly deleting = new Set<string>();

  constructor(private readonly options: { adapter: Exclude<HarnessAdapter, "acp">; workspaceId: string; executionNodeId: string }) {
    this.name = `${options.adapter}-mesh`;
    this.capabilities = { adapter: options.adapter, experimental: false, steering: "unsupported", activity: "unavailable", stopScopes: [] };
    const owner = this;
    this.harness = {
      get capabilities(): HarnessCapabilities { return owner.capabilities; },
      getActivity: (id: string) => this.activity(id),
      getUsage: async (id: string) => {
        if (owner.capabilities.usage !== "tokens") {
          throw new HarnessError("harness_unsupported_feature", "Update the Mesh worker to report native token usage.");
        }
        return HarnessUsageSnapshotSchema.parse(await owner.rpc({ operation: "usage", sessionId: id }));
      },
      stopActivity: (id: string, activityId: string) => this.stop(id, activityId),
      steer: (id: string, request: HarnessSteerRequest) => this.inputAdmission({ operation: "steer", sessionId: id, request }),
      reconcileInput: (id: string, request: HarnessInputRecoveryRequest) => this.inputAdmission({ operation: "reconcile", sessionId: id, request }),
      settleOwnedWork: async (id: string): Promise<HarnessCleanupResult> => Cleanup.parse(await this.rpc({ operation: "settle", sessionId: id })),
    };
  }

  async connect(config: BackendConnectionConfig, signal?: AbortSignal): Promise<void> {
    await this.disconnect();
    this.directory = config.directory;
    const client = new MeshCommandExecutorClient({
      ...this.options, directory: config.directory, provider: config.provider ?? "copilot",
      localUserId: requireExecutionOwnerUserId(), channel: MESH_HARNESS_CHANNEL,
      managedEnvironment: config.managedEnvironment,
    });
    this.client = client;
    try {
      await client.openSession(signal);
      this.capabilities = Capabilities.parse(await this.rpc({ operation: "capabilities" }, signal));
      if (this.capabilities.adapter !== this.options.adapter) throw new HarnessError("harness_runtime_unavailable", "The worker returned a different native adapter.");
      client.startSessionRenewal();
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  private connection(): ReturnType<MeshCommandExecutorClient["getSessionConnection"]> {
    if (!this.client) throw new HarnessError("harness_transport_closed", "The native Mesh host is disconnected.");
    return this.client.getSessionConnection();
  }

  private async rpc<T>(operation: MeshHarnessOperation, signal?: AbortSignal): Promise<T> {
    const connection = this.connection();
    const requestId = crypto.randomUUID();
    if (this.requests.size >= 8) throw new HarnessError("harness_input_capacity", "The native Mesh request capacity was reached.");
    const controller = new AbortController();
    this.requests.add(controller);
    const abort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), operation.operation === "prompt" && operation.synchronous ? 30 * 60_000 : 60_000);
    try {
      const response = await requestMeshPeer(connection.route, "api/mesh/internal/harness/rpc", {
        method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json", "x-clanky-mesh-protocol-version": String(connection.protocolVersion), "x-clanky-mesh-session-id": connection.sessionId, "x-clanky-mesh-request-id": requestId },
        body: JSON.stringify({
          protocolVersion: connection.protocolVersion, sessionId: connection.sessionId, sessionToken: connection.sessionToken, requestId,
          payload: operation,
        }),
      });
      await this.assertResponse(response);
      const body = await readMeshControlResponseJson(response, { signal: controller.signal, maxBytes: MAX_FRAME_BYTES }) as MeshPayloadFields & { protocolVersion: unknown; requestId: unknown };
      if (body.protocolVersion !== connection.protocolVersion || body.requestId !== requestId) throw new HarnessError("harness_request_failed", "The native Mesh response does not match its request.");
      return readMeshPayload(body) as T;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new HarnessError("harness_transport_closed", "The native Mesh request could not be completed.", { cause: error });
    } finally {
      clearTimeout(timer); this.requests.delete(controller); signal?.removeEventListener("abort", abort);
    }
  }

  private async assertResponse(response: Response): Promise<void> {
    if (response.ok) return;
    const body = await readMeshControlResponseJson(response, { maxBytes: 16_384 }) as { error?: unknown; message?: unknown };
    const error = typeof body.error === "string" ? body.error : "harness_request_failed";
    const message = typeof body.message === "string" && body.message.length <= 2_000
      ? body.message
      : "The native Mesh host rejected the request.";
    throw new DomainError(error, message, { details: { status: response.status } });
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    if (!options.ownership) throw new HarnessError("harness_session_not_owned", "Native Mesh sessions require Clanky ownership.");
    this.requireQuestionPolicy(options.ownership.questionPolicy);
    const session = Session.parse(await this.rpc({ operation: "create", options: { ...options, ownership: options.ownership } }));
    return await this.adopt(session);
  }
  async resumeSession(binding: HarnessConversationBinding): Promise<AgentSession> {
    this.requireQuestionPolicy(binding.questionPolicy);
    const session = Session.parse(await this.rpc({ operation: "resume", binding }));
    requireMatchingHarnessBinding(JSON.stringify(session.binding), binding);
    return await this.adopt(session);
  }

  private requireQuestionPolicy(policy: HarnessConversationBinding["questionPolicy"]): void {
    if (policy && this.capabilities.questionPolicy !== "session") {
      throw new HarnessError("harness_unsupported_feature", "Update the Mesh worker to support interactive chat and unattended task question policies.");
    }
  }

  async readSessionHistory(id: string, cursor?: string): Promise<HarnessSessionHistory> {
    if (!this.sessions.has(id)) throw new HarnessError("harness_session_not_owned", "The conversation is not owned by this native Mesh proxy.");
    if (this.capabilities.history !== "completed") {
      throw new HarnessError("harness_unsupported_feature", "Update the Mesh worker to support completed native history recovery.");
    }
    const result = await this.rpc({ operation: "history", sessionId: id, cursor });
    const parsed = MeshHarnessSessionHistorySchema.safeParse(result);
    if (!parsed.success) throw new HarnessError("harness_event_gap", "The native Mesh history is incomplete or invalid.", { cause: parsed.error });
    return parsed.data;
  }

  async readSubagentHistory(id: string, activityId: string, cursor?: string) {
    if (!this.sessions.has(id)) throw new HarnessError("harness_session_not_owned", "The conversation is not owned by this native Mesh proxy.");
    if (this.capabilities.subagentHistory !== "completed") {
      throw new HarnessError("harness_unsupported_feature", "Update the Mesh worker to recover subagent transcripts.");
    }
    return MeshHarnessSubagentHistorySchema.parse(await this.rpc({ operation: "subagent-history", sessionId: id, activityId, cursor }));
  }

  private async adopt(session: AgentSession): Promise<AgentSession> {
    this.sessions.set(session.id, session);
    if (this.observers.has(session.id)) return session;
    const controller = new AbortController();
    let ready!: () => void;
    let reject!: (error: unknown) => void;
    const admitted = new Promise<void>((resolve, fail) => { ready = resolve; reject = fail; });
    const timer = setTimeout(() => {
      controller.abort();
      reject(new HarnessError("harness_transport_closed", "Native Mesh observation did not become ready before its deadline."));
    }, 15_000);
    const promise = this.observe(session.id, controller.signal, ready).catch((error: unknown) => {
      reject(error);
      if (!controller.signal.aborted && !this.deleting.has(session.id)) {
        const failure = error instanceof Error ? error : new HarnessError("harness_event_gap", "Native observation was lost.");
        log[failure instanceof DomainError && failure.code === "harness_transport_closed" ? "warn" : "error"]("Native Mesh event observation failed", {
          adapter: this.options.adapter,
          errorType: failure.name,
          message: failure.message,
        });
        for (const id of this.sessions.keys()) {
          this.observationFailures.set(id, failure);
          this.hub.failSession(id, failure);
        }
        for (const pending of this.requests) pending.abort();
        for (const observer of this.observers.values()) observer.controller.abort();
        // Observation loss invalidates the owned lease, never resends an input. Core must
        // reconnect and resume the original durable binding.
        void this.client?.releaseSession().catch(() => {
          // The disconnected transport cannot acknowledge release; the worker
          // still deterministically closes this non-renewing lease at expiry.
        });
      }
    });
    this.observers.set(session.id, { controller, promise });
    try { await admitted; } catch (error) { await this.disconnect(); throw error; }
    finally { clearTimeout(timer); }
    return session;
  }

  private async observe(id: string, signal: AbortSignal, ready: () => void): Promise<void> {
    const connection = this.connection();
    const requestId = crypto.randomUUID();
    const response = await requestMeshPeer(connection.route, "api/mesh/internal/harness/events", {
      method: "POST", signal, headers: {
        "content-type": "application/json", "x-clanky-mesh-protocol-version": String(connection.protocolVersion), "x-clanky-mesh-session-id": connection.sessionId, "x-clanky-mesh-request-id": requestId,
      }, body: JSON.stringify({ protocolVersion: connection.protocolVersion, sessionId: connection.sessionId, sessionToken: connection.sessionToken, requestId, conversationId: id }),
    }).catch(async (error: unknown) => { throw await this.observationTransportError(error, connection.route, signal); });
    await this.assertResponse(response);
    if (!response.body) throw new HarnessError("harness_event_gap", "The native event stream is unavailable.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sequence = 0;
    try {
      while (true) {
        const chunk = await reader.read().catch(async (error: unknown) => { throw await this.observationTransportError(error, connection.route, signal); });
        if (chunk.done) {
          if (buffer.trim()) throw new HarnessError("harness_event_gap", "The native event stream ended with an incomplete frame.");
          throw new HarnessError("harness_transport_closed", "The native event stream ended.");
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) throw new HarnessError("harness_event_gap", "The native event stream exceeds the frame limit.");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const frameText = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!frameText.trim()) {
            continue;
          }
          let frame: MeshPayloadFields & { protocolVersion: unknown; sequence: unknown };
          try {
            frame = JSON.parse(frameText) as typeof frame;
          } catch (error) {
            throw new HarnessError(
              "harness_event_gap",
              `The native Mesh event stream ${requestId} contains invalid JSON at sequence ${String(sequence)}.`,
              { cause: error },
            );
          }
          if (frame.protocolVersion !== connection.protocolVersion || frame.sequence !== sequence++) throw new HarnessError("harness_event_gap", "The native event stream has a sequence gap.");
          const payload = readMeshPayload(frame) as { type: string; event?: unknown };
          if (payload.type === "ready" && sequence === 1) ready();
          else if (payload.type === "heartbeat") { /* Lease-owned keepalive, not a retained event. */ }
          else if (payload.type === "event") {
            let event = MeshHarnessEventSchema.parse(payload.event);
            if (event.type === "error" && event.scope.kind === "principal"
              && (event.code === "harness_event_gap" || event.code === "harness_transport_closed")) {
              throw new HarnessError(event.code, event.message);
            }
            if (event.type === "message.complete" && event.providerImageFile) {
              const { providerImageFile, ...message } = event;
              if (event.attachments?.length) {
                event = message;
              } else {
                const attachment = await this.restoreProviderImageAttachment(providerImageFile, signal);
                if (attachment) {
                  event = { ...message, attachments: [attachment] };
                  const pending = this.restoredProviderImageWarnings.get(id) ?? new Set<string>();
                  if (pending.size < MAX_PENDING_RESTORED_IMAGE_WARNINGS) {
                    pending.add(attachment.id);
                    this.restoredProviderImageWarnings.set(id, pending);
                  }
                } else {
                  event = message;
                  if (message.content.length === 0) continue;
                }
              }
            }
            if (event.type === "request.error" && event.code === "mesh_image_omitted") {
              const attachmentId = event.details?.["attachmentId"];
              const pending = this.restoredProviderImageWarnings.get(id);
              if (typeof attachmentId === "string" && pending?.delete(attachmentId)) {
                if (pending.size === 0) this.restoredProviderImageWarnings.delete(id);
                continue;
              }
            }
            if (event.type === "permission.asked" || event.type === "question.asked") {
              if (this.interactions.size >= 512) throw new HarnessError("harness_event_gap", "The native interaction observation limit was reached.");
              this.interactions.set(event.requestId, id);
            }
            if (event.type === "question.resolved" && this.interactions.get(event.requestId) === id) {
              this.interactions.delete(event.requestId);
            }
            this.hub.publish(id, event);
          } else throw new HarnessError("harness_event_gap", "The native event stream frame is invalid.");
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch (error) {
        log.warn("Unable to cancel the closed native Mesh event reader", { error: String(error) });
      } finally {
        reader.releaseLock();
      }
    }
  }

  private async observationTransportError(error: unknown, route: MeshPeerRoute, signal: AbortSignal): Promise<Error> {
    const disconnected = error instanceof DomainError && [
      "mesh_relay_disconnected", "mesh_relay_unavailable",
    ].includes(error.code) || error instanceof MeshRelayStreamError && (
      ["mesh_relay_disconnected", "mesh_relay_stream_unavailable"].includes(error.code)
      || error.code !== "mesh_relay_dispatch_failed" && isMeshRelayResponseInterrupted(error)
    );
    if (disconnected || route.kind === "direct" && error instanceof TypeError
      && !signal.aborted && await this.isObservationPeerUnavailable(route, signal)) {
      return new HarnessError("harness_transport_closed", "The native Mesh event connection was lost.", { cause: error });
    }
    // HTTP read failures can also be worker integrity failures; neither an
    // unclassified exception nor status 503 alone establishes transport loss.
    return error instanceof Error
      ? error
      : new HarnessError("harness_event_gap", "Native Mesh observation failed.", { cause: error });
  }

  private async isObservationPeerUnavailable(route: MeshPeerRoute, signal: AbortSignal): Promise<boolean> {
    let response: Response;
    try {
      response = await requestMeshPeer(route, "api/health", {
        signal: AbortSignal.any([signal, AbortSignal.timeout(OBSERVATION_PEER_PROBE_TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) return false;
      if (error instanceof DOMException && error.name === "TimeoutError") return true;
      if (error instanceof TypeError && "code" in error && [
        "ConnectionRefused", "ConnectionClosed", "ECONNREFUSED", "ECONNRESET",
        "ETIMEDOUT", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH",
      ].includes(String(error.code))) return true;
      log.warn("Unable to establish native Mesh peer reachability", { error: String(error) });
      return false;
    }
    try {
      await response.body?.cancel();
    } catch (error) {
      log.warn("Unable to cancel the native Mesh health response", { error: String(error) });
    }
    // Any HTTP response proves reachability, not that observation was valid.
    return false;
  }

  private async restoreProviderImageAttachment(
    reference: ProviderImageFileReference,
    signal: AbortSignal,
  ): Promise<MessageAttachment | null> {
    const expected = reference.attachment;
    const client = this.client;
    if (
      !client
      || expected.size <= 0
      || expected.size > MESSAGE_ATTACHMENT_MAX_BYTES
      || !(MESSAGE_IMAGE_ALLOWED_MIME_TYPES as readonly string[]).includes(expected.mimeType)
    ) {
      return null;
    }

    try {
      const metadata = await client.getFileMetadata(reference.path, { signal });
      if (metadata?.kind !== "file" || metadata.size !== expected.size) return null;
      const stream = await client.streamFile(reference.path, signal);
      if (!stream) return null;

      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let streamEnded = false;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) {
            streamEnded = true;
            break;
          }
          size += result.value.byteLength;
          if (size > expected.size || size > MESSAGE_ATTACHMENT_MAX_BYTES) return null;
          chunks.push(result.value);
        }
      } finally {
        if (!streamEnded) await reader.cancel();
        reader.releaseLock();
      }
      if (size !== expected.size) return null;

      const bytes = Buffer.concat(chunks, size);
      const mimeType = detectBrowserImageMimeType(bytes);
      if (
        mimeType !== expected.mimeType
        || !(MESSAGE_IMAGE_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)
      ) {
        return null;
      }
      return { ...expected, data: bytes.toString("base64") };
    } catch (error) {
      if (signal.aborted) throw error;
      log.warn("Could not restore a provider-generated Mesh image", {
        adapter: this.options.adapter,
        code: error instanceof DomainError ? error.code : "mesh_execution_unreachable",
      });
      return null;
    }
  }

  private async activity(id: string): Promise<HarnessActivitySnapshot> {
    const failure = this.observationFailures.get(id);
    if (failure) return {
      observation: "unavailable",
      reason: failure instanceof DomainError && failure.code === "harness_transport_closed" ? "disconnected" : "gap",
    };
    if (!this.isConnected()) return { observation: "unavailable", reason: "disconnected" };
    return HarnessConversationStateSchema.shape.activity.unwrap().parse(await this.rpc({ operation: "activity", sessionId: id }));
  }
  private async stop(id: string, activityId: string): Promise<HarnessActivityStopResult> {
    const result = Stop.parse(await this.rpc({ operation: "stop", sessionId: id, activityId }));
    if (result.activityId !== activityId) throw new HarnessError("harness_activity_not_owned", "The worker returned a different activity.");
    return result;
  }
  private async inputAdmission(operation: Extract<MeshHarnessOperation, { operation: "steer" | "reconcile" }>): Promise<HarnessInputAdmission> {
    const inputId = operation.request.inputId;
    try {
      const result = Admission.safeParse(await this.rpc(operation));
      if (!result.success || result.data.inputId !== inputId) {
        log.warn("Native Mesh input receipt is unavailable", { operation: operation.operation, code: "harness_input_unresolved" });
        return { status: "unknown", inputId };
      }
      return result.data;
    }
    catch (error) {
      if (error instanceof DomainError && (
        ["harness_transport_closed", "harness_request_failed", "mesh_execution_unreachable", "mesh_execution_session_invalid", "mesh_execution_context_changed"].includes(error.code)
        || (typeof error.details?.["status"] === "number" && error.details["status"] >= 500)
      )) {
        return { status: "unknown", inputId };
      }
      throw error;
    }
  }
  async sendPrompt(id: string, prompt: PromptInput): Promise<AgentResponse> { return await this.rpc({ operation: "prompt", sessionId: id, prompt, synchronous: true }); }
  async sendPromptAsync(id: string, prompt: PromptInput): Promise<void> { await this.rpc({ operation: "prompt", sessionId: id, prompt }); }
  async abortSession(id: string): Promise<void> { await this.rpc({ operation: "abort", sessionId: id }); }
  async subscribeToEvents(id: string): Promise<EventStream<HarnessEvent>> {
    const failure = this.observationFailures.get(id);
    if (failure) throw failure;
    if (!this.sessions.has(id)) throw new HarnessError("harness_event_gap", "Refresh or resume the owned conversation before observing it.");
    return this.hub.subscribe(id);
  }
  async replyToPermission(requestId: string, response: string): Promise<void> {
    await this.rpc({ operation: "permission", sessionId: this.interaction(requestId), requestId, response }); this.interactions.delete(requestId);
  }
  async replyToQuestion(requestId: string, answers: string[][]): Promise<void> {
    await this.rpc({ operation: "question", sessionId: this.interaction(requestId), requestId, answers }); this.interactions.delete(requestId);
  }
  private interaction(id: string): string {
    const session = this.interactions.get(id);
    if (!session) throw new HarnessError("harness_session_not_owned", "The interaction is not owned by this proxy.");
    return session;
  }
  async setConfigOption(id: string, configId: string, value: string): Promise<ConfigOption[]> { return Session.shape.configOptions.unwrap().parse(await this.rpc({ operation: "config", sessionId: id, configId, value })); }
  async setSessionModel(id: string, modelId: string): Promise<void> { await this.rpc({ operation: "model", sessionId: id, modelId }); }
  async getSession(id: string): Promise<AgentSession | null> { return Session.nullable().parse(await this.rpc({ operation: "get", sessionId: id })); }
  async deleteSession(id: string): Promise<void> {
    this.deleting.add(id);
    try { await this.rpc({ operation: "delete", sessionId: id }); }
    catch (error) { this.deleting.delete(id); throw error; }
    this.observers.get(id)?.controller.abort(); await this.observers.get(id)?.promise;
    this.observers.delete(id); this.sessions.delete(id); this.observationFailures.delete(id); this.deleting.delete(id); this.hub.closeSession(id);
    this.restoredProviderImageWarnings.delete(id);
  }
  async getModels(directory: string): Promise<ModelInfo[]> { return Models.parse(await this.rpc({ operation: "models", directory })); }
  async getModelVariants(directory: string, modelId: string): Promise<string[]> { return z.array(z.string()).max(1000).parse(await this.rpc({ operation: "variants", directory, modelId })); }
  isConnected(): boolean { try { this.connection(); return this.observationFailures.size === 0; } catch { return false; } }
  abortAllSubscriptions(reason?: Error): void { this.hub.closeAll(reason); }
  getSdkClient(): unknown { return null; }
  getDirectory(): string { return this.directory; }
  getConnectionInfo(): ConnectionInfo | null { return null; }
  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.hub.closeAll();
    for (const controller of this.requests) controller.abort();
    for (const observer of this.observers.values()) observer.controller.abort();
    await Promise.all([...this.observers.values()].map((observer) => observer.promise));
    this.observers.clear(); this.sessions.clear(); this.interactions.clear(); this.restoredProviderImageWarnings.clear(); this.observationFailures.clear(); this.deleting.clear();
    await client?.releaseSession();
  }
}
