/**
 * Native execution-host ownership. Leases own backends; conversations own
 * lifetime subscriptions. No prompt boundary tears down observation.
 */
import { createLogger } from "@pablozaiden/webapp/server";
import type { Backend, AgentSession } from "../backends/types";
import { createLocalHarnessBackend } from "../backends/harness-factory";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import type { HarnessActivitySnapshot } from "@/shared/harness-control";
import type { HarnessEvent } from "@/shared/harness-events";
import type { MeshHarnessOperation } from "@/contracts/schemas/mesh-harness";
import { meshExecutionGateway, type MeshExecutionGateway } from "./mesh-execution-gateway";
import { meshInboundResourceRegistry } from "./mesh-inbound-resource-registry";
import { DomainError } from "../domain/domain-error";
import { requireMatchingHarnessBinding } from "../backends/harness-binding";
import { saveMeshHarnessConversation, requireMeshHarnessConversation, deleteMeshHarnessConversation } from "../persistence/mesh-harness-conversations";
import type { EventStream } from "../utils/event-stream";
import { createEventStream } from "../utils/event-stream";

const log = createLogger("core:mesh-harness-gateway");
const MAX_HOSTS = 64;
const MAX_CONVERSATIONS = 64;
const MAX_SUBSCRIBERS = 8;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;

interface Conversation {
  binding: HarnessConversationBinding;
  source: EventStream<HarnessEvent>;
  pump: Promise<void>;
  subscribers: Set<ReturnType<typeof createEventStream<HarnessEvent>>>;
  interactions: Set<string>;
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
}

export class MeshHarnessGateway {
  private readonly hosts = new Map<string, Host>();
  private readonly opening = new Map<string, { controller: AbortController; promise: Promise<Host> }>();
  private readonly stopping = new Map<string, Promise<void>>();

  constructor(private readonly leases: MeshExecutionGateway = meshExecutionGateway) {
    leases.onSessionClosed((id) => {
      void this.close(id).catch((error: unknown) => {
        log.error("Native Mesh lease cleanup failed", { sessionId: id, code: error instanceof DomainError ? error.code : "harness_cleanup_failed" });
      });
    });
  }

  private async host(id: string, token: string, signal?: AbortSignal): Promise<Host> {
    const config = await this.leases.getHarnessSessionConfig(id, token);
    if (signal?.aborted) throw new DomainError("harness_connection_aborted", "The native host request was aborted.");
    const current = this.hosts.get(id);
    if (current) return current;
    const pending = this.opening.get(id);
    if (pending) return await pending.promise;
    if (this.hosts.size + this.opening.size >= MAX_HOSTS) throw new DomainError("harness_runtime_unavailable", "The native Mesh host is at capacity.");
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const backend = createLocalHarnessBackend(config.adapter);
    const promise = (async (): Promise<Host> => {
      try {
        await backend.connect({
          directory: config.directory, transport: "stdio",
          env: config.environment, managedEnvironment: config.environment,
        }, controller.signal);
        await this.leases.getHarnessSessionConfig(id, token);
        if (controller.signal.aborted) throw new DomainError("harness_connection_aborted", "The native host connection was aborted.");
        const host: Host = { id, backend, config, conversations: new Map(), controller, inFlight: 0 };
        this.hosts.set(id, host);
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
    ) throw new DomainError("harness_session_not_owned", "The native conversation does not match this Mesh lease.");
    if (binding.executionHost && (
      binding.executionHost.host.kind !== "mesh"
      || binding.executionHost.host.nodeId !== host.config.executionNodeId
      || ("scope" in binding.executionHost.host && binding.executionHost.host.scope === "workspace" && binding.executionHost.host.workspaceId !== host.config.workspaceId)
    )) throw new DomainError("harness_session_not_owned", "The native conversation execution host does not match the Mesh workspace.");
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
      binding: expected, source, pump: Promise.resolve(), subscribers: new Set(), interactions: new Set(), observationFailed: false, closing: false,
    };
    host.conversations.set(session.id, conversation);
    conversation.pump = this.observe(host, conversation);
    return { ...session, binding: expected };
  }

  private async observe(host: Host, conversation: Conversation): Promise<void> {
    try {
      for (let event = await conversation.source.next(); event; event = await conversation.source.next()) {
        if (Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) throw new DomainError("harness_event_gap", "The native event exceeds the stream limit.");
        if (event.type === "permission.asked" || event.type === "question.asked") {
          if (conversation.interactions.size >= 512) throw new DomainError("harness_input_capacity", "The native interaction limit was reached.");
          conversation.interactions.add(event.requestId);
        }
        for (const subscriber of conversation.subscribers) subscriber.push(event);
      }
      if (!host.controller.signal.aborted && !conversation.closing) throw new DomainError("harness_transport_closed", "The native event source closed.");
    } catch (error) {
      if (!host.controller.signal.aborted && !conversation.closing) {
        conversation.observationFailed = true;
        const failure = error instanceof DomainError ? error : new DomainError("harness_event_gap", "Native observation is unavailable.", { cause: error });
        for (const subscriber of conversation.subscribers) subscriber.fail(failure);
        log.warn("Native Mesh observation ended", { adapter: host.config.adapter, code: failure.code });
        this.leases.closeSession(host.id);
      }
    } finally {
      for (const subscriber of conversation.subscribers) subscriber.end();
      conversation.subscribers.clear();
    }
  }

  async execute(id: string, token: string, operation: MeshHarnessOperation, signal?: AbortSignal): Promise<unknown> {
    const host = await this.host(id, token, signal);
    if (host.inFlight >= 8) throw new DomainError("harness_input_capacity", "The native request capacity was reached.");
    host.inFlight++;
    try { return await this.executeHost(host, operation); } finally { host.inFlight--; }
  }

  private async executeHost(host: Host, operation: MeshHarnessOperation): Promise<unknown> {
    const backend = host.backend;
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
        ownership: { ownerId: native.ownerId, contextId: native.contextId, executionHost: native.executionHost, questionPolicy: native.questionPolicy },
      });
      const binding = { ...canonical, nativeId: session.id };
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
      const session = await backend.resumeSession(native);
      return await this.adopt(host, session, operation.binding);
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
        await conversation.pump;
        host.conversations.delete(operation.sessionId);
        return null;
      }
      case "prompt": return operation.synchronous
        ? await backend.sendPrompt(operation.sessionId, operation.prompt)
        : await backend.sendPromptAsync(operation.sessionId, operation.prompt) ?? null;
      case "abort": await backend.abortSession(operation.sessionId); return null;
      case "activity": return await this.activity(host, conversation, operation.sessionId);
      case "stop": return await backend.harness.stopActivity(operation.sessionId, operation.activityId);
      case "settle": return await backend.harness.settleOwnedWork(operation.sessionId);
      case "steer": return await backend.harness.steer(operation.sessionId, operation.request);
      case "reconcile": return await backend.harness.reconcileInput(operation.sessionId, operation.request);
      case "config": return await backend.setConfigOption(operation.sessionId, operation.configId, operation.value);
      case "model": await backend.setSessionModel(operation.sessionId, operation.modelId); return null;
      case "permission":
      case "question":
        if (!conversation.interactions.has(operation.requestId)) throw new DomainError("harness_session_not_owned", "The interaction belongs to a different conversation.");
        if (operation.operation === "permission") await backend.replyToPermission(operation.requestId, operation.response);
        else await backend.replyToQuestion(operation.requestId, operation.answers);
        conversation.interactions.delete(operation.requestId);
        return null;
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
    if (conversation.subscribers.size >= MAX_SUBSCRIBERS) throw new DomainError("harness_input_capacity", "The native observation subscriber limit was reached.");
    const producer = createEventStream<HarnessEvent>({ overflow: "fail", maxBufferSize: 256 });
    conversation.subscribers.add(producer);
    return { next: () => producer.stream.next(), close: () => {
      producer.stream.close(); conversation.subscribers.delete(producer);
    } };
  }

  async close(id: string): Promise<void> {
    const stopping = this.stopping.get(id);
    if (stopping) return await stopping;
    const opening = this.opening.get(id);
    opening?.controller.abort();
    const host = this.hosts.get(id);
    this.hosts.delete(id);
    const cleanup = (async (): Promise<void> => {
      if (opening) await opening.promise.catch((error: unknown) => {
        if (!(error instanceof DomainError) && !opening.controller.signal.aborted) throw error;
      });
      const owned = host ?? this.hosts.get(id);
      this.hosts.delete(id);
      if (!owned) return;
      owned.controller.abort();
      for (const conversation of owned.conversations.values()) {
        conversation.source.close();
        for (const subscriber of conversation.subscribers) subscriber.end();
      }
      await owned.backend.disconnect();
      await Promise.all([...owned.conversations.values()].map((conversation) => conversation.pump));
      owned.conversations.clear();
    })();
    this.stopping.set(id, cleanup);
    try { await cleanup; } finally { this.stopping.delete(id); }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...new Set([...this.hosts.keys(), ...this.opening.keys(), ...this.stopping.keys()])].map((id) => this.close(id)));
  }

  observationTransportClosed(id: string, conversationId: string): void {
    const conversation = this.hosts.get(id)?.conversations.get(conversationId);
    if (conversation && !conversation.closing) this.leases.closeSession(id);
  }
}

export const meshHarnessGateway = new MeshHarnessGateway();
meshInboundResourceRegistry.register({
  id: "native-harness", capabilities: ["commandExecution"],
  close: () => meshHarnessGateway.closeAll(),
});
