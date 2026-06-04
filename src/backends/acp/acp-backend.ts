/**
 * ACP backend implementation for Clanky Tasks Management System.
 * Uses ACP JSON-RPC over stdio for agent communication.
 */

import { isRemoteOnlyMode } from "../../core/config";
import { log } from "../../core/logger";
import { AGENT_PROVIDER_OPTIONS } from "../../constants/agent-providers";
import type { ModelInfo } from "../../types/api";
import type { AgentProvider } from "../../types/settings";

import type {
  BackendConnectionConfig,
  CreateSessionOptions,
  AgentSession,
  PromptInput,
  AgentResponse,
  AgentPart,
  AgentEvent,
  Backend,
  ConnectionInfo,
  ConfigOption,
  ImportableSession,
  ImportSessionOptions,
  ImportSessionResult,
  SessionReplayEvent,
} from "../types";
import { createEventStream, type EventStream } from "../../utils/event-stream";
import { getProviderAcpCommand } from "../../core/agent-runtime-command";

import type {
  AcpSession,
  AcpEvent,
  Part,
  AssistantMessage,
  TranslateEventContext,
  JsonRpcMessage,
  PendingRequest,
  SessionSubscriber,
  PendingPermissionRequest,
} from "./types";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  PROMPT_REQUEST_TIMEOUT_MS,
  MAX_RECENT_PROCESS_LINES,
} from "./types";
import { isRecord, getString, getNumber, firstString } from "./json-helpers";
import {
  sanitizeSpawnArgsForLogging,
  getProcessExitHint,
  isTransientSshAuthenticationFailure,
} from "./process-utils";

const ACP_PROCESS_EXIT_WAIT_MS = 1_000;
const ACP_PROCESS_FORCE_KILL_WAIT_MS = 250;
const ACP_SSH_INITIALIZE_ATTEMPTS = 3;
const ACP_SSH_INITIALIZE_RETRY_DELAY_MS = 250;

type CachedModels = {
  models: ModelInfo[];
  complete: boolean;
};

type ReplaySubscriber = (event: SessionReplayEvent) => void;

/**
 * ACP backend implementation.
 * Supports stdio ACP mode and translates ACP stream updates into AgentEvents.
 */
export class AcpBackend implements Backend {
  readonly name = "acp";

  private process: Bun.Subprocess | null = null;
  private connected = false;
  private directory = "";
  private provider: AgentProvider | null = null;
  private connectionInfo: ConnectionInfo | null = null;

  /** Track active subscriptions for reset functionality */
  private activeSubscriptions = new Set<AbortController>();

  /** Track pending JSON-RPC requests by ID */
  private pendingRequests = new Map<number, PendingRequest>();
  private nextRequestId = 1;

  /** Event subscriber callbacks by session */
  private sessionSubscribers = new Map<string, Set<SessionSubscriber>>();

  /** Replay subscribers capture raw session/load history without live-stream normalization. */
  private replaySubscribers = new Map<string, Set<ReplaySubscriber>>();

  /** Track whether message.start has been emitted for active prompt per session */
  private sessionMessageStarted = new Map<string, boolean>();

  /** Track accumulated assistant text per active prompt to normalize delta/snapshot updates */
  private sessionMessageContent = new Map<string, string>();

  /** Monotonic per-session prompt sequence to ignore stale async completions */
  private sessionPromptSequences = new Map<string, number>();

  /** Whether the active async prompt has produced meaningful activity */
  private sessionPromptHasActivity = new Map<string, boolean>();

  /** Ignore status-only completion signals until fresh prompt activity arrives after an abort */
  private sessionIgnoreStatusUntilActivity = new Set<string>();

  /** Track reasoning part identity per session to separate distinct reasoning parts */
  private sessionReasoningPartKeys = new Map<string, string>();

  /** Track the last emitted reasoning chunk signature per session to suppress duplicates */
  private sessionLastReasoningChunkSignature = new Map<string, string>();

  /** Cache sessions and model discovery results */
  private sessionCache = new Map<string, AgentSession>();
  private sessionDirectories = new Map<string, string>();
  private modelCache = new Map<string, CachedModels>();
  private defaultReasoningEfforts = new Map<string, Map<string, string>>();

  /** Track active permission requests that expect a JSON-RPC response */
  private pendingPermissionRequests = new Map<string, PendingPermissionRequest>();

  /** Track tool call names by toolCallId to resolve later updates */
  private toolCallNames = new Map<string, string>();

  /** Recent non-JSON ACP process output lines for diagnostics */
  private recentProcessLines: string[] = [];

  /**
   * Connect to an ACP-capable agent.
   * Uses spawn mode to launch the configured CLI with ACP stdio transport.
   * Connect mode is intentionally unsupported in the ACP runtime.
   */
  async connect(config: BackendConnectionConfig, _signal?: AbortSignal): Promise<void> {
    if (this.connected) {
      throw new Error("Already connected. Call disconnect() first.");
    }

    this.directory = config.directory;
    this.provider = config.provider ?? "opencode";
    log.debug("[AcpBackend] connect requested", {
      transport: config.transport,
      provider: config.provider,
      directory: config.directory,
    });

    if (config.mode !== "spawn") {
      throw new Error("Connect mode is not supported by ACP runtime. Use stdio or ssh transport.");
    }

    if (isRemoteOnlyMode() && config.transport !== "ssh") {
      throw new Error(
        "Local stdio transport is disabled. CLANKY_REMOTE_ONLY environment variable is set. " +
        "Only ssh transport is allowed.",
      );
    }

    this.connected = true;
    try {
      await this.connectSpawn(config);
    } catch (error) {
      this.connected = false;
      this.process = null;
      this.provider = null;
      throw error;
    }
  }

  /**
   * Spawn an ACP stdio process and initialize JSON-RPC.
   */
  private async connectSpawn(config: BackendConnectionConfig): Promise<void> {
    const providerCommand = getProviderAcpCommand(config.provider ?? "opencode", config.transport);
    const command = config.command ?? providerCommand.command;
    const args = config.args ?? providerCommand.args;
    const logArgs = sanitizeSpawnArgsForLogging(command, args);
    const spawnCwd = config.transport === "ssh" ? "/" : config.directory;
    this.recentProcessLines = [];
    log.debug("[AcpBackend] Spawning ACP runtime", {
      command,
      args: logArgs,
      directory: config.directory,
      spawnCwd,
      transport: config.transport,
      provider: config.provider,
    });

    const maxAttempts = config.transport === "ssh" ? ACP_SSH_INITIALIZE_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.recentProcessLines = [];
      let process: Bun.Subprocess;
      try {
        process = Bun.spawn([command, ...args], {
          cwd: spawnCwd,
          env: config.env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (error) {
        throw new Error(`Failed to spawn ACP process (${command}) in cwd '${spawnCwd}': ${String(error)}`);
      }

      this.process = process;
      this.startProcessReaders(command);

      try {
        await this.sendRpcRequest("initialize", {
          protocolVersion: 1,
          clientInfo: {
            name: "clanky",
            version: "0.0.0",
          },
        });
        break;
      } catch (error) {
        await this.terminateProcess(process);
        if (this.process === process) {
          this.process = null;
        }
        this.pendingRequests.clear();

        if (!isTransientSshAuthenticationFailure(error) || attempt >= maxAttempts) {
          await this.disconnect();
          throw new Error(`Failed to initialize ACP process (${command}): ${String(error)}`);
        }

        log.warn("[AcpBackend] Retrying ACP SSH initialization after transient auth failure", {
          attempt,
          maxAttempts,
          provider: config.provider,
          hostname: config.hostname,
          port: config.port,
        });
        await Bun.sleep(ACP_SSH_INITIALIZE_RETRY_DELAY_MS);
      }
    }
    log.debug("[AcpBackend] ACP runtime initialized", { command });

    this.connectionInfo = {
      baseUrl: `acp://stdio/${command}`,
      authHeaders: {},
    };
  }

  /**
   * Disconnect from the backend and clean up resources.
   */
  async disconnect(): Promise<void> {
    if (!this.connected && !this.process) {
      return;
    }
    const process = this.process;
    log.debug("[AcpBackend] Disconnecting ACP runtime", {
      hasProcess: !!process,
      directory: this.directory,
    });

    this.abortAllSubscriptions();

    this.rejectPendingRequests("Disconnected");

    this.process = null;

    this.sessionSubscribers.clear();
    this.sessionMessageStarted.clear();
    this.sessionMessageContent.clear();
    this.sessionPromptSequences.clear();
    this.sessionPromptHasActivity.clear();
    this.sessionIgnoreStatusUntilActivity.clear();
    this.sessionReasoningPartKeys.clear();
    this.sessionLastReasoningChunkSignature.clear();
    this.sessionCache.clear();
    this.sessionDirectories.clear();
    this.modelCache.clear();
    this.defaultReasoningEfforts.clear();
    this.pendingPermissionRequests.clear();
    this.toolCallNames.clear();
    this.recentProcessLines = [];

    this.connected = false;
    this.directory = "";
    this.provider = null;
    this.connectionInfo = null;

    await this.terminateProcess(process);
  }

  /**
   * Check if connected to the backend.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get the low-level client object (not used for ACP transport).
   */
  getSdkClient(): { transport: "acp-stdio" } | null {
    if (!this.connected) {
      return null;
    }
    return { transport: "acp-stdio" };
  }

  /**
   * Get the current directory.
   */
  getDirectory(): string {
    return this.directory;
  }

  /**
   * Get connection info for diagnostics and ancillary connections.
   */
  getConnectionInfo(): ConnectionInfo | null {
    return this.connectionInfo;
  }

  private ensureConnected(): void {
    if (!this.connected || !this.process) {
      throw new Error("Not connected. Call connect() first.");
    }
  }

  private startProcessReaders(command: string): void {
    const process = this.process;
    if (
      !process
      || !process.stdout
      || !process.stderr
      || typeof process.stdout === "number"
      || typeof process.stderr === "number"
    ) {
      return;
    }

    void this.readRpcStream(process.stdout, "stdout");
    void this.readRpcStream(process.stderr, "stderr");
    void process.exited.then((exitCode) => {
      if (this.process !== process || !this.connected) {
        return;
      }
      const hint = getProcessExitHint(command, exitCode);
      const details = this.recentProcessLines.slice(-5).join(" | ");
      const parts = [`ACP process exited with code ${exitCode}`];
      if (details.length > 0) {
        parts.push(details);
      }
      if (hint) {
        parts.push(hint);
      }
      const reason = parts.join(": ");
      this.rejectPendingRequests(reason);
    });
  }

  private pushProcessLine(line: string): void {
    this.recentProcessLines.push(line);
    if (this.recentProcessLines.length > MAX_RECENT_PROCESS_LINES) {
      this.recentProcessLines.shift();
    }
  }

  private rejectPendingRequests(reason: string): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  private async terminateProcess(process: Bun.Subprocess | null): Promise<void> {
    if (!process || process.exitCode !== null) {
      return;
    }

    try {
      process.kill("SIGTERM");
    } catch (error) {
      log.debug("[AcpBackend] Failed to send SIGTERM while disconnecting ACP runtime", {
        error: String(error),
      });
    }

    const exitedAfterTerminate = await this.waitForProcessExit(process, ACP_PROCESS_FORCE_KILL_WAIT_MS);
    if (exitedAfterTerminate) {
      return;
    }

    try {
      process.kill("SIGKILL");
    } catch (error) {
      log.debug("[AcpBackend] Failed to send SIGKILL while disconnecting ACP runtime", {
        error: String(error),
      });
    }

    await this.waitForProcessExit(process, ACP_PROCESS_EXIT_WAIT_MS);
  }

  private async waitForProcessExit(process: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
    if (process.exitCode !== null) {
      return true;
    }

    const exited = await Promise.race<boolean>([
      process.exited.then(() => true),
      Bun.sleep(timeoutMs).then(() => false),
    ]);

    return exited || process.exitCode !== null;
  }

  private async readRpcStream(stream: ReadableStream<Uint8Array>, source: "stdout" | "stderr"): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            this.handleRpcLine(line, source);
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }

      const rest = buffer.trim();
      if (rest.length > 0) {
        this.handleRpcLine(rest, source);
      }
    } catch (error) {
      log.warn(`[AcpBackend] ACP ${source} stream ended with error`, {
        error: String(error),
      });
    }
  }

  private handleRpcLine(line: string, source: "stdout" | "stderr"): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.pushProcessLine(`[${source}] ${line}`);
      if (source === "stderr") {
        log.debug(`[AcpBackend] ACP stderr: ${line}`);
      } else {
        log.trace(`[AcpBackend] Non-JSON stdout: ${line}`);
      }
      return;
    }

    this.handleRpcMessage(message);
  }

  private handleRpcMessage(message: JsonRpcMessage): void {
    log.trace("[AcpBackend] Received RPC message", {
      method: message.method,
      id: message.id,
      params: message.params,
      result: message.result,
      error: message.error,
    });

    const method = message.method;
    if (method && isRecord(message.params)) {
      if (method === "session/update") {
        this.handleSessionUpdate(message.params);
        return;
      }

      if (method === "session/request_permission") {
        const sessionId = getString(message.params["sessionId"]);
        if (!sessionId) {
          return;
        }
        const toolCall = isRecord(message.params["toolCall"]) ? message.params["toolCall"] : {};
        const requestId = message.id !== undefined
          ? `permission-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          : firstString(message.params["requestId"], toolCall["toolCallId"]);
        if (!requestId) {
          return;
        }

        const permission = firstString(
          message.params["permission"],
          toolCall["kind"],
          toolCall["title"],
        ) ?? "*";
        const rawInput = isRecord(toolCall["rawInput"]) ? toolCall["rawInput"] : {};

        const patternsFromCommands = Array.isArray(rawInput["commands"])
          ? rawInput["commands"].filter((p): p is string => typeof p === "string")
          : [];
        const patterns = Array.isArray(message.params["patterns"])
          ? message.params["patterns"].filter((p): p is string => typeof p === "string")
          : patternsFromCommands.length > 0
            ? patternsFromCommands
            : firstString(rawInput["command"])
              ? [String(rawInput["command"])]
              : ["*"];

        const options = Array.isArray(message.params["options"])
          ? message.params["options"]
            .filter((option): option is Record<string, unknown> => isRecord(option))
            .map((option) => ({
              optionId: getString(option["optionId"]) ?? "",
              kind: getString(option["kind"]),
            }))
            .filter((option) => option.optionId.length > 0)
          : [];

        if (message.id !== undefined) {
          this.pendingPermissionRequests.set(requestId, {
            rpcId: message.id,
            options,
          });
        }

        this.emitSessionEvent(sessionId, {
          type: "permission.asked",
          requestId,
          sessionId,
          permission,
          patterns,
        });
        return;
      }

      if (method === "session/question") {
        const sessionId = getString(message.params["sessionId"]);
        const requestId = getString(message.params["requestId"]);
        const questions = message.params["questions"];
        if (!sessionId || !requestId || !Array.isArray(questions)) {
          return;
        }
        this.emitSessionEvent(sessionId, {
          type: "question.asked",
          requestId,
          sessionId,
          questions: questions as any,
        });
        return;
      }

      if (method === "session/status") {
        const sessionId = getString(message.params["sessionId"]);
        const status = getString(message.params["status"]);
        if (!sessionId || (status !== "idle" && status !== "busy" && status !== "retry")) {
          return;
        }
        const hasActivePrompt = this.sessionPromptSequences.has(sessionId);
        const ignoreStatusUntilActivity = this.sessionIgnoreStatusUntilActivity.has(sessionId);
        if (hasActivePrompt && !ignoreStatusUntilActivity && (status === "busy" || status === "retry")) {
          this.sessionPromptHasActivity.set(sessionId, true);
        }
        this.emitSessionEvent(sessionId, {
          type: "session.status",
          sessionId,
          status,
          attempt: getNumber(message.params["attempt"]),
          message: getString(message.params["message"]),
        });
        const hasPromptActivity = this.sessionPromptHasActivity.get(sessionId) ?? false;
        if (status === "idle" && hasActivePrompt && hasPromptActivity && !ignoreStatusUntilActivity) {
          this.emitSessionEvent(sessionId, {
            type: "message.complete",
            content: "",
          });
          this.sessionMessageStarted.delete(sessionId);
          this.sessionMessageContent.delete(sessionId);
          this.sessionPromptSequences.delete(sessionId);
          this.sessionPromptHasActivity.delete(sessionId);
          this.sessionIgnoreStatusUntilActivity.delete(sessionId);
          this.sessionReasoningPartKeys.delete(sessionId);
          this.sessionLastReasoningChunkSignature.delete(sessionId);
        }
        return;
      }
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.id);

      if (message.error) {
        const errMessage = message.error.message ?? JSON.stringify(message.error);
        pending.reject(new Error(errMessage));
        return;
      }

      pending.resolve(message.result);
    }
  }

  private handleSessionUpdate(params: Record<string, unknown>): void {
    const sessionId = getString(params["sessionId"]);
    const updateObj = isRecord(params["update"]) ? params["update"] : params;
    const updateType = getString(updateObj["sessionUpdate"]) ?? getString(updateObj["type"]);
    const content = isRecord(updateObj["content"]) ? updateObj["content"] : {};

    log.trace("[AcpBackend] Raw session/update", {
      sessionId,
      updateType,
      params,
      updateObj,
      content,
    });

    if (!sessionId || !updateType) {
      return;
    }

    this.emitReplayEvent(sessionId, updateObj, content, updateType);

    // Handle config_option_update/config_options_update from the agent.
    if (updateType === "config_option_update" || updateType === "config_options_update") {
      const configOptions = this.parseConfigOptions(updateObj);
      if (configOptions.length > 0) {
        const cached = this.sessionCache.get(sessionId);
        if (cached) {
          cached.configOptions = configOptions;
          const modelOption = configOptions.find((o) => o.category === "model" || o.id === "model");
          if (modelOption) {
            cached.model = modelOption.currentValue;
          }
        }
        log.debug("[AcpBackend] Config options updated by agent", {
          sessionId,
          options: configOptions.map((o) => `${o.id}=${o.currentValue}`),
        });
      }
      return;
    }

    if (updateType === "user_message_chunk") {
      const text = getString(content["text"]) ?? "";
      if (text.length > 0) {
        this.emitSessionEvent(sessionId, {
          type: "user.message",
          content: text,
        });
      }
      return;
    }

    if (updateType === "agent_message_chunk") {
      const text = getString(content["text"]) ?? "";
      if (text.length === 0) {
        return;
      }
      if (this.sessionPromptSequences.has(sessionId)) {
        this.sessionPromptHasActivity.set(sessionId, true);
      }
      this.sessionIgnoreStatusUntilActivity.delete(sessionId);
      if (!this.sessionMessageStarted.get(sessionId)) {
        this.sessionMessageStarted.set(sessionId, true);
        this.sessionMessageContent.set(sessionId, "");
        this.emitSessionEvent(sessionId, {
          type: "message.start",
          messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
      }
      const delta = this.normalizeMessageChunk(sessionId, text);
      if (delta.length > 0) {
        this.emitSessionEvent(sessionId, {
          type: "message.delta",
          content: delta,
        });
      }
      return;
    }

    if (updateType === "agent_thought_chunk") {
      if (this.sessionPromptSequences.has(sessionId)) {
        this.sessionPromptHasActivity.set(sessionId, true);
      }
      this.sessionIgnoreStatusUntilActivity.delete(sessionId);
      const text = getString(content["text"]) ?? "";
      if (text.length > 0) {
        let reasoningText = text;
        const partKey = this.getReasoningPartKey(updateObj, content);
        const chunkSignature = `${partKey ?? "unknown"}\u0000${text}`;
        if (this.sessionLastReasoningChunkSignature.get(sessionId) === chunkSignature) {
          return;
        }
        if (partKey) {
          const previousPartKey = this.sessionReasoningPartKeys.get(sessionId);
          if (previousPartKey && previousPartKey !== partKey && !text.startsWith("\n")) {
            reasoningText = `\n${text}`;
          }
          this.sessionReasoningPartKeys.set(sessionId, partKey);
        }
        this.sessionLastReasoningChunkSignature.set(sessionId, chunkSignature);
        this.emitSessionEvent(sessionId, {
          type: "reasoning.delta",
          content: reasoningText,
        });
      }
      return;
    }

    if (updateType === "tool_call") {
      if (this.sessionPromptSequences.has(sessionId)) {
        this.sessionPromptHasActivity.set(sessionId, true);
      }
      this.sessionIgnoreStatusUntilActivity.delete(sessionId);
      const toolCallId = firstString(updateObj["toolCallId"], content["toolCallId"]);
      const toolName = firstString(
        content["toolName"],
        content["name"],
        updateObj["toolName"],
        updateObj["name"],
        updateObj["kind"],
        content["kind"],
        updateObj["title"],
      ) ?? "unknown_tool";
      if (toolCallId) {
        this.toolCallNames.set(toolCallId, toolName);
      }
      log.trace("[AcpBackend] Handling tool_call update", {
        sessionId,
        toolCallId,
        toolName,
        contentInput: content["input"],
        updateInput: updateObj["input"],
        rawInput: updateObj["rawInput"],
        fullUpdate: updateObj,
      });
      this.emitSessionEvent(sessionId, {
        type: "tool.start",
        toolCallId,
        toolName,
        input: content["input"] ?? updateObj["input"] ?? updateObj["rawInput"] ?? {},
      });
      return;
    }

    if (updateType === "tool_call_update") {
      if (this.sessionPromptSequences.has(sessionId)) {
        this.sessionPromptHasActivity.set(sessionId, true);
      }
      this.sessionIgnoreStatusUntilActivity.delete(sessionId);
      const toolCallId = firstString(updateObj["toolCallId"], content["toolCallId"]);
      const toolName = firstString(
        content["toolName"],
        content["name"],
        updateObj["toolName"],
        updateObj["name"],
        updateObj["kind"],
        toolCallId ? this.toolCallNames.get(toolCallId) : undefined,
        updateObj["title"],
      ) ?? "unknown_tool";
      const status = firstString(
        content["status"],
        updateObj["status"],
        content["state"],
        updateObj["state"],
      );

      log.trace("[AcpBackend] Handling tool_call_update", {
        sessionId,
        toolCallId,
        toolName,
        status,
        contentOutput: content["output"],
        updateOutput: updateObj["output"],
        rawOutput: updateObj["rawOutput"],
        fullUpdate: updateObj,
      });

      if (
        status === "completed"
        || status === "success"
        || status === "failed"
        || status === "error"
        || status === "cancelled"
        || status === "canceled"
      ) {
        const rawOutput = isRecord(updateObj["rawOutput"]) ? updateObj["rawOutput"] : {};
        const completedInput = updateObj["input"] ?? updateObj["rawInput"] ?? content["input"];
        const errorMessage = firstString(content["error"], updateObj["error"], rawOutput["message"]);
        const baseOutput = content["output"] ?? updateObj["output"] ?? updateObj["rawOutput"] ?? content["content"] ?? updateObj["content"];
        const isFailure = status === "failed" || status === "error";
        const output = isFailure
          ? isRecord(baseOutput)
            ? {
              ...baseOutput,
              status,
              ...(errorMessage ? { error: errorMessage } : {}),
            }
            : {
              status,
              ...(errorMessage ? { error: errorMessage } : {}),
              ...(baseOutput !== undefined ? { output: baseOutput } : {}),
            }
          : baseOutput ?? {};

        this.emitSessionEvent(sessionId, {
          type: "tool.complete",
          toolCallId,
          toolName,
          input: completedInput,
          output,
        });
        if (toolCallId) {
          this.toolCallNames.delete(toolCallId);
        }
      }
    }
  }

  private getReasoningPartKey(
    updateObj: Record<string, unknown>,
    content: Record<string, unknown>,
  ): string | undefined {
    const partId = firstString(
      content["partId"],
      content["partID"],
      updateObj["partId"],
      updateObj["partID"],
      content["reasoningPartId"],
      updateObj["reasoningPartId"],
      content["thoughtId"],
      updateObj["thoughtId"],
    );
    if (partId) {
      return `id:${partId}`;
    }

    const partIndex = getNumber(content["partIndex"])
      ?? getNumber(updateObj["partIndex"])
      ?? getNumber(content["reasoningPartIndex"])
      ?? getNumber(updateObj["reasoningPartIndex"]);
    if (partIndex !== undefined) {
      return `index:${partIndex}`;
    }

    return undefined;
  }

  private normalizeMessageChunk(sessionId: string, text: string): string {
    if (text.length === 0) {
      return "";
    }

    const previousContent = this.sessionMessageContent.get(sessionId) ?? "";
    if (previousContent.length === 0) {
      this.sessionMessageContent.set(sessionId, text);
      return text;
    }

    if (text.length > previousContent.length && text.startsWith(previousContent)) {
      this.sessionMessageContent.set(sessionId, text);
      return text.slice(previousContent.length);
    }

    const nextContent = previousContent + text;
    this.sessionMessageContent.set(sessionId, nextContent);
    return text;
  }

  private addSessionSubscriber(sessionId: string, subscriber: SessionSubscriber): void {
    const existing = this.sessionSubscribers.get(sessionId) ?? new Set<SessionSubscriber>();
    existing.add(subscriber);
    this.sessionSubscribers.set(sessionId, existing);
  }

  private removeSessionSubscriber(sessionId: string, subscriber: SessionSubscriber): void {
    const existing = this.sessionSubscribers.get(sessionId);
    if (!existing) {
      return;
    }
    existing.delete(subscriber);
    if (existing.size === 0) {
      this.sessionSubscribers.delete(sessionId);
    }
  }

  private addReplaySubscriber(sessionId: string, subscriber: ReplaySubscriber): void {
    const existing = this.replaySubscribers.get(sessionId) ?? new Set<ReplaySubscriber>();
    existing.add(subscriber);
    this.replaySubscribers.set(sessionId, existing);
  }

  private removeReplaySubscriber(sessionId: string, subscriber: ReplaySubscriber): void {
    const existing = this.replaySubscribers.get(sessionId);
    if (!existing) {
      return;
    }
    existing.delete(subscriber);
    if (existing.size === 0) {
      this.replaySubscribers.delete(sessionId);
    }
  }

  private emitReplayEvent(
    sessionId: string,
    updateObj: Record<string, unknown>,
    content: Record<string, unknown>,
    updateType: string,
  ): void {
    const subscribers = this.replaySubscribers.get(sessionId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const event = this.mapReplayEvent(updateObj, content, updateType);
    if (!event) {
      return;
    }

    for (const subscriber of subscribers) {
      subscriber(event);
    }
  }

  private mapReplayEvent(
    updateObj: Record<string, unknown>,
    content: Record<string, unknown>,
    updateType: string,
  ): SessionReplayEvent | null {
    if (updateType === "user_message_chunk") {
      const text = getString(content["text"]) ?? "";
      return text.length > 0 ? { type: "user.message", content: text } : null;
    }

    if (updateType === "agent_message_chunk") {
      const text = getString(content["text"]) ?? "";
      return text.length > 0 ? { type: "assistant.message", content: text } : null;
    }

    if (updateType === "agent_thought_chunk") {
      const text = getString(content["text"]) ?? "";
      return text.length > 0 ? { type: "reasoning", content: text } : null;
    }

    if (updateType === "tool_call") {
      const toolCallId = firstString(updateObj["toolCallId"], content["toolCallId"]);
      const toolName = firstString(
        content["toolName"],
        content["name"],
        updateObj["toolName"],
        updateObj["name"],
        updateObj["kind"],
        content["kind"],
        updateObj["title"],
      ) ?? "unknown_tool";
      return {
        type: "tool.start",
        toolCallId,
        toolName,
        input: content["input"] ?? updateObj["input"] ?? updateObj["rawInput"] ?? {},
      };
    }

    if (updateType === "tool_call_update") {
      const status = firstString(
        content["status"],
        updateObj["status"],
        content["state"],
        updateObj["state"],
      );
      if (
        status !== "completed"
        && status !== "success"
        && status !== "failed"
        && status !== "error"
        && status !== "cancelled"
        && status !== "canceled"
      ) {
        return null;
      }

      const toolCallId = firstString(updateObj["toolCallId"], content["toolCallId"]);
      const toolName = firstString(
        content["toolName"],
        content["name"],
        updateObj["toolName"],
        updateObj["name"],
        updateObj["kind"],
        toolCallId ? this.toolCallNames.get(toolCallId) : undefined,
        updateObj["title"],
      ) ?? "unknown_tool";
      const rawOutput = isRecord(updateObj["rawOutput"]) ? updateObj["rawOutput"] : {};
      const completedInput = updateObj["input"] ?? updateObj["rawInput"] ?? content["input"];
      const errorMessage = firstString(content["error"], updateObj["error"], rawOutput["message"]);
      const baseOutput = content["output"] ?? updateObj["output"] ?? updateObj["rawOutput"] ?? content["content"] ?? updateObj["content"];
      const isFailure = status === "failed" || status === "error";
      const output = isFailure
        ? isRecord(baseOutput)
          ? {
            ...baseOutput,
            status,
            ...(errorMessage ? { error: errorMessage } : {}),
          }
          : {
            status,
            ...(errorMessage ? { error: errorMessage } : {}),
            ...(baseOutput !== undefined ? { output: baseOutput } : {}),
          }
        : baseOutput ?? {};

      return {
        type: "tool.complete",
        toolCallId,
        toolName,
        input: completedInput,
        output,
      };
    }

    return null;
  }

  private emitSessionEvent(sessionId: string, event: AgentEvent): void {
    const subscribers = this.sessionSubscribers.get(sessionId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    for (const subscriber of subscribers) {
      subscriber(event);
    }
  }

  private writeRpcMessage(message: JsonRpcMessage): void {
    const process = this.process;
    if (!process || !process.stdin) {
      throw new Error("ACP process is not available");
    }
    if (typeof process.stdin === "number") {
      throw new Error("ACP process stdin is not writable");
    }

    log.trace("[AcpBackend] Writing RPC message", {
      id: message.id,
      method: message.method,
      params: message.params,
    });

    process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async sendRpcRequest<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    this.ensureConnected();

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`ACP request timed out for method '${method}'`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value: unknown) => {
          log.trace("[AcpBackend] RPC request resolved", {
            id,
            method,
            result: value,
          });
          resolve(value as T);
        },
        reject,
        timeout,
      });

      try {
        this.writeRpcMessage(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private parseModelsFromSessionResult(result: unknown): ModelInfo[] {
    if (!isRecord(result)) {
      return [];
    }

    const modelsRaw = result["models"];
    const modelEntries = Array.isArray(modelsRaw)
      ? modelsRaw
      : isRecord(modelsRaw) && Array.isArray(modelsRaw["availableModels"])
        ? modelsRaw["availableModels"]
        : [];

    const mapped: ModelInfo[] = [];
    for (const item of modelEntries) {
      if (!isRecord(item)) {
        continue;
      }

      const modelID = getString(item["id"]) ?? getString(item["modelId"]);
      if (!modelID) {
        continue;
      }

      const name = getString(item["name"]) ?? modelID;
      const providerID = this.getDiscoveredModelProviderID(getString(item["provider"]));

      mapped.push({
        providerID,
        providerName: this.getDiscoveredModelProviderName(providerID),
        modelID,
        modelName: name,
        connected: true,
        variants: [""],
      });
    }

    const seen = new Set<string>();
    return mapped.filter((model) => {
      const key = `${model.providerID}:${model.modelID}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  /**
   * Parse ACP configOptions from a session response.
   * Returns an array of ConfigOption objects per the ACP session-config-options spec.
   */
  private parseConfigOptions(result: unknown): ConfigOption[] {
    if (!isRecord(result)) {
      return [];
    }

    const rawOptions = result["configOptions"];
    if (!Array.isArray(rawOptions)) {
      return [];
    }

    const parsed: ConfigOption[] = [];
    for (const item of rawOptions) {
      if (!isRecord(item)) {
        continue;
      }

      const id = getString(item["id"]);
      const name = getString(item["name"]);
      const type = getString(item["type"]);
      const currentValue = getString(item["currentValue"]);
      if (!id || !name || !type || !currentValue) {
        continue;
      }

      const rawValues = Array.isArray(item["options"]) ? item["options"] : [];
      const options = rawValues
        .filter((v): v is Record<string, unknown> => isRecord(v))
        .filter((v) => getString(v["value"]) && getString(v["name"]))
        .map((v) => ({
          value: getString(v["value"])!,
          name: getString(v["name"])!,
          ...(getString(v["description"]) ? { description: getString(v["description"])! } : {}),
        }));

      parsed.push({
        id,
        name,
        type,
        currentValue,
        options,
        ...(getString(item["description"]) ? { description: getString(item["description"])! } : {}),
        ...(getString(item["category"]) ? { category: getString(item["category"])! } : {}),
      });
    }

    return parsed;
  }

  private getModelConfigOption(configOptions: ConfigOption[]): ConfigOption | undefined {
    return configOptions.find((option) => option.category === "model" || option.id === "model");
  }

  private getReasoningEffortConfigOption(configOptions: ConfigOption[]): ConfigOption | undefined {
    return configOptions.find((option) =>
      option.id === "reasoning_effort"
      || option.category === "thought_level"
      || option.category === "reasoning_effort"
      || option.category === "effort"
    );
  }

  private rememberDefaultReasoningEffort(
    directory: string,
    modelID: string | undefined,
    configOptions: ConfigOption[],
  ): void {
    if (!modelID) {
      return;
    }
    const reasoningOption = this.getReasoningEffortConfigOption(configOptions);
    if (!reasoningOption?.currentValue) {
      return;
    }
    const existing = this.defaultReasoningEfforts.get(directory) ?? new Map<string, string>();
    existing.set(modelID, reasoningOption.currentValue);
    this.defaultReasoningEfforts.set(directory, existing);
  }

  private getDefaultReasoningEffort(directory: string, modelID: string): string | undefined {
    return this.defaultReasoningEfforts.get(directory)?.get(modelID);
  }

  private getSessionDirectory(sessionId: string): string {
    return this.sessionDirectories.get(sessionId) ?? this.directory;
  }

  private buildReasoningEffortVariants(configOptions: ConfigOption[]): string[] {
    const reasoningOption = this.getReasoningEffortConfigOption(configOptions);
    if (!reasoningOption) {
      return [""];
    }

    const values = reasoningOption.options
      .map((option) => option.value)
      .filter((value) => value.length > 0);
    if (values.length === 0) {
      return [""];
    }

    const variants: string[] = [];
    if (reasoningOption.currentValue && values.includes(reasoningOption.currentValue)) {
      variants.push(reasoningOption.currentValue);
    }
    for (const value of values) {
      if (!variants.includes(value)) {
        variants.push(value);
      }
    }
    return variants;
  }

  private async cleanupDiscoverySession(sessionId: string): Promise<void> {
    try {
      await this.sendRpcRequest("session/delete", { sessionId }, 5_000);
    } catch (error) {
      const message = String(error);
      if (!message.includes("Method not found") && !message.includes("-32601")) {
        log.debug("[AcpBackend] Failed to delete temporary discovery session", {
          sessionId,
          error: message,
        });
      }
    }
  }

  private getCachedModels(directory: string): CachedModels | undefined {
    return this.modelCache.get(directory);
  }

  private hasCachedModels(directory: string): boolean {
    return !!this.getCachedModels(directory);
  }

  private supportsConfigOptionVariantDiscovery(): boolean {
    return this.provider === "copilot" || this.provider === "opencode" || this.provider === "codex";
  }

  private shouldTreatCachedModelsAsComplete(): boolean {
    return !this.supportsConfigOptionVariantDiscovery();
  }

  private setCachedModels(directory: string, models: ModelInfo[], complete: boolean): void {
    if (models.length === 0) {
      return;
    }
    const existing = this.getCachedModels(directory);
    if (existing?.complete && !complete) {
      return;
    }
    this.modelCache.set(directory, { models, complete });
  }

  private getDiscoveredModelProviderID(providerID?: string): string {
    if (this.provider) {
      return this.provider;
    }
    return providerID ?? "unknown";
  }

  private getDiscoveredModelProviderName(providerID: string): string {
    return AGENT_PROVIDER_OPTIONS.find((option) => option.id === providerID)?.label ?? providerID;
  }

  private async discoverModelVariantsFromConfigOptions(
    directory: string,
    sessionId: string,
    initialConfigOptions: ConfigOption[],
  ): Promise<ModelInfo[]> {
    const modelOption = this.getModelConfigOption(initialConfigOptions);
    if (!modelOption) {
      return [];
    }

    let configOptions = initialConfigOptions;
    const discovered: ModelInfo[] = [];

    for (const option of modelOption.options) {
      const modelID = option.value;
      if (!modelID) {
        continue;
      }

      const currentModelOption = this.getModelConfigOption(configOptions);
      if (currentModelOption?.currentValue !== modelID) {
        configOptions = await this.setConfigOption(sessionId, currentModelOption?.id ?? "model", modelID);
      }

      this.rememberDefaultReasoningEffort(directory, modelID, configOptions);
      const providerID = this.getDiscoveredModelProviderID();
      discovered.push({
        providerID,
        providerName: this.getDiscoveredModelProviderName(providerID),
        modelID,
        modelName: option.name,
        connected: true,
        variants: this.buildReasoningEffortVariants(configOptions),
      });
    }

    return discovered;
  }

  /**
   * Extract model info from configOptions (category "model").
   * This provides model discovery via the ACP session-config-options spec.
   */
  private parseModelsFromConfigOptions(configOptions: ConfigOption[]): ModelInfo[] {
    const modelOption = this.getModelConfigOption(configOptions);
    if (!modelOption) {
      return [];
    }

    return modelOption.options.map((opt) => {
      const providerID = this.getDiscoveredModelProviderID();
      return {
        providerID,
        providerName: this.getDiscoveredModelProviderName(providerID),
        modelID: opt.value,
        modelName: opt.name,
        connected: true,
        variants: [""],
      };
    });
  }

  private buildPromptParts(prompt: PromptInput): Array<Record<string, unknown>> {
    return prompt.parts.map((part) => {
      if (part.type === "image") {
        return {
          type: "image",
          mimeType: part.mimeType,
          data: part.data,
        };
      }
      return {
        type: "text",
        text: part.text,
      };
    });
  }

  private buildPromptParams(sessionId: string, prompt: PromptInput): Record<string, unknown> {
    const modelID = prompt.model?.modelID;
    log.debug("[AcpBackend] Building prompt params", {
      sessionId,
      model: modelID ?? "default",
      providerID: prompt.model?.providerID ?? "none",
      variant: prompt.model?.variant ?? "none",
    });
    return {
      sessionId,
      prompt: this.buildPromptParts(prompt),
      ...(modelID ? { model: modelID } : {}),
    };
  }

  private async configurePromptSession(
    sessionId: string,
    model: PromptInput["model"] | undefined,
  ): Promise<void> {
    if (!model) {
      return;
    }

    let configOptions = this.sessionCache.get(sessionId)?.configOptions ?? [];
    const sessionDirectory = this.getSessionDirectory(sessionId);
    const modelOption = this.getModelConfigOption(configOptions);
    if (modelOption && !modelOption.options.some((option) => option.value === model.modelID)) {
      return;
    }
    if (modelOption && modelOption.currentValue !== model.modelID) {
      configOptions = await this.setConfigOption(sessionId, modelOption.id, model.modelID);
      this.rememberDefaultReasoningEffort(sessionDirectory, model.modelID, configOptions);
    }

    const reasoningOption = this.getReasoningEffortConfigOption(configOptions);
    if (!reasoningOption) {
      return;
    }

    const desiredEffort = model.variant && model.variant.length > 0
      ? model.variant
      : this.getDefaultReasoningEffort(sessionDirectory, model.modelID) ?? reasoningOption.currentValue;

    if (!desiredEffort || reasoningOption.currentValue === desiredEffort) {
      return;
    }

    await this.setConfigOption(sessionId, reasoningOption.id, desiredEffort);
  }

  /**
   * Create a new session.
   * Model is NOT passed in session/new params — use setConfigOption() after creation.
   */
  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    log.debug("[AcpBackend] Creating session", {
      directory: options.directory,
      hasTitle: !!options.title,
      model: options.model ?? "default",
    });
    const result = await this.sendRpcRequest<unknown>("session/new", {
      cwd: options.directory,
      mcpServers: [],
      ...(options.title ? { title: options.title } : {}),
    });

    if (!isRecord(result)) {
      throw new Error("Invalid ACP response for session/new");
    }

    const id = getString(result["sessionId"]);
    if (!id) {
      throw new Error("ACP session/new did not return sessionId");
    }
    const sessionDirectory = getString(result["cwd"]) ?? options.directory;

    const session = this.mapSession({
      id,
      title: options.title,
      time: { created: Date.now() },
    });

    // Parse configOptions from session/new response (ACP session-config-options spec)
    const configOptions = this.parseConfigOptions(result);
    if (configOptions.length > 0) {
      session.configOptions = configOptions;
      log.debug("[AcpBackend] Session config options discovered", {
        sessionId: id,
        options: configOptions.map((o) => `${o.id}=${o.currentValue}`),
      });

      // Extract model info from config options
      const configModels = this.parseModelsFromConfigOptions(configOptions);
      if (configModels.length > 0) {
        this.setCachedModels(
          sessionDirectory,
          configModels,
          this.shouldTreatCachedModelsAsComplete(),
        );
      }

      // Extract current model from config options
      const modelOption = configOptions.find((o) => o.category === "model" || o.id === "model");
      if (modelOption) {
        session.model = modelOption.currentValue;
        this.rememberDefaultReasoningEffort(sessionDirectory, modelOption.currentValue, configOptions);
      }
    }

    // Fallback: parse model info from legacy fields if no config options
    if (!session.model) {
      // Try models.currentModelId (used by OpenCode)
      const modelsObj = isRecord(result["models"]) ? result["models"] : null;
      const currentModelId = modelsObj ? getString(modelsObj["currentModelId"]) : null;
      const responseModel = currentModelId ?? getString(result["model"]) ?? getString(result["defaultModel"]);
      if (responseModel) {
        session.model = responseModel;
      }
    }

    this.sessionDirectories.set(id, sessionDirectory);
    this.sessionCache.set(id, session);

    // Fallback: parse models from legacy fields if none from config options
    if (!this.hasCachedModels(sessionDirectory)) {
      const models = this.parseModelsFromSessionResult(result);
      if (models.length > 0) {
        this.setCachedModels(
          sessionDirectory,
          models,
          this.shouldTreatCachedModelsAsComplete(),
        );
      }
    }

    log.debug("[AcpBackend] Session created", {
      sessionId: session.id,
      configOptionsCount: configOptions.length,
      requestedModel: options.model ?? "default",
      reportedModel: session.model ?? "none",
    });

    return session;
  }

  /**
   * Set a session config option (per ACP session-config-options spec).
   * Sends session/set_config_option and returns the updated config options.
   */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
    log.debug("[AcpBackend] Setting config option", { sessionId, configId, value });

    const result = await this.sendRpcRequest<unknown>("session/set_config_option", {
      sessionId,
      configId,
      value,
    });

    // Parse the updated config options from the response
    const configOptions = this.parseConfigOptions(result);

    // Update the cached session with new config options
    const cached = this.sessionCache.get(sessionId);
    if (cached) {
      cached.configOptions = configOptions;
      const modelOption = configOptions.find((o) => o.category === "model" || o.id === "model");
      if (modelOption) {
        cached.model = modelOption.currentValue;
        if (configId === "model") {
          this.rememberDefaultReasoningEffort(
            this.getSessionDirectory(sessionId),
            modelOption.currentValue,
            configOptions,
          );
        }
      }
    }

    log.debug("[AcpBackend] Config option set", {
      sessionId,
      configId,
      value,
      updatedOptions: configOptions.map((o) => `${o.id}=${o.currentValue}`),
    });

    return configOptions;
  }

  /**
   * Set the model for a session via the session/set_model RPC method.
   * This is used as a fallback for agents (like OpenCode) that don't support
   * session/set_config_option but implement the older session/set_model method.
   */
  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    log.debug("[AcpBackend] Setting session model via session/set_model", { sessionId, modelId });

    await this.sendRpcRequest<unknown>("session/set_model", {
      sessionId,
      modelId,
    });

    // Update the cached session with the new model
    const cached = this.sessionCache.get(sessionId);
    if (cached) {
      cached.model = modelId;
    }

    log.debug("[AcpBackend] Session model set", { sessionId, modelId });
  }

  /**
   * Get an existing session by ID.
   */
  async getSession(id: string): Promise<AgentSession | null> {
    const cached = this.sessionCache.get(id);
    if (cached) {
      return cached;
    }

    const listedSession = (await this.listSessions()).find((session) => session.id === id);
    if (!listedSession) {
      return this.sessionCache.get(id) ?? null;
    }

    const loaded = await this.sendRpcRequest<unknown>("session/load", {
      sessionId: listedSession.id,
      cwd: listedSession.cwd,
      mcpServers: [],
    });
    const session = this.hydrateSessionFromResult(
      listedSession.id,
      loaded,
      listedSession.cwd,
      listedSession.title,
    );
    this.sessionCache.set(session.id, session);
    return session;
  }

  async listSessions(directory?: string): Promise<ImportableSession[]> {
    this.ensureConnected();

    const sessions: ImportableSession[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.sendRpcRequest<unknown>("session/list", {
        ...(directory ? { cwd: directory } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (!isRecord(result) || !Array.isArray(result["sessions"])) {
        return sessions;
      }

      for (const rawSession of result["sessions"]) {
        if (!isRecord(rawSession)) {
          continue;
        }
        const sessionId = getString(rawSession["sessionId"]) ?? getString(rawSession["id"]);
        if (!sessionId) {
          continue;
        }
        const cwd = getString(rawSession["cwd"]) ?? directory ?? this.directory;
        sessions.push({
          id: sessionId,
          title: getString(rawSession["title"]),
          cwd,
          updatedAt: getString(rawSession["updatedAt"]) ?? getString(rawSession["lastUpdatedAt"]),
          model: getString(rawSession["model"]) ?? getString(rawSession["defaultModel"]),
        });
      }

      cursor = getString(result["nextCursor"]);
    } while (cursor);

    return sessions;
  }

  async importSession(options: ImportSessionOptions): Promise<ImportSessionResult> {
    this.ensureConnected();

    const listed = (await this.listSessions(options.cwd)).find((session) => session.id === options.sessionId);
    const cwd = options.cwd ?? listed?.cwd ?? this.directory;
    const events: SessionReplayEvent[] = [];
    const capture: ReplaySubscriber = (event) => {
      events.push(event);
    };

    this.sessionMessageStarted.delete(options.sessionId);
    this.sessionMessageContent.delete(options.sessionId);
    this.sessionReasoningPartKeys.delete(options.sessionId);
    this.sessionLastReasoningChunkSignature.delete(options.sessionId);
    this.addReplaySubscriber(options.sessionId, capture);
    try {
      const loaded = await this.sendRpcRequest<unknown>("session/load", {
        sessionId: options.sessionId,
        cwd,
        mcpServers: [],
      });
      const session = this.hydrateSessionFromResult(
        options.sessionId,
        loaded,
        cwd,
        listed?.title,
      );
      this.sessionCache.set(session.id, session);
      return {
        session,
        cwd,
        events,
      };
    } catch (error) {
      const message = String(error);
      if (message.toLowerCase().includes("not found")) {
        throw new Error(`Session ${options.sessionId} not found`, {
          cause: error instanceof Error ? error : undefined,
        });
      }
      throw error;
    } finally {
      this.removeReplaySubscriber(options.sessionId, capture);
      this.sessionMessageStarted.delete(options.sessionId);
      this.sessionMessageContent.delete(options.sessionId);
      this.sessionReasoningPartKeys.delete(options.sessionId);
      this.sessionLastReasoningChunkSignature.delete(options.sessionId);
    }
  }

  /**
   * Delete a session.
   */
  async deleteSession(id: string): Promise<void> {
    this.ensureConnected();

    try {
      await this.sendRpcRequest("session/delete", { sessionId: id });
    } catch (error) {
      const message = String(error);
      if (!message.includes("Method not found") && !message.includes("-32601")) {
        throw error;
      }
    }

    this.sessionCache.delete(id);
    this.sessionDirectories.delete(id);
    this.sessionSubscribers.delete(id);
    this.sessionMessageStarted.delete(id);
    this.sessionMessageContent.delete(id);
    this.sessionPromptSequences.delete(id);
    this.sessionPromptHasActivity.delete(id);
    this.sessionReasoningPartKeys.delete(id);
    this.sessionLastReasoningChunkSignature.delete(id);
  }

  /**
   * Send a prompt synchronously and return collected content.
   */
  async sendPrompt(sessionId: string, prompt: PromptInput): Promise<AgentResponse> {
    this.ensureConnected();
    await this.configurePromptSession(sessionId, prompt.model);
    log.debug("[AcpBackend] Sending synchronous prompt", {
      sessionId,
      parts: prompt.parts.length,
      model: prompt.model?.modelID ?? "default",
    });

    const chunks: string[] = [];
    const toolParts: AgentPart[] = [];

    const capture: SessionSubscriber = (event) => {
      log.trace("[AcpBackend] sendPrompt subscriber event", {
        sessionId,
        event,
      });
      if (event.type === "message.delta") {
        chunks.push(event.content);
      } else if (event.type === "tool.start") {
        toolParts.push({
          type: "tool_call",
          toolName: event.toolName,
          toolInput: event.input,
        });
      } else if (event.type === "tool.complete") {
        toolParts.push({
          type: "tool_result",
          toolName: event.toolName,
          toolOutput: event.output,
        });
      }
    };

    this.addSessionSubscriber(sessionId, capture);
    this.sessionMessageStarted.set(sessionId, false);

    let responseContent = "";
    try {
      const result = await this.sendRpcRequest<unknown>(
        "session/prompt",
        this.buildPromptParams(sessionId, prompt),
        PROMPT_REQUEST_TIMEOUT_MS,
      );

      if (isRecord(result)) {
        log.trace("[AcpBackend] sendPrompt raw result", {
          sessionId,
          result,
        });
        const content = getString(result["content"]);
        if (content) {
          responseContent = content;
        }
      }
    } finally {
      this.removeSessionSubscriber(sessionId, capture);
      this.sessionMessageStarted.delete(sessionId);
      this.sessionMessageContent.delete(sessionId);
    }

    if (!responseContent) {
      responseContent = chunks.join("");
    }

    const mappedParts: Part[] = [];
    if (responseContent.length > 0) {
      mappedParts.push({
        type: "text",
        text: responseContent,
      });
    }
    for (const part of toolParts) {
      log.trace("[AcpBackend] sendPrompt rebuilding tool part", {
        sessionId,
        part,
      });
      if (part.type === "tool_call") {
        mappedParts.push({
          type: "tool",
          tool: part.toolName ?? "unknown_tool",
          state: {
            status: "running",
            input: part.toolInput,
          },
        });
      } else if (part.type === "tool_result") {
        mappedParts.push({
          type: "tool",
          tool: part.toolName ?? "unknown_tool",
          state: {
            status: "completed",
            output: part.toolOutput,
          },
        });
      }
    }

    const response = this.mapResponse({
      info: {
        id: `msg-${Date.now()}`,
        tokens: { input: 0, output: 0 },
      },
      parts: mappedParts,
    });
    log.debug("[AcpBackend] Synchronous prompt completed", {
      sessionId,
      responseLength: response.content.length,
      responseParts: response.parts.length,
    });
    return response;
  }

  /**
   * Send a prompt asynchronously. Streaming updates are emitted via subscribeToEvents().
   */
  async sendPromptAsync(sessionId: string, prompt: PromptInput): Promise<void> {
    this.ensureConnected();
    await this.configurePromptSession(sessionId, prompt.model);
    this.sessionMessageStarted.set(sessionId, false);
    this.sessionMessageContent.set(sessionId, "");
    const sequence = (this.sessionPromptSequences.get(sessionId) ?? 0) + 1;
    this.sessionPromptSequences.set(sessionId, sequence);
    this.sessionPromptHasActivity.set(sessionId, false);
    this.sessionReasoningPartKeys.delete(sessionId);
    this.sessionLastReasoningChunkSignature.delete(sessionId);
    log.debug("[AcpBackend] Sending async prompt", {
      sessionId,
      sequence,
      parts: prompt.parts.length,
      model: prompt.model?.modelID ?? "default",
    });

    void this.sendRpcRequest<unknown>("session/prompt", this.buildPromptParams(sessionId, prompt), PROMPT_REQUEST_TIMEOUT_MS)
      .then((result) => {
        if (this.sessionPromptSequences.get(sessionId) !== sequence) {
          return;
        }
        const hasPromptActivity = this.sessionPromptHasActivity.get(sessionId) ?? false;
        const messageStarted = this.sessionMessageStarted.get(sessionId) ?? false;
        const responseContent = this.extractPromptResultContent(result);
        if (!hasPromptActivity && !messageStarted) {
          if (responseContent) {
            log.debug("[AcpBackend] Async prompt RPC completed with direct content before activity", {
              sessionId,
              sequence,
              responseLength: responseContent.length,
            });
            this.emitSessionEvent(sessionId, {
              type: "message.complete",
              content: responseContent,
            });
            this.clearPromptState(sessionId);
            return;
          }
          log.debug("[AcpBackend] Async prompt RPC completed before activity; waiting for session updates", {
            sessionId,
            sequence,
          });
          return;
        }
        log.debug("[AcpBackend] Async prompt RPC completed", { sessionId, sequence });
        this.emitSessionEvent(sessionId, {
          type: "message.complete",
          content: "",
        });
        this.clearPromptState(sessionId);
      })
      .catch((error) => {
        if (this.sessionPromptSequences.get(sessionId) !== sequence) {
          return;
        }
        const message = String(error);
        if (message.includes("ACP request timed out for method 'session/prompt'")) {
          log.warn("[AcpBackend] session/prompt request timed out; waiting for status-driven completion", {
            sessionId,
          });
          return;
        }
        log.error("[AcpBackend] Async prompt failed", {
          sessionId,
          sequence,
          message,
        });
        this.emitSessionEvent(sessionId, {
          type: "error",
          message,
        });
        this.clearPromptState(sessionId);
      });
  }

  private extractPromptResultContent(result: unknown): string {
    if (!isRecord(result)) {
      return "";
    }

    const content = getString(result["content"]);
    return content ?? "";
  }

  private clearPromptState(sessionId: string): void {
    this.sessionMessageStarted.delete(sessionId);
    this.sessionMessageContent.delete(sessionId);
    this.sessionPromptSequences.delete(sessionId);
    this.sessionPromptHasActivity.delete(sessionId);
    this.sessionIgnoreStatusUntilActivity.delete(sessionId);
    this.sessionReasoningPartKeys.delete(sessionId);
    this.sessionLastReasoningChunkSignature.delete(sessionId);
  }

  /**
   * Abort a running session prompt if supported by the ACP provider.
   */
  async abortSession(sessionId: string): Promise<void> {
    this.ensureConnected();
    const cancellationMethods = ["session/cancel", "session/abort", "session/stop"];
    for (const method of cancellationMethods) {
      try {
        await this.sendRpcRequest(method, { sessionId }, 5_000);
        if (this.sessionPromptSequences.has(sessionId)) {
          this.sessionPromptSequences.set(sessionId, (this.sessionPromptSequences.get(sessionId) ?? 0) + 1);
          this.sessionPromptHasActivity.set(sessionId, false);
          this.sessionMessageStarted.set(sessionId, false);
          this.sessionMessageContent.set(sessionId, "");
          this.sessionIgnoreStatusUntilActivity.add(sessionId);
          this.sessionReasoningPartKeys.delete(sessionId);
          this.sessionLastReasoningChunkSignature.delete(sessionId);
        }
        return;
      } catch (error) {
        const message = String(error);
        if (!message.includes("Method not found") && !message.includes("-32601")) {
          throw error;
        }
      }
    }

    log.debug("[AcpBackend] Session abort is not supported by current ACP provider", { sessionId });
  }

  /**
   * Get available models for a directory.
   */
  async getModels(directory: string): Promise<ModelInfo[]> {
    const cached = this.getCachedModels(directory);
    if (cached?.complete) {
      return cached.models;
    }

    const result = await this.sendRpcRequest<unknown>("session/new", {
      cwd: directory,
      mcpServers: [],
    });
    const sessionId = isRecord(result) ? getString(result["sessionId"]) : undefined;

    try {
      // Try config options first, then fall back to legacy fields
      const configOptions = this.parseConfigOptions(result);
      if (this.supportsConfigOptionVariantDiscovery() && sessionId && configOptions.length > 0) {
        const discoveredModels = await this.discoverModelVariantsFromConfigOptions(directory, sessionId, configOptions);
        if (discoveredModels.length > 0) {
          this.setCachedModels(directory, discoveredModels, true);
          return discoveredModels;
        }
      }
      const configModels = this.parseModelsFromConfigOptions(configOptions);
      if (configModels.length > 0) {
        this.setCachedModels(
          directory,
          configModels,
          this.shouldTreatCachedModelsAsComplete(),
        );
        return configModels;
      }

      const models = this.parseModelsFromSessionResult(result);
      if (models.length > 0) {
        this.setCachedModels(
          directory,
          models,
          this.shouldTreatCachedModelsAsComplete(),
        );
        return models;
      }
      return cached?.models ?? [];
    } finally {
      if (sessionId) {
        await this.cleanupDiscoverySession(sessionId);
      }
    }
  }

  /**
   * Reply to a permission request.
   */
  async replyToPermission(requestId: string, response: string): Promise<void> {
    this.ensureConnected();

    const pendingRequest = this.pendingPermissionRequests.get(requestId);
    if (pendingRequest) {
      const normalizedResponse = response.toLowerCase();
      const preferredKinds =
        normalizedResponse === "always"
          ? ["allow_always", "allow_once"]
          : normalizedResponse === "once" || normalizedResponse === "allow"
            ? ["allow_once", "allow_always"]
            : normalizedResponse === "reject" || normalizedResponse === "deny"
              ? ["reject_once", "reject_always"]
              : [];

      let optionId = pendingRequest.options.find((option) => option.optionId === response)?.optionId;
      if (!optionId) {
        for (const preferredKind of preferredKinds) {
          optionId = pendingRequest.options.find((option) => option.kind === preferredKind)?.optionId;
          if (optionId) {
            break;
          }
        }
      }
      optionId = optionId
        ?? pendingRequest.options.find((option) => option.kind?.startsWith("allow"))?.optionId
        ?? pendingRequest.options[0]?.optionId;

      this.pendingPermissionRequests.delete(requestId);

      this.writeRpcMessage({
        jsonrpc: "2.0",
        id: pendingRequest.rpcId,
        result: {
          outcome: optionId
            ? { outcome: "selected", optionId }
            : { outcome: "cancelled" },
        },
      });
      return;
    }

    const payload = {
      requestId,
      response,
    };

    const methods = ["session/reply_permission", "session/permission_reply"];
    for (const method of methods) {
      try {
        await this.sendRpcRequest(method, payload, 10_000);
        return;
      } catch (error) {
        const message = String(error);
        if (!message.includes("Method not found") && !message.includes("-32601")) {
          throw error;
        }
      }
    }

    log.debug("[AcpBackend] Permission reply is not supported by current ACP provider", {
      requestId,
      response,
    });
  }

  /**
   * Reply to a question request.
   */
  async replyToQuestion(requestId: string, answers: string[][]): Promise<void> {
    this.ensureConnected();

    const payload = {
      requestId,
      answers,
    };

    const methods = ["session/reply_question", "session/question_reply"];
    for (const method of methods) {
      try {
        await this.sendRpcRequest(method, payload, 10_000);
        return;
      } catch (error) {
        const message = String(error);
        if (!message.includes("Method not found") && !message.includes("-32601")) {
          throw error;
        }
      }
    }

    log.debug("[AcpBackend] Question reply is not supported by current ACP provider", {
      requestId,
      answersCount: answers.length,
    });
  }

  /**
   * Abort all active event subscriptions.
   */
  abortAllSubscriptions(): void {
    for (const abortController of this.activeSubscriptions) {
      abortController.abort();
    }
    this.activeSubscriptions.clear();
  }

  /**
   * Subscribe to session events emitted from ACP notifications.
   */
  async subscribeToEvents(sessionId: string): Promise<EventStream<AgentEvent>> {
    this.ensureConnected();
    log.debug("[AcpBackend] Subscribing to session events", { sessionId });

    const abortController = new AbortController();
    this.activeSubscriptions.add(abortController);

    const { stream, push, end } = createEventStream<AgentEvent>();

    const subscriber: SessionSubscriber = (event) => {
      if (!abortController.signal.aborted) {
        push(event);
      }
    };

    this.addSessionSubscriber(sessionId, subscriber);

    const wrappedStream: EventStream<AgentEvent> = {
      next: () => stream.next(),
      close: () => {
        abortController.abort();
        this.activeSubscriptions.delete(abortController);
        this.removeSessionSubscriber(sessionId, subscriber);
        stream.close();
        end();
        log.debug("[AcpBackend] Unsubscribed from session events", { sessionId });
      },
    };

    return wrappedStream;
  }

  /**
   * Map an ACP session to our AgentSession type.
   */
  private mapSession(session: AcpSession): AgentSession {
    return {
      id: session.id,
      title: session.title,
      createdAt: new Date(session.time.created).toISOString(),
    };
  }

  private hydrateSessionFromResult(
    sessionId: string,
    result: unknown,
    directory: string,
    fallbackTitle?: string,
  ): AgentSession {
    const sessionDirectory = isRecord(result) ? getString(result["cwd"]) ?? directory : directory;
    this.sessionDirectories.set(sessionId, sessionDirectory);
    const session = this.mapSession({
      id: sessionId,
      title: isRecord(result) ? getString(result["title"]) ?? fallbackTitle : fallbackTitle,
      time: { created: Date.now() },
    });
    const configOptions = this.parseConfigOptions(result);
    if (configOptions.length > 0) {
      session.configOptions = configOptions;
      const modelOption = configOptions.find((option) => option.category === "model" || option.id === "model");
      if (modelOption) {
        session.model = modelOption.currentValue;
        this.rememberDefaultReasoningEffort(sessionDirectory, modelOption.currentValue, configOptions);
      }
      const configModels = this.parseModelsFromConfigOptions(configOptions);
      if (configModels.length > 0) {
        this.setCachedModels(
          sessionDirectory,
          configModels,
          this.shouldTreatCachedModelsAsComplete(),
        );
      }
    }
    if (!session.model && isRecord(result)) {
      const responseModel = getString(result["model"]) ?? getString(result["defaultModel"]);
      if (responseModel) {
        session.model = responseModel;
      }
    }
    if (!this.hasCachedModels(sessionDirectory)) {
      const models = this.parseModelsFromSessionResult(result);
      if (models.length > 0) {
        this.setCachedModels(
          sessionDirectory,
          models,
          this.shouldTreatCachedModelsAsComplete(),
        );
      }
    }
    return session;
  }

  /**
   * Map an ACP response to our AgentResponse type.
   */
  private mapResponse(response: { info: AssistantMessage; parts: Part[] }): AgentResponse {
    const parts: AgentPart[] = [];
    let fullContent = "";

    for (const part of response.parts) {
      log.trace("[AcpBackend] mapResponse inspecting part", {
        messageId: response.info.id,
        part,
      });
      if (part.type === "text") {
        parts.push({
          type: "text",
          text: part.text,
        });
        fullContent += part.text;
      } else if (part.type === "tool") {
        const toolPart = part;
        if (toolPart.state.status === "completed") {
          parts.push({
            type: "tool_result",
            toolName: toolPart.tool,
            toolOutput: toolPart.state.output,
          });
        } else {
          parts.push({
            type: "tool_call",
            toolName: toolPart.tool,
            toolInput: toolPart.state.input,
          });
        }
      }
    }

    return {
      id: response.info.id,
      content: fullContent,
      parts,
      usage: {
        inputTokens: response.info.tokens.input,
        outputTokens: response.info.tokens.output,
      },
    };
  }

  /**
   * Translate an ACP event to our AgentEvent type.
   * Returns null if the event is not relevant, for a different session, or a duplicate.
   */
  translateEvent(
    event: AcpEvent,
    ctx: TranslateEventContext
  ): AgentEvent | null {
    const {
      sessionId,
      subId,
      emittedMessageStarts,
      toolPartStatus,
      reasoningTextLength,
      pendingReasoningFallbackDeltas,
      partTypes,
      client,
      directory,
    } = ctx;
    switch (event.type) {
      case "message.updated": {
        const msg = event.properties.info;
        log.trace(`[AcpBackend:${subId}] translateEvent: message.updated`, {
          msgSessionId: msg.sessionID,
          targetSessionId: sessionId,
          role: msg.role,
          messageId: msg.id,
          alreadyEmitted: emittedMessageStarts.has(msg.id),
        });
        if (msg.sessionID !== sessionId) {
          log.trace(`[AcpBackend:${subId}] translateEvent: message.updated - session ID mismatch`);
          return null;
        }

        if (msg.role === "assistant") {
          // Only emit message.start once per message ID
          if (emittedMessageStarts.has(msg.id)) {
            log.trace(`[AcpBackend:${subId}] translateEvent: message.updated - already emitted start for this message`);
            return null;
          }
          emittedMessageStarts.add(msg.id);
          log.debug(`[AcpBackend:${subId}] translateEvent: message.updated - emitting message.start`, { messageId: msg.id });
          return {
            type: "message.start",
            messageId: msg.id,
          };
        }
        log.trace(`[AcpBackend:${subId}] translateEvent: message.updated - role is not assistant, returning null`, { role: msg.role });
        return null;
      }

      case "message.part.updated": {
        const part = event.properties.part;
        log.trace(`[AcpBackend:${subId}] translateEvent: message.part.updated`, {
          partSessionId: part.sessionID,
          targetSessionId: sessionId,
          partType: part.type,
        });
        if (part.sessionID !== sessionId) {
          log.trace(`[AcpBackend:${subId}] translateEvent: message.part.updated - session ID mismatch`);
          return null;
        }

        // Track the part type so message.part.delta can route correctly
        partTypes.set(part.id, part.type);

        if (part.type === "text") {
          // In SDK 1.2.x, text deltas arrive via message.part.delta events.
          // message.part.updated only carries the full accumulated text.
          // We use message.part.delta for streaming, so nothing to emit here.
          log.trace(`[AcpBackend:${subId}] translateEvent: message.part.updated - text part (deltas via message.part.delta)`);
        } else if (part.type === "reasoning") {
          // In SDK 1.2.x, reasoning deltas arrive via message.part.delta events.
          // Fallback: if we have full text and our tracked length is behind,
          // emit the new content (handles cases where delta events are missed).
          if (part.text) {
            const partId = part.id;
            const prevLength = reasoningTextLength.get(partId) ?? 0;
            const newContent = part.text.slice(prevLength);

            if (newContent.length > 0) {
              reasoningTextLength.set(partId, part.text.length);
              pendingReasoningFallbackDeltas.set(partId, newContent);
              return {
                type: "reasoning.delta",
                content: newContent,
              };
            }
          }
        } else if (part.type === "tool") {
          const state = part.state;
          const partId = part.id;
          const lastStatus = toolPartStatus.get(partId);

          log.trace(`[AcpBackend:${subId}] translateEvent: message.part.updated - tool part`, {
            partId,
            tool: part.tool,
            status: state.status,
            input: state.input,
            output: state.output,
          });

          // Only emit if status changed from what we last emitted
          if (state.status === "running") {
            if (lastStatus === "running") {
              // Already emitted tool.start for this tool, skip
              return null;
            }
            toolPartStatus.set(partId, "running");
            return {
              type: "tool.start",
              toolCallId: partId,
              toolName: part.tool,
              input: state.input,
            };
          } else if (state.status === "completed") {
            if (lastStatus === "completed") {
              // Already emitted tool.complete for this tool, skip
              return null;
            }
            toolPartStatus.set(partId, "completed");
            return {
              type: "tool.complete",
              toolCallId: partId,
              toolName: part.tool,
              input: state.input,
              output: state.output,
            };
          } else if (state.status === "error") {
            if (lastStatus === "error") {
              // Already emitted error for this tool, skip
              return null;
            }
            toolPartStatus.set(partId, "error");
            return {
              type: "error",
              message: state.error,
            };
          }
        } else if (part.type === "step-start") {
          // Step start - no content to emit, skip to avoid creating empty log entries
          return null;
        } else if (part.type === "step-finish") {
          // Step finish - AI completed a step
          // The step-finish contains token usage but no content
          return null;
        }
        return null;
      }

      case "session.idle": {
        if (event.properties.sessionID !== sessionId) {
          log.trace(`[AcpBackend:${subId}] translateEvent: session.idle - session ID mismatch`);
          return null;
        }
        // Session is idle = message complete
        // If we never saw a message.start, this might indicate an empty or error response
        if (!emittedMessageStarts.size) {
          log.warn(`[AcpBackend:${subId}] translateEvent: session.idle received but no assistant messages were seen`, {
            sessionId,
            emittedMessageStartsCount: emittedMessageStarts.size,
          });
          // Fetch the session to see what messages exist
          (async () => {
            try {
              const sessionResult = await client.session.get({
                sessionID: sessionId,
                directory,
              });
              if (sessionResult.data) {
                const session = sessionResult.data as any;
                log.warn(`[AcpBackend:${subId}] translateEvent: session.idle - session details`, {
                  sessionId,
                  messageCount: session.messages?.length ?? 0,
                  messages: JSON.stringify(session.messages ?? [], null, 2),
                });
              }
            } catch (err) {
              log.error(`[AcpBackend:${subId}] translateEvent: Failed to fetch session details`, { error: String(err) });
            }
          })();
        }
        log.debug(`[AcpBackend:${subId}] translateEvent: session.idle - emitting message.complete`, { sessionId });
        return {
          type: "message.complete",
          content: "", // Content is accumulated by the caller
        };
      }

      case "session.error": {
        if (event.properties.sessionID !== sessionId) return null;
        const error = event.properties.error;
        const errorMessage = typeof error?.data?.message === "string"
          ? error.data.message
          : "Unknown error";
        log.error(`[AcpBackend:${subId}] translateEvent: session.error`, { sessionId, errorMessage });
        return {
          type: "error",
          message: errorMessage,
        };
      }

      case "permission.asked": {
        // Permission request from the AI
        const props = event.properties;
        if (props.sessionID !== sessionId) return null;
        return {
          type: "permission.asked",
          requestId: props.id,
          sessionId: props.sessionID,
          permission: props.permission ?? "unknown",
          patterns: props.patterns ?? [],
        };
      }

      case "question.asked": {
        // Question from the AI requiring user input
        const props = event.properties;
        if (props.sessionID !== sessionId) return null;
        return {
          type: "question.asked",
          requestId: props.id,
          sessionId: props.sessionID,
          questions: (props.questions ?? []).map((q: any) => ({
            question: q.question ?? "",
            header: q.header ?? "",
            options: (q.options ?? []).map((o: any) => ({
              label: o.label ?? "",
              description: o.description ?? "",
            })),
            multiple: q.multiple ?? false,
            custom: q.custom ?? true,
          })),
        };
      }

      case "session.status": {
        // Session status update (idle, busy, retry)
        const props = event.properties;
        if (props.sessionID !== sessionId) return null;
        // Extract status type and optional retry info
        const statusInfo = props.status;
        const statusType = statusInfo.type;
        return {
          type: "session.status",
          sessionId: props.sessionID,
          status: statusType,
          attempt: statusType === "retry" ? statusInfo.attempt : undefined,
          message: statusType === "retry" ? statusInfo.message : undefined,
        };
      }

      default:
        if ((event as { type: string }).type === "message.part.delta") {
          type MessagePartDeltaEvent = {
            type: "message.part.delta";
            properties: {
              sessionID: string;
              partID: string;
              field: string;
              delta: string;
            };
          };

          const deltaEvent = event as unknown as MessagePartDeltaEvent;
          const { sessionID, partID, field, delta } = deltaEvent.properties;
          if (sessionID !== sessionId) {
            return null;
          }

          const partType = partTypes.get(partID);
          const resolvedType = partType ?? field;
          if (resolvedType === "text") {
            return {
              type: "message.delta",
              content: delta,
            };
          }
          if (resolvedType === "reasoning") {
            const pendingFallbackDelta = pendingReasoningFallbackDeltas.get(partID);
            if (pendingFallbackDelta === delta) {
              pendingReasoningFallbackDeltas.delete(partID);
              return null;
            }
            pendingReasoningFallbackDeltas.delete(partID);
            const currentLength = reasoningTextLength.get(partID) ?? 0;
            reasoningTextLength.set(partID, currentLength + delta.length);
            return {
              type: "reasoning.delta",
              content: delta,
            };
          }
          return null;
        }

        // Log unhandled event types for debugging
        log.trace(`[AcpBackend:${subId}] translateEvent: Unhandled event type`, { type: event.type });
        return null;
    }
  }
}
