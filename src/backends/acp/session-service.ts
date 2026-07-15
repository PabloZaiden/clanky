/**
 * Session operations and prompt orchestration for the ACP backend.
 *
 * Owns session CRUD/list/import/delete, session config/model calls, synchronous
 * and asynchronous prompt orchestration, cancellation workflow, and
 * response/session mapping. All per-session run state lives in the session
 * state store; model/config parsing and caches live in the capability service;
 * RPC access goes through the injected requester. This service holds no raw
 * process handles and no duplicated event parsing.
 */

import { log } from "../../core/logger";
import type { ModelInfo } from "@/contracts";
import type {
  AgentPart,
  AgentResponse,
  AgentSession,
  ConfigOption,
  CreateSessionOptions,
  ImportSessionOptions,
  ImportSessionResult,
  ImportableSession,
  PromptInput,
  SessionReplayEvent,
} from "../types";

import { isRecord, getString } from "./json-helpers";
import { AcpError, getAcpErrorMessage, isAcpErrorCode } from "./errors";
import { invokeOptionalMethod } from "./optional-method";
import { PROMPT_REQUEST_TIMEOUT_MS } from "./types";
import type { SessionSubscriber } from "./types";
import type { RpcRequester, ConfigOptionSetter } from "./contracts";
import type { SessionStateStore, ReplaySubscriber } from "./session-state";
import type { CapabilityService } from "./capability-service";

export class SessionService {
  constructor(
    private readonly rpc: RpcRequester,
    private readonly state: SessionStateStore,
    private readonly capability: CapabilityService,
    private readonly ensureConnected: () => void,
  ) {}

  /** Bound config-option setter used by capability variant discovery. */
  readonly setConfigOptionBound: ConfigOptionSetter = (sessionId, configId, value) =>
    this.setConfigOption(sessionId, configId, value);

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    log.debug("[AcpBackend] Creating session", {
      directory: options.directory,
      hasTitle: !!options.title,
      model: options.model ?? "default",
    });
    const result = await this.rpc.sendRequest<unknown>("session/new", {
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

    const configOptions = this.capability.parseConfigOptions(result);
    if (configOptions.length > 0) {
      session.configOptions = configOptions;
      log.debug("[AcpBackend] Session config options discovered", {
        sessionId: id,
        options: configOptions.map((o) => `${o.id}=${o.currentValue}`),
      });

      const configModels = this.capability.parseModelsFromConfigOptions(configOptions);
      if (configModels.length > 0) {
        this.capability.setCachedModels(
          sessionDirectory,
          configModels,
          this.capability.shouldTreatCachedModelsAsComplete(),
        );
      }

      const modelOption = configOptions.find((o) => o.category === "model" || o.id === "model");
      if (modelOption) {
        session.model = modelOption.currentValue;
        this.capability.rememberDefaultReasoningEffort(sessionDirectory, modelOption.currentValue, configOptions);
      }
    }

    this.state.setSessionDirectory(id, sessionDirectory);
    this.state.setCachedSession(id, session);

    log.debug("[AcpBackend] Session created", {
      sessionId: session.id,
      configOptionsCount: configOptions.length,
      requestedModel: options.model ?? "default",
      reportedModel: session.model ?? "none",
    });

    return session;
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
    log.debug("[AcpBackend] Setting config option", { sessionId, configId, value });

    const result = await this.rpc.sendRequest<unknown>("session/set_config_option", {
      sessionId,
      configId,
      value,
    });

    const configOptions = this.capability.parseConfigOptions(result);

    const cached = this.state.getCachedSession(sessionId);
    if (cached) {
      cached.configOptions = configOptions;
      const modelOption = configOptions.find((o) => o.category === "model" || o.id === "model");
      if (modelOption) {
        cached.model = modelOption.currentValue;
        if (configId === "model") {
          this.capability.rememberDefaultReasoningEffort(
            this.state.getSessionDirectory(sessionId),
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

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    log.debug("[AcpBackend] Setting session model via session/set_model", { sessionId, modelId });

    await this.rpc.sendRequest<unknown>("session/set_model", {
      sessionId,
      modelId,
    });

    const cached = this.state.getCachedSession(sessionId);
    if (cached) {
      cached.model = modelId;
    }

    log.debug("[AcpBackend] Session model set", { sessionId, modelId });
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const cached = this.state.getCachedSession(id);
    if (cached) {
      return cached;
    }

    const listedSession = (await this.listSessions()).find((session) => session.id === id);
    if (!listedSession) {
      return this.state.getCachedSession(id) ?? null;
    }

    const loaded = await this.rpc.sendRequest<unknown>("session/load", {
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
    this.state.setCachedSession(session.id, session);
    return session;
  }

  async listSessions(directory?: string): Promise<ImportableSession[]> {
    this.ensureConnected();

    const sessions: ImportableSession[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.rpc.sendRequest<unknown>("session/list", {
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
        const sessionId = getString(rawSession["sessionId"]);
        if (!sessionId) {
          continue;
        }
        const cwd = getString(rawSession["cwd"]) ?? directory ?? this.state.getSessionDirectory(sessionId);
        sessions.push({
          id: sessionId,
          title: getString(rawSession["title"]),
          cwd,
          updatedAt: getString(rawSession["updatedAt"]),
          model: getString(rawSession["model"]),
        });
      }

      cursor = getString(result["nextCursor"]);
    } while (cursor);

    return sessions;
  }

  async importSession(options: ImportSessionOptions): Promise<ImportSessionResult> {
    this.ensureConnected();

    const listed = (await this.listSessions(options.cwd)).find((session) => session.id === options.sessionId);
    const cwd = options.cwd ?? listed?.cwd ?? this.state.getSessionDirectory(options.sessionId);
    const events: SessionReplayEvent[] = [];
    const capture: ReplaySubscriber = (event) => {
      events.push(event);
    };

    this.state.clearImportState(options.sessionId);
    this.state.addReplaySubscriber(options.sessionId, capture);
    try {
      const loaded = await this.rpc.sendRequest<unknown>("session/load", {
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
      this.state.setCachedSession(session.id, session);
      return {
        session,
        cwd,
        events,
      };
    } finally {
      this.state.removeReplaySubscriber(options.sessionId, capture);
      this.state.clearImportState(options.sessionId);
    }
  }

  async deleteSession(id: string): Promise<void> {
    this.ensureConnected();

    await invokeOptionalMethod(this.rpc, "session/delete", { sessionId: id });

    this.state.clearSession(id);
  }

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

    this.state.addSessionSubscriber(sessionId, capture);
    this.state.beginSyncPrompt(sessionId);

    let responseContent = "";
    try {
      const result = await this.rpc.sendRequest<unknown>(
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
      this.state.removeSessionSubscriber(sessionId, capture);
      this.state.clearSyncPromptState(sessionId);
    }

    if (!responseContent) {
      responseContent = chunks.join("");
    }

    const mappedParts: Array<{ type: "text"; text: string } | { type: "tool"; tool: string; state: { status: string; input?: unknown; output?: unknown } }> = [];
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

  async sendPromptAsync(sessionId: string, prompt: PromptInput): Promise<void> {
    this.ensureConnected();
    await this.configurePromptSession(sessionId, prompt.model);
    const sequence = this.state.beginPrompt(sessionId);
    log.debug("[AcpBackend] Sending async prompt", {
      sessionId,
      sequence,
      parts: prompt.parts.length,
      model: prompt.model?.modelID ?? "default",
    });

    void this.rpc.sendRequest<unknown>("session/prompt", this.buildPromptParams(sessionId, prompt), PROMPT_REQUEST_TIMEOUT_MS)
      .then((result) => {
        if (this.state.getPromptSequence(sessionId) !== sequence) {
          return;
        }
        const hasPromptActivity = this.state.hasPromptActivity(sessionId);
        const messageStarted = this.state.isMessageStarted(sessionId);
        const responseContent = this.extractPromptResultContent(result);
        if (!hasPromptActivity && !messageStarted) {
          if (responseContent) {
            log.debug("[AcpBackend] Async prompt RPC completed with direct content before activity", {
              sessionId,
              sequence,
              responseLength: responseContent.length,
            });
            this.state.emitSessionEvent(sessionId, {
              type: "message.complete",
              content: responseContent,
            });
            this.state.clearPromptState(sessionId);
            return;
          }
          log.debug("[AcpBackend] Async prompt RPC completed before activity; waiting for session updates", {
            sessionId,
            sequence,
          });
          return;
        }
        log.debug("[AcpBackend] Async prompt RPC completed", { sessionId, sequence });
        this.state.emitSessionEvent(sessionId, {
          type: "message.complete",
          content: "",
        });
        this.state.clearPromptState(sessionId);
      })
      .catch((error) => {
        if (this.state.getPromptSequence(sessionId) !== sequence) {
          return;
        }
        if (isAcpErrorCode(error, "acp_request_timed_out")) {
          log.warn("[AcpBackend] session/prompt request timed out; waiting for status-driven completion", {
            sessionId,
          });
          return;
        }
        const message = getAcpErrorMessage(error);
        log.error("[AcpBackend] Async prompt failed", {
          sessionId,
          sequence,
          message,
        });
        this.state.emitSessionEvent(sessionId, {
          type: "error",
          message,
          ...(error instanceof AcpError ? { code: error.code } : {}),
        });
        this.state.clearPromptState(sessionId);
      });
  }

  async abortSession(sessionId: string): Promise<void> {
    this.ensureConnected();
    const outcome = await invokeOptionalMethod(
      this.rpc,
      "session/cancel",
      { sessionId },
      5_000,
    );
    if (outcome.kind === "supported") {
      this.state.markAborted(sessionId);
      return;
    }

    log.debug("[AcpBackend] Session abort is not supported by current ACP provider", { sessionId });
  }

  async getModels(directory: string): Promise<ModelInfo[]> {
    return this.capability.getModels(directory);
  }

  async getModelVariants(directory: string, modelID: string): Promise<string[]> {
    return this.capability.getModelVariants(directory, modelID, this.setConfigOptionBound);
  }

  private extractPromptResultContent(result: unknown): string {
    if (!isRecord(result)) {
      return "";
    }
    const content = getString(result["content"]);
    return content ?? "";
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

    let configOptions = this.state.getCachedSession(sessionId)?.configOptions ?? [];
    const sessionDirectory = this.state.getSessionDirectory(sessionId);
    const modelOption = this.capability.getModelConfigOption(configOptions);
    if (modelOption && !modelOption.options.some((option) => option.value === model.modelID)) {
      return;
    }
    if (modelOption && modelOption.currentValue !== model.modelID) {
      configOptions = await this.setConfigOption(sessionId, modelOption.id, model.modelID);
      this.capability.rememberDefaultReasoningEffort(sessionDirectory, model.modelID, configOptions);
    }

    const reasoningOption = this.capability.getReasoningEffortConfigOption(configOptions);
    if (!reasoningOption) {
      return;
    }

    const desiredEffort = model.variant && model.variant.length > 0
      ? model.variant
      : this.capability.getDefaultReasoningEffort(sessionDirectory, model.modelID) ?? reasoningOption.currentValue;

    if (!desiredEffort || reasoningOption.currentValue === desiredEffort) {
      return;
    }

    await this.setConfigOption(sessionId, reasoningOption.id, desiredEffort);
  }

  private mapSession(session: { id: string; title?: string; time: { created: number } }): AgentSession {
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
    this.state.setSessionDirectory(sessionId, sessionDirectory);
    const session = this.mapSession({
      id: sessionId,
      title: isRecord(result) ? getString(result["title"]) ?? fallbackTitle : fallbackTitle,
      time: { created: Date.now() },
    });
    const configOptions = this.capability.parseConfigOptions(result);
    if (configOptions.length > 0) {
      session.configOptions = configOptions;
      const modelOption = configOptions.find((option) => option.category === "model" || option.id === "model");
      if (modelOption) {
        session.model = modelOption.currentValue;
        this.capability.rememberDefaultReasoningEffort(sessionDirectory, modelOption.currentValue, configOptions);
      }
      const configModels = this.capability.parseModelsFromConfigOptions(configOptions);
      if (configModels.length > 0) {
        this.capability.setCachedModels(
          sessionDirectory,
          configModels,
          this.capability.shouldTreatCachedModelsAsComplete(),
        );
      }
    }
    return session;
  }

  private mapResponse(response: { info: { id: string; tokens: { input: number; output: number } }; parts: Array<{ type: "text"; text: string } | { type: "tool"; tool: string; state: { status: string; input?: unknown; output?: unknown } }> }): AgentResponse {
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
}
