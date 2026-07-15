/**
 * ACP backend facade for the Clanky Tasks Management System.
 *
 * `AcpBackend` implements the public {@link Backend} contract by composing
 * focused, single-responsibility collaborators with strictly one-way
 * dependencies:
 *
 * - {@link AcpTransportLifecycle} owns the subprocess, readers, and shutdown.
 * - {@link RpcClient} owns JSON-RPC request bookkeeping and dispatch.
 * - {@link SessionStateStore} is the single owner of per-session/run state.
 * - {@link SessionService} owns session CRUD and prompt orchestration.
 * - {@link AcpEventTranslator} owns ACP event translation.
 * - {@link SubscriptionService} owns event-stream/subscription lifecycle.
 * - {@link PermissionCoordinator} owns permission/question coordination.
 * - {@link CapabilityService} owns model discovery and provider adaptation.
 *
 * The facade only wires collaborators, orchestrates connection-level teardown,
 * routes inbound notifications, and preserves the public delegation surface.
 * It owns no protocol maps, process handles, or per-session state of its own.
 */

import { log } from "../../core/logger";
import type { ModelInfo } from "@/contracts";

import type {
  AgentEvent,
  AgentResponse,
  AgentSession,
  Backend,
  BackendConnectionConfig,
  ConfigOption,
  ConnectionInfo,
  CreateSessionOptions,
  ImportSessionOptions,
  ImportSessionResult,
  ImportableSession,
  PromptInput,
} from "../types";
import type { EventStream } from "../../utils/event-stream";

import { isRecord } from "./json-helpers";
import { AcpError } from "./errors";
import type { JsonRpcMessage } from "./types";

import { AcpTransportLifecycle } from "./transport-lifecycle";
import { RpcClient } from "./rpc-client";
import { SessionStateStore } from "./session-state";
import { CapabilityService } from "./capability-service";
import { AcpEventTranslator } from "./event-translator";
import { SubscriptionService } from "./subscription-service";
import { PermissionCoordinator } from "./permission-coordinator";
import { SessionService } from "./session-service";

export class AcpBackend implements Backend {
  readonly name = "acp";

  private readonly state: SessionStateStore;
  private readonly lifecycle: AcpTransportLifecycle;
  private readonly rpc: RpcClient;
  private readonly capability: CapabilityService;
  private readonly translator: AcpEventTranslator;
  private readonly subscriptions: SubscriptionService;
  private readonly permissions: PermissionCoordinator;
  private readonly sessions: SessionService;

  constructor() {
    this.state = new SessionStateStore();
    this.lifecycle = new AcpTransportLifecycle();
    this.rpc = new RpcClient({
      transport: this.lifecycle.transport,
      ensureUsable: () => this.lifecycle.ensureConnected(),
      onNotification: (message) => this.dispatchNotification(message),
    });
    this.lifecycle.setRpcClient(this.rpc);
    this.lifecycle.setTransportClosedHandler((error) => this.handleTransportClosed(error));
    this.capability = new CapabilityService(this.rpc);
    this.translator = new AcpEventTranslator(this.state, this.capability);
    this.subscriptions = new SubscriptionService(this.state);
    this.permissions = new PermissionCoordinator(this.rpc, this.state);
    this.sessions = new SessionService(
      this.rpc,
      this.state,
      this.capability,
      () => this.lifecycle.ensureConnected(),
    );
  }

  // ============================================
  // Connection lifecycle
  // ============================================

  async connect(config: BackendConnectionConfig, signal?: AbortSignal): Promise<void> {
    try {
      await this.lifecycle.connect(config, signal, () => this.disconnect());
      this.state.setDefaultDirectory(this.lifecycle.getDirectory());
      this.capability.setProvider(this.lifecycle.getProvider());
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const process = this.lifecycle.getProcess();
    if (this.lifecycle.isConnected() || process) {
      log.debug("[AcpBackend] Disconnecting ACP runtime", {
        hasProcess: !!process,
        directory: this.lifecycle.getDirectory(),
      });
    }

    this.rpc.rejectPending(new AcpError("acp_process_failed", "Disconnected"));
    this.clearConnectionState();

    const detached = this.lifecycle.detachForShutdown();
    await this.lifecycle.terminateProcess(detached);
  }

  private clearConnectionState(): void {
    this.subscriptions.abortAll();
    this.state.clearAll();
    this.capability.clearCaches();
    this.capability.setProvider(null);
    this.permissions.clearAll();
  }

  private handleTransportClosed(error: AcpError): void {
    try {
      this.state.emitActivePromptError(error);
    } finally {
      this.clearConnectionState();
    }
  }

  isConnected(): boolean {
    return this.lifecycle.isConnected();
  }

  getSdkClient(): { transport: "acp-stdio" } | null {
    return this.lifecycle.isConnected() ? { transport: "acp-stdio" } : null;
  }

  getDirectory(): string {
    return this.lifecycle.getDirectory();
  }

  getConnectionInfo(): ConnectionInfo | null {
    return this.lifecycle.getConnectionInfo();
  }

  // ============================================
  // Inbound notification routing
  // ============================================

  private dispatchNotification(message: JsonRpcMessage): void {
    const method = message.method;
    const params = message.params;
    if (!method || !isRecord(params)) {
      return;
    }
    if (method === "session/update") {
      this.translator.handleSessionUpdate(params);
      return;
    }
    if (method === "session/request_permission") {
      this.permissions.handleRequestPermission(message);
      return;
    }
    if (method === "session/question") {
      this.translator.handleSessionQuestion(params);
      return;
    }
    if (method === "session/status") {
      this.translator.handleSessionStatus(params);
      return;
    }
  }

  // ============================================
  // Session operations
  // ============================================

  createSession(options: CreateSessionOptions): Promise<AgentSession> {
    return this.sessions.createSession(options);
  }

  setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
    return this.sessions.setConfigOption(sessionId, configId, value);
  }

  setSessionModel(sessionId: string, modelId: string): Promise<void> {
    return this.sessions.setSessionModel(sessionId, modelId);
  }

  getSession(id: string): Promise<AgentSession | null> {
    return this.sessions.getSession(id);
  }

  listSessions(directory?: string): Promise<ImportableSession[]> {
    return this.sessions.listSessions(directory);
  }

  importSession(options: ImportSessionOptions): Promise<ImportSessionResult> {
    return this.sessions.importSession(options);
  }

  deleteSession(id: string): Promise<void> {
    return this.deleteSessionAndCleanup(id);
  }

  private async deleteSessionAndCleanup(id: string): Promise<void> {
    await this.sessions.deleteSession(id);
    this.subscriptions.clearSession(id);
    this.permissions.clearSession(id);
  }

  // ============================================
  // Prompt operations
  // ============================================

  sendPrompt(sessionId: string, prompt: PromptInput): Promise<AgentResponse> {
    return this.sessions.sendPrompt(sessionId, prompt);
  }

  sendPromptAsync(sessionId: string, prompt: PromptInput): Promise<void> {
    return this.sessions.sendPromptAsync(sessionId, prompt);
  }

  abortSession(sessionId: string): Promise<void> {
    return this.sessions.abortSession(sessionId);
  }

  // ============================================
  // Model discovery
  // ============================================

  getModels(directory: string): Promise<ModelInfo[]> {
    return this.sessions.getModels(directory);
  }

  getModelVariants(directory: string, modelID: string): Promise<string[]> {
    return this.sessions.getModelVariants(directory, modelID);
  }

  // ============================================
  // Subscriptions and replies
  // ============================================

  abortAllSubscriptions(): void {
    this.subscriptions.abortAll();
  }

  async subscribeToEvents(sessionId: string): Promise<EventStream<AgentEvent>> {
    this.lifecycle.ensureConnected();
    return this.subscriptions.subscribe(sessionId);
  }

  async replyToPermission(requestId: string, response: string): Promise<void> {
    this.lifecycle.ensureConnected();
    await this.permissions.replyToPermission(requestId, response);
  }

  async replyToQuestion(requestId: string, answers: string[][]): Promise<void> {
    this.lifecycle.ensureConnected();
    await this.permissions.replyToQuestion(requestId, answers);
  }
}
