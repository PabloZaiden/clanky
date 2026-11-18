/**
 * Hosts own backends; conversations own lifetime subscriptions.
 * Retained hosts outlive attachment leases and prompt boundaries.
 */
import { createLogger } from "@pablozaiden/webapp/server";
import type { Backend, AgentSession } from "../backends/types";
import { createLocalHarnessBackend } from "../backends/harness-factory";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import type { HarnessActivitySnapshot } from "@/shared/harness-control";
import type { HarnessEvent } from "@/shared/harness-events";
import type { MeshHarnessOperation } from "@/contracts/schemas/mesh-harness";
import { MeshHarnessSessionHistorySchema, MeshHarnessSubagentHistorySchema } from "@/contracts/schemas/mesh-harness";
import { meshExecutionGateway, type MeshExecutionGateway } from "./mesh-execution-gateway";
import { meshInboundResourceRegistry } from "./mesh-inbound-resource-registry";
import { DomainError } from "../domain/domain-error";
import { createHarnessObservationError, getHarnessObservationDetails } from "../backends/harness-observation-errors";
import { requireMatchingHarnessBinding } from "../backends/harness-binding";
import { saveMeshHarnessConversation, requireMeshHarnessConversation, deleteMeshHarnessConversation } from "../persistence/mesh-harness-conversations";
import type { EventStream } from "../utils/event-stream";
import { createEventStream } from "../utils/event-stream";
import { MeshControlToolChannel } from "./mesh-control-tool-transport";
import { legacyMeshControlConnection } from "./mesh-control-v1-adapter";
import type { MeshHarnessControlEvent } from "@/contracts/schemas/mesh-harness";
import { MeshHarnessBacklog } from "./mesh-harness-backlog";
import { createHash } from "node:crypto";

const log = createLogger("core:mesh-harness-gateway");
const MAX_HOSTS = 64;
const MAX_CONVERSATIONS = 64;
const MAX_SUBSCRIBERS = 8;

interface Conversation {
  binding: HarnessConversationBinding;
  source: EventStream<HarnessEvent>;
  pump: Promise<void>;
  subscribers: Set<ReturnType<typeof createEventStream<HarnessEvent>>>;
  interactions: Map<string, HarnessEvent>;
  completedInteractions: Map<string, string>;
  resolvedQuestions: Map<string, "answered" | "cancelled" | "expired">;
  backlog?: MeshHarnessBacklog;
  observationFailed: boolean;
  closing: boolean;
}
interface Host {
  id: string;
  backend: Backend;
  config: Awaited<ReturnType<MeshExecutionGateway["getHarnessSessionConfig"]>>;
  conversations: Map<string, Conversation>;
  controller: AbortController;
  inFlight: number;
  key: string;
  detached: boolean;
}

export class MeshHarnessGateway {
  private readonly hosts = new Map<string, Host>();
  private readonly opening = new Map<string, { controller: AbortController; promise: Promise<Host> }>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly controls = new Map<string, MeshControlToolChannel>();
  private readonly retained = new Map<string, Host>();
  private readonly leaseKeys = new Map<string, string>();
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly released = new Set<string>();

  constructor(private readonly leases: MeshExecutionGateway = meshExecutionGateway) {
    leases.onSessionClosed((id) => {
      this.released.delete(id);
      void this.detach(id).catch((error: unknown) => {
        log.error("Native Mesh lease cleanup failed", { sessionId: id, code: error instanceof DomainError ? error.code : "harness_cleanup_failed" });
      });
    });
    leases.onCallerClosed(async (callerNodeId) => {
      const results = await Promise.allSettled([...new Set(this.hosts.values())]
        .filter((host) => host.config.callerNodeId === callerNodeId)
        .map((host) => this.close(host.id)));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Revoked native runtimes could not be completely closed.");
    });
  }

  private key(config: Host["config"], id: string): string {
    return config.continuity
      ? JSON.stringify([config.callerNodeId, config.workspaceId, config.ownerId, config.adapter, config.continuity.contextId])
      : id;
  }

  private attachRetained(id: string, config: Host["config"]): Host | undefined {
    const key = this.key(config, id);
    const retained = this.retained.get(key);
    if (retained) {
      const binding = config.continuity?.binding;
      if (binding) {
        requireMeshHarnessConversation(config, binding);
        const conversation = retained.conversations.get(binding.nativeId);
        if (!conversation) throw new DomainError("harness_session_not_owned", "The retained execution has a different native conversation.");
        requireMatchingHarnessBinding(JSON.stringify(conversation.binding), binding);
      } else if (retained.conversations.size) {
        throw new DomainError("harness_session_not_owned", "A live remote execution requires its original conversation binding.");
      }
      if (retained.id !== id) {
        const previous = retained.id;
        this.hosts.delete(previous);
        this.leaseKeys.delete(previous);
        this.leases.closeSession(previous);
      }
      retained.id = id;
      retained.config = config;
      retained.detached = false;
      this.hosts.set(id, retained);
      this.leaseKeys.set(id, key);
      return retained;
    }
  }

  private async host(id: string, token: string, signal?: AbortSignal): Promise<Host> {
    const config = await this.leases.getHarnessSessionConfig(id, token);
    if (signal?.aborted) throw new DomainError("harness_connection_aborted", "The native host request was aborted.");
    const current = this.hosts.get(id);
    if (current) return current;
    const key = this.key(config, id);
    await this.retiring.get(key);
    const retained = this.attachRetained(id, config);
    if (retained) return retained;
    this.leaseKeys.set(id, key);
    const pending = this.opening.get(id);
    if (pending) return await pending.promise;
    if (this.hosts.size + this.opening.size >= MAX_HOSTS) throw new DomainError("harness_runtime_unavailable", "The native Mesh host is at capacity.");
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const backend = createLocalHarnessBackend(config.adapter);
    const promise = (async (): Promise<Host> => {
      try {
        const control = config.controlTools ? this.controls.get(key)?.connection
          : config.legacyControlCredential ? legacyMeshControlConnection(config.callerNodeId, config.legacyControlCredential) : undefined;
        if (config.controlTools && !control) {
          throw new DomainError("control_unavailable", "The execution control channel must be ready before provider connection.");
        }
        await backend.connect({
          directory: config.directory,
          env: config.environment, managedEnvironment: config.environment,
          control,
        }, controller.signal);
        await this.leases.getHarnessSessionConfig(id, token);
        if (controller.signal.aborted) throw new DomainError("harness_connection_aborted", "The native host connection was aborted.");
        const host: Host = { id, key, backend, config, conversations: new Map(), controller, inFlight: 0, detached: false };
        this.hosts.set(id, host);
        if (config.continuity) this.retained.set(key, host);
        return host;
      } catch (error) {
        await backend.disconnect();
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        this.opening.delete(id);
      }
    })();
    this.opening.set(id, { controller, promise });
    return await promise;
  }

  private nativeBinding(host: Host, binding: HarnessConversationBinding): HarnessConversationBinding {
    if (
      binding.adapter !== host.config.adapter || binding.ownerId !== host.config.ownerId
      || binding.directory !== host.config.bindingDirectory
      || host.config.continuity && binding.contextId !== host.config.continuity.contextId
    ) throw new DomainError("harness_session_not_owned", "The native conversation does not match this Mesh lease.");
    if (binding.executionHost && (
      binding.executionHost.host.kind !== "mesh"
      || binding.executionHost.host.nodeId !== host.config.executionNodeId
      || ("scope" in binding.executionHost.host && binding.executionHost.host.scope === "workspace" && binding.executionHost.host.workspaceId !== host.config.workspaceId)
    )) throw new DomainError("harness_session_not_owned", "The native conversation execution host does not match the Mesh workspace.");
    if (binding.controlTools && (!(host.config.controlTools || host.config.legacyControlCredential) || host.backend.harness.capabilities.clankyControlTools !== true)) {
      throw new DomainError("harness_unsupported_feature", "The native Mesh worker does not support Clanky control tools.");
    }
    if (binding.secretFiles === 1 && host.backend.harness.capabilities.secretFiles !== 1) {
      throw new DomainError("harness_unsupported_feature", "The native Mesh worker does not support private secret files.");
    }
    return {
      ...binding,
      directory: host.config.directory,
      ownerId: JSON.stringify([host.config.callerNodeId, binding.ownerId]),
      contextId: JSON.stringify([host.config.workspaceId, binding.contextId]),
    };
  }

  private async adopt(host: Host, session: AgentSession, expected: HarnessConversationBinding): Promise<AgentSession> {
    if (host.controller.signal.aborted) throw new DomainError("harness_transport_closed", "The native Mesh host closed during admission.");
    if (!session.binding || session.id !== expected.nativeId) throw new DomainError("harness_session_not_owned", "The native runtime did not preserve the conversation binding.");
    requireMatchingHarnessBinding(JSON.stringify(session.binding), this.nativeBinding(host, expected));
    if (host.conversations.has(session.id)) return { ...session, binding: expected };
    if (host.conversations.size >= MAX_CONVERSATIONS) throw new DomainError("harness_input_capacity", "The native host conversation limit was reached.");
    const source = await host.backend.subscribeToEvents(session.id);
    if (host.controller.signal.aborted) { source.close(); throw new DomainError("harness_transport_closed", "The native Mesh host closed during observation admission."); }
    const conversation: Conversation = {
      binding: expected, source, pump: Promise.resolve(), subscribers: new Set(),
      interactions: new Map(), completedInteractions: new Map(), resolvedQuestions: new Map(),
      ...(host.config.continuity ? { backlog: new MeshHarnessBacklog(host.config.executionNodeId) } : {}),
      observationFailed: false, closing: false,
    };
    host.conversations.set(session.id, conversation);
    conversation.pump = this.observe(host, conversation);
    return { ...session, binding: expected };
  }

  private async observe(host: Host, conversation: Conversation): Promise<void> {
    let stage: "source" | "encode" | "validate" | "forward" = "source";
    let lastEventType: HarnessEvent["type"] | undefined;
    try {
      while (true) {
        stage = "source";
        const event = await conversation.source.next();
        if (!event) break;
        lastEventType = event.type;
        stage = "encode";
        let eventForForwarding: HarnessEvent = event;
        if (event.type === "message.complete" && event.providerImageFile) {
          const { providerImageFile: _providerImageFile, ...eventWithoutFileReference } = event;
          eventForForwarding = eventWithoutFileReference;
        }
        stage = "validate";
        if (event.type === "permission.asked" || event.type === "question.asked") {
          if (conversation.interactions.size >= 512) throw new DomainError("harness_input_capacity", "The native interaction limit was reached.", {
            details: { reason: "interaction_capacity_exceeded", pendingOperations: conversation.interactions.size, limitOperations: 512 },
          });
          conversation.interactions.set(event.requestId, event);
        }
        if (event.type === "question.resolved") {
          conversation.interactions.delete(event.requestId);
          conversation.resolvedQuestions.set(event.requestId, event.outcome);
        }
        stage = "forward";
        if (conversation.backlog) conversation.backlog.append(eventForForwarding);
        for (const subscriber of conversation.subscribers) subscriber.push(eventForForwarding);
      }
      if (!host.controller.signal.aborted && !conversation.closing) throw new DomainError("harness_transport_closed", "The native event source closed.");
    } catch (error) {
      if (!host.controller.signal.aborted && !conversation.closing) {
        conversation.observationFailed = true;
        const failure = error instanceof DomainError ? error : createHarnessObservationError(
          stage === "source" ? "native_source_failed" : "unknown", {}, error,
        );
        conversation.backlog?.fail(failure);
        for (const subscriber of conversation.subscribers) subscriber.fail(failure);
        log[failure.code === "harness_transport_closed" ? "warn" : "error"]("Native Mesh observation ended", {
          adapter: host.config.adapter,
          leaseSessionId: host.id,
          conversationId: conversation.binding.nativeId,
          contextId: conversation.binding.contextId,
          stage,
          lastEventType,
          code: failure.code,
          ...getHarnessObservationDetails(failure),
        });
        void this.close(host.id).catch((cleanupError: unknown) => {
          log.error("Failed to close a failed retained native runtime", { code: cleanupError instanceof DomainError ? cleanupError.code : "harness_cleanup_failed" });
        });
        this.leases.closeSession(host.id);
      }
    } finally {
      for (const subscriber of conversation.subscribers) subscriber.end();
      conversation.subscribers.clear();
    }
  }

  async execute(id: string, token: string, operation: MeshHarnessOperation, signal?: AbortSignal): Promise<unknown> {
    if (operation.operation === "control.result" || operation.operation === "control.dispatch") {
      const config = await this.leases.getHarnessSessionConfig(id, token);
      if (!config.controlTools) throw new DomainError("control_scope_required", "This execution lease has no control channel.");
      const key = this.key(config, id);
      if (this.leaseKeys.get(id) !== key) throw new DomainError("control_unavailable", "The execution control channel has not been attached.");
      const control = this.controls.get(key);
      if (!control) throw new DomainError("control_unavailable", "The execution control channel is unavailable.");
      if (operation.operation === "control.dispatch") {
        if (!config.continuity) throw new DomainError("harness_unsupported_feature", "Retained control dispatch was not negotiated.");
        control.dispatch(operation.controlRequestId);
        return null;
      }
      return control.reply(operation.controlRequestId, operation.reply);
    }
    const host = await this.host(id, token, signal);
    if (host.inFlight >= 8) throw new DomainError("harness_input_capacity", "The native request capacity was reached.");
    host.inFlight++;
    try { return await this.executeHost(host, operation); } finally {
      host.inFlight--;
      if (host.detached && !host.inFlight) {
        host.detached = false;
        await this.detach(host.id);
      }
    }
  }

  private async executeHost(host: Host, operation: Exclude<MeshHarnessOperation, { operation: "control.result" | "control.dispatch" }>): Promise<unknown> {
    const backend = host.backend;
    if (operation.operation === "release") {
      if (!host.config.continuity) throw new DomainError("harness_unsupported_feature", "Retained remote execution was not negotiated.");
      this.released.add(host.id);
      await this.close(host.id);
      return null;
    }
    if (operation.operation === "capabilities") return backend.harness.capabilities;
    if (operation.operation === "models" || operation.operation === "variants") {
      if (operation.directory !== host.config.bindingDirectory) throw new DomainError("harness_session_not_owned", "The catalog directory does not match this lease.");
      return operation.operation === "models" ? await backend.getModels(host.config.directory)
        : await backend.getModelVariants?.(host.config.directory, operation.modelId) ?? [];
    }
    if (operation.operation === "create") {
      if (host.conversations.size >= MAX_CONVERSATIONS) throw new DomainError("harness_input_capacity", "The native host conversation limit was reached.");
      const canonical = { ...operation.options.ownership, directory: operation.options.directory, adapter: host.config.adapter, nativeId: "" };
      const native = this.nativeBinding(host, canonical);
      const session = await backend.createSession({
        ...operation.options,
        directory: host.config.directory,
        ownership: {
          ownerId: native.ownerId,
          contextId: native.contextId,
          executionHost: native.executionHost,
          questionPolicy: native.questionPolicy,
          secretFiles: native.secretFiles,
          ...(native.controlTools ? {
            controlTools: true,
            controlChatId: native.controlChatId,
          } : {}),
        },
      });
      const binding = {
        ...canonical, nativeId: session.id,
        ...(session.binding?.htmlArtifacts === 1 ? { htmlArtifacts: 1 as const } : {}),
      };
      try {
        const adopted = await this.adopt(host, session, binding);
        saveMeshHarnessConversation(host.config, binding);
        return adopted;
      } catch (error) {
        if (!session.binding || host.controller.signal.aborted) {
          this.leases.closeSession(host.id); await this.close(host.id); throw error;
        }
        try { requireMatchingHarnessBinding(JSON.stringify(session.binding), this.nativeBinding(host, binding)); }
        catch {
          // Never delete a returned ID whose ownership could not be proved.
          this.leases.closeSession(host.id); await this.close(host.id); throw error;
        }
        const conversation = host.conversations.get(session.id);
        if (conversation) conversation.closing = true;
        try { await backend.deleteSession(session.id); }
        catch (cleanupError) {
          this.leases.closeSession(host.id); await this.close(host.id);
          throw new DomainError("harness_request_failed", "Native session admission cleanup failed.", { cause: cleanupError });
        }
        if (conversation) {
          conversation.source.close();
          await conversation.pump;
          host.conversations.delete(session.id);
        }
        throw error;
      }
    }
    if (operation.operation === "resume") {
      const native = this.nativeBinding(host, operation.binding);
      requireMeshHarnessConversation(host.config, operation.binding);
      try {
        if (host.config.continuity && host.conversations.has(operation.binding.nativeId)) {
          const conversation = host.conversations.get(operation.binding.nativeId)!;
          requireMatchingHarnessBinding(JSON.stringify(conversation.binding), operation.binding);
          const session = await backend.getSession(operation.binding.nativeId);
          if (!session) throw new DomainError("harness_session_not_found", "The retained native conversation is unavailable.");
          return { ...session, binding: conversation.binding, continuity: "live" };
        }
        const session = await backend.resumeSession(native);
        const adopted = await this.adopt(host, session, operation.binding);
        return host.config.continuity ? { ...adopted, continuity: "cold" } : adopted;
      } catch (error) {
        const code = error instanceof DomainError ? error.code : undefined;
        const context = {
          adapter: host.config.adapter,
          nativeId: operation.binding.nativeId,
          ...(code ? { code } : {}),
          errorType: error instanceof Error ? error.name : typeof error,
        };
        if (code === "harness_session_not_found") {
          log.warn("Native Mesh session could not be resumed", context);
        } else {
          log.error("Native Mesh session resume failed", context);
        }
        throw error;
      }
    }
    const conversation = host.conversations.get(operation.sessionId);
    if (!conversation) throw new DomainError("harness_session_not_owned", "The conversation is not owned by this native Mesh lease.");
    switch (operation.operation) {
      case "get": {
        const session = await backend.getSession(operation.sessionId);
        return session ? { ...session, binding: conversation.binding } : null;
      }
      case "delete": {
        conversation.closing = true;
        try { await backend.deleteSession(operation.sessionId); }
        catch (error) { conversation.closing = false; throw error; }
        deleteMeshHarnessConversation(host.config, conversation.binding);
        conversation.source.close();
        conversation.backlog?.close();
        await conversation.pump;
        host.conversations.delete(operation.sessionId);
        return null;
      }
      case "prompt": return operation.synchronous
        ? await backend.sendPrompt(operation.sessionId, operation.prompt)
        : await backend.sendPromptAsync(operation.sessionId, operation.prompt) ?? null;
      case "abort": await backend.abortSession(operation.sessionId); return null;
      case "activity": return await this.activity(host, conversation, operation.sessionId);
      case "ack":
        if (!conversation.backlog) throw new DomainError("harness_unsupported_feature", "Remote event acknowledgement was not negotiated.");
        conversation.backlog.acknowledge(operation.executionId, operation.sequence);
        return null;
      case "interactions":
        if (!conversation.backlog) throw new DomainError("harness_unsupported_feature", "Remote interaction recovery was not negotiated.");
        return {
          ...conversation.backlog.position,
          pending: [...conversation.interactions.values()],
          resolvedQuestions: Object.fromEntries(conversation.resolvedQuestions),
        };
      case "usage": {
        if (backend.harness.capabilities.usage !== "tokens" || !backend.harness.getUsage) {
          throw new DomainError("harness_unsupported_feature", "This native worker does not report token usage.");
        }
        return await backend.harness.getUsage(operation.sessionId);
      }
      case "history": {
        if (!backend.readSessionHistory || backend.harness.capabilities.history !== "completed") {
          throw new DomainError("harness_unsupported_feature", "This native worker does not support completed history recovery.");
        }
        const history = MeshHarnessSessionHistorySchema.safeParse(await backend.readSessionHistory(operation.sessionId, operation.cursor));
        if (!history.success) throw new DomainError("harness_event_gap", "Native history is incomplete or exceeds the recovery limit.", { cause: history.error });
        return history.data;
      }
      case "subagent-history": {
        if (!backend.readSubagentHistory || backend.harness.capabilities.subagentHistory !== "completed") {
          throw new DomainError("harness_unsupported_feature", "This native worker does not recover subagent history.");
        }
        const history = MeshHarnessSubagentHistorySchema.safeParse(
          await backend.readSubagentHistory(operation.sessionId, operation.activityId, operation.cursor),
        );
        if (!history.success) throw new DomainError("harness_event_gap", "Native child history is incomplete or exceeds the recovery limit.", { cause: history.error });
        if (history.data.events.some((event) => event.scope.kind !== "child" || event.scope.activityId !== operation.activityId)) {
          throw new DomainError("harness_event_gap", "Native child history does not match the requested activity.");
        }
        return history.data;
      }
      case "stop": return await backend.harness.stopActivity(operation.sessionId, operation.activityId);
      case "settle": return await backend.harness.settleOwnedWork(operation.sessionId);
      case "steer": return await backend.harness.steer(operation.sessionId, operation.request);
      case "reconcile": return await backend.harness.reconcileInput(operation.sessionId, operation.request);
      case "config": return await backend.setConfigOption(operation.sessionId, operation.configId, operation.value);
      case "model": await backend.setSessionModel(operation.sessionId, operation.modelId); return null;
      case "permission":
      case "question":
      case "secret.reply":
        {
        const receipt = createHash("sha256").update(JSON.stringify(operation)).digest("hex");
        const completed = conversation.completedInteractions.get(operation.requestId);
        if (completed) {
          if (completed !== receipt) throw new DomainError("harness_request_failed", "The interaction already received a different response.");
          return null;
        }
        if (!conversation.interactions.has(operation.requestId)) throw new DomainError("harness_session_not_owned", "The interaction belongs to a different conversation.");
        if (operation.operation === "permission") await backend.replyToPermission(operation.requestId, operation.response);
        else if (operation.operation === "question") await backend.replyToQuestion(operation.requestId, operation.answers);
        else {
          if (!backend.replyToSecret || backend.harness.capabilities.secretFiles !== 1) {
            throw new DomainError("harness_unsupported_feature", "The native worker does not support private secret files.");
          }
          await backend.replyToSecret(operation.requestId, operation.value);
        }
        conversation.interactions.delete(operation.requestId);
        conversation.completedInteractions.set(operation.requestId, receipt);
        if (operation.operation !== "permission") conversation.resolvedQuestions.set(operation.requestId, "answered");
        return null;
        }
    }
  }

  private async activity(host: Host, conversation: Conversation, id: string): Promise<HarnessActivitySnapshot> {
    if (conversation.observationFailed) return { observation: "unavailable", reason: "gap" };
    try { return await host.backend.harness.getActivity(id); }
    catch (error) {
      if (!(error instanceof DomainError) || !["harness_request_failed", "harness_transport_closed", "harness_session_not_found", "harness_event_gap"].includes(error.code)) throw error;
      log.warn("Native Mesh inventory is unavailable", { adapter: host.config.adapter, code: error.code });
      return { observation: "unavailable", reason: error.code === "harness_transport_closed" ? "disconnected" : "gap" };
    }
  }

  async subscribe(id: string, token: string, conversationId: string): Promise<EventStream<HarnessEvent>> {
    const host = await this.host(id, token);
    const conversation = host.conversations.get(conversationId);
    if (!conversation) throw new DomainError("harness_session_not_owned", "The conversation is not owned by this Mesh lease.");
    if (conversation.observationFailed) throw new DomainError("harness_event_gap", "Refresh the owned native conversation after an observation gap.");
    if (conversation.backlog) return conversation.backlog.subscribe();
    if (conversation.subscribers.size >= MAX_SUBSCRIBERS) throw new DomainError("harness_input_capacity", "The native observation subscriber limit was reached.");
    const producer = createEventStream<HarnessEvent>({ overflow: "fail" });
    conversation.subscribers.add(producer);
    return { next: () => producer.stream.next(), close: () => {
      producer.stream.close(); conversation.subscribers.delete(producer);
    } };
  }

  async subscribeControl(id: string, token: string): Promise<EventStream<MeshHarnessControlEvent>> {
    const config = await this.leases.getHarnessSessionConfig(id, token);
    if (!config.controlTools) throw new DomainError("control_scope_required", "This execution lease has no control channel.");
    this.leases.getSessionProtocolVersion(id, token);
    const key = this.key(config, id);
    await this.retiring.get(key);
    this.attachRetained(id, config);
    this.leaseKeys.set(id, key);
    if (this.controls.has(key)) {
      if (!config.continuity) throw new DomainError("control_busy", "The execution control channel is already observed.");
      return this.controls.get(key)!.events;
    }
    if (this.controls.size >= MAX_HOSTS) throw new DomainError("control_busy", "The execution control channel capacity was reached.");
    const control = new MeshControlToolChannel(config.continuity !== undefined);
    this.controls.set(key, control);
    return control.events;
  }

  async close(id: string): Promise<void> {
    const stopping = this.stopping.get(id);
    if (stopping) return await stopping;
    const key = this.hosts.get(id)?.key ?? this.leaseKeys.get(id) ?? id;
    this.leaseKeys.delete(id);
    this.controls.get(key)?.close();
    this.controls.delete(key);
    const opening = this.opening.get(id);
    opening?.controller.abort();
    const host = this.hosts.get(id);
    this.hosts.delete(id);
    if (host) this.retained.delete(host.key);
    const cleanup = (async (): Promise<void> => {
      if (opening) await opening.promise.catch((error: unknown) => {
        if (!(error instanceof DomainError) && !opening.controller.signal.aborted) throw error;
      });
      const owned = host ?? this.hosts.get(id);
      this.hosts.delete(id);
      if (!owned) return;
      this.retained.delete(owned.key);
      owned.controller.abort();
      const errors: unknown[] = [];
      for (const conversation of owned.conversations.values()) {
        conversation.source.close();
        try { conversation.backlog?.close(); } catch (error) { errors.push(error); }
        for (const subscriber of conversation.subscribers) subscriber.end();
      }
      try { await owned.backend.disconnect(); } catch (error) { errors.push(error); }
      await Promise.all([...owned.conversations.values()].map((conversation) => conversation.pump));
      owned.conversations.clear();
      if (errors.length) throw new AggregateError(errors, "The native Mesh runtime could not be completely cleaned up.");
    })();
    this.stopping.set(id, cleanup);
    this.retiring.set(key, cleanup);
    try { await cleanup; } finally {
      this.stopping.delete(id);
      if (this.retiring.get(key) === cleanup) this.retiring.delete(key);
    }
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...new Set([...this.hosts.keys(), ...this.opening.keys(), ...this.stopping.keys()])].map((id) => this.close(id)));
    for (const control of this.controls.values()) control.close();
    this.controls.clear();
    this.released.clear();
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Native Mesh runtime shutdown was incomplete.");
  }

  /** Attachment cleanup must not select terminal cleanup for retained execution. */
  async detach(id: string): Promise<void> {
    const host = this.hosts.get(id);
    if (!host?.config.continuity) { await this.close(id); return; }
    if (host.detached) return;
    host.detached = true;
    this.controls.get(host.key)?.detach();
    try {
      for (const conversation of host.conversations.values()) conversation.backlog?.detach();
    } catch (error) {
      await this.close(id);
      throw error;
    }
    if (host.inFlight) return;
    if (this.controls.get(host.key)?.hasPending) return;
    for (const conversation of host.conversations.values()) {
      if (conversation.interactions.size || conversation.backlog?.hasPending) return;
      try {
        const activity = await host.backend.harness.getActivity(conversation.binding.nativeId);
        if (activity.observation === "unavailable" || activity.principalProcessing
          || activity.activities.some((activity) => !["stopped", "completed", "failed", "idle"].includes(activity.status))) return;
      } catch (error) {
        log.warn("Retaining remote execution because activity could not be established", {
          conversationId: conversation.binding.nativeId, error: String(error),
        });
        return;
      }
    }
    // Activity reads yield; new output or requests must prevent retirement.
    if (host.inFlight || this.controls.get(host.key)?.hasPending) return;
    for (const conversation of host.conversations.values()) {
      if (conversation.interactions.size || conversation.backlog?.hasPending) return;
    }
    if (host.id === id && host.detached) await this.close(id);
  }

  observationTransportClosed(id: string, conversationId: string): void {
    const conversation = this.hosts.get(id)?.conversations.get(conversationId);
    if (conversation && !conversation.closing) this.leases.closeSession(id);
  }

  controlTransportClosed(id: string): void {
    if (!this.released.has(id)) this.leases.closeSession(id);
  }
}

export const meshHarnessGateway = new MeshHarnessGateway();
meshInboundResourceRegistry.register({
  id: "native-harness", capabilities: ["commandExecution"],
  close: () => meshHarnessGateway.closeAll(),
});
