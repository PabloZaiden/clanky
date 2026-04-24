/**
 * Session management helpers for LoopEngine.
 */

import type { LoopConfig, LoopState } from "../../types/loop";
import type { LogLevel } from "../../types/events";
import type { AgentSession } from "../../backends/types";
import { AcpBackend } from "../../backends/acp";
import { backendManager, buildConnectionConfig } from "../backend-manager";
import { log } from "../logger";
import type { LoopBackend, IterationContext } from "./engine-types";

export interface SessionOperationContext {
  backend: LoopBackend;
  config: LoopConfig;
  state: LoopState;
  workingDirectory: string;
  emitLog: (level: LogLevel, message: string, details?: Record<string, unknown>) => string;
  updateState: (update: Partial<LoopState>) => void;
  getSessionId: () => string | null;
  setSessionId: (id: string | null) => void;
}

export async function setupLoopSession(ctx: SessionOperationContext): Promise<string> {
  log.debug("[LoopEngine] setupSession: Entry point");

  const settings = await backendManager.getWorkspaceSettings(ctx.config.workspaceId);
  log.debug("[LoopEngine] setupSession: Got settings", {
    provider: settings.agent.provider,
    transport: settings.agent.transport,
    workspaceId: ctx.config.workspaceId,
  });

  const isConnected = ctx.backend.isConnected();
  log.debug("[LoopEngine] setupSession: Backend connected?", { isConnected });
  if (!isConnected) {
    ctx.emitLog("info", "Backend not connected, establishing connection...", {
      provider: settings.agent.provider,
      transport: settings.agent.transport,
      hostname: settings.agent.transport === "ssh" ? settings.agent.hostname : undefined,
      port: settings.agent.transport === "ssh" ? settings.agent.port : undefined,
    });
    log.debug("[LoopEngine] setupSession: About to call backend.connect");
    await ctx.backend.connect(buildConnectionConfig(settings, ctx.workingDirectory));
    log.debug("[LoopEngine] setupSession: backend.connect completed");
    ctx.emitLog("info", "Backend connection established");
  } else {
    ctx.emitLog("debug", "Backend already connected");
  }

  log.debug("[LoopEngine] setupSession: About to create session");
  ctx.emitLog("info", "Creating new AI session...");
  const session = await ctx.backend.createSession({
    title: `Ralph Loop: ${ctx.config.name}`,
    directory: ctx.workingDirectory,
    model: ctx.config.model?.modelID,
  });
  log.debug("[LoopEngine] setupSession: Session created", {
    sessionId: session.id,
    requestedModel: ctx.config.model?.modelID ?? "default",
    reportedModel: session.model ?? "not reported by ACP",
  });

  ctx.setSessionId(session.id);

  await setModelAfterSessionCreate(ctx, session);

  ctx.emitLog("info", `AI session created`, {
    sessionId: session.id,
    model: ctx.config.model?.modelID ?? "default",
  });

  const connectionConfig = buildConnectionConfig(settings, ctx.workingDirectory);
  const serverUrl = connectionConfig.transport === "ssh" && connectionConfig.hostname
    ? `ssh://${connectionConfig.hostname}:${connectionConfig.port ?? 22}`
    : undefined;

  log.debug("[LoopEngine] setupSession: About to update state");
  ctx.updateState({
    session: {
      id: session.id,
      serverUrl,
    },
  });
  log.debug("[LoopEngine] setupSession: Exit point");

  return session.id;
}

export async function reconnectLoopSession(ctx: SessionOperationContext): Promise<void> {
  log.debug("[LoopEngine] reconnectSession: Entry point");

  const activeSessionId = ctx.getSessionId();
  if (activeSessionId && ctx.backend.isConnected()) {
    log.debug("[LoopEngine] reconnectSession: Already have an active connected session", { sessionId: activeSessionId });
    return;
  }

  const existingSessionId = activeSessionId ?? ctx.state.session?.id;
  const existingSession = existingSessionId
    ? {
        id: existingSessionId,
        serverUrl: ctx.state.session?.serverUrl,
      }
    : undefined;
  if (existingSession?.id) {
    log.debug("[LoopEngine] reconnectSession: Found existing session in state", {
      sessionId: existingSession.id,
      serverUrl: existingSession.serverUrl,
    });

    const settings = await backendManager.getWorkspaceSettings(ctx.config.workspaceId);
    const isConnected = ctx.backend.isConnected();

    if (!isConnected) {
      ctx.emitLog("info", "Reconnecting to backend...", {
        provider: settings.agent.provider,
        transport: settings.agent.transport,
        hostname: settings.agent.transport === "ssh" ? settings.agent.hostname : undefined,
        port: settings.agent.transport === "ssh" ? settings.agent.port : undefined,
      });
      await ctx.backend.connect(buildConnectionConfig(settings, ctx.workingDirectory));
      ctx.emitLog("info", "Backend connection re-established");
    }

    const sessionLookupBackend = ctx.backend as Partial<Pick<AcpBackend, "getSession">>;
    if (typeof sessionLookupBackend.getSession === "function") {
      try {
        const remoteSession = await sessionLookupBackend.getSession(existingSession.id);
        if (!remoteSession) {
          ctx.emitLog("warn", "Persisted session no longer exists - creating a new session", {
            sessionId: existingSession.id,
          });
          await recreateSessionAfterLoss(ctx, `Session ${existingSession.id} not found during reconnect`);
          log.debug("[LoopEngine] reconnectSession: Recreated missing session");
          return;
        }
      } catch (error) {
        const message = String(error);
        if (isSessionNotFoundError(message)) {
          ctx.emitLog("warn", "Persisted session lookup reported not found - creating a new session", {
            sessionId: existingSession.id,
            error: message,
          });
          await recreateSessionAfterLoss(ctx, message);
          log.debug("[LoopEngine] reconnectSession: Recreated missing session after lookup error");
          return;
        }

        ctx.emitLog("warn", "Failed to verify persisted session - reusing stored session id", {
          sessionId: existingSession.id,
          error: message,
        });
      }
    }

    ctx.setSessionId(existingSession.id);
    ctx.emitLog("info", "Reconnected to existing session", { sessionId: ctx.getSessionId() });
    log.debug("[LoopEngine] reconnectSession: Reconnected to session", { sessionId: ctx.getSessionId() });
    return;
  }

  log.debug("[LoopEngine] reconnectSession: No existing session, creating new one");
  ctx.emitLog("info", "No existing session found, creating new session");
  await setupLoopSession(ctx);
  log.debug("[LoopEngine] reconnectSession: Exit point (new session created)");
}

export async function recreateSessionAfterLoss(ctx: SessionOperationContext, reason: string): Promise<string> {
  const previousSessionId = ctx.getSessionId();
  ctx.emitLog("warn", "Recreating AI session after session loss", {
    reason,
    previousSessionId,
  });
  ctx.setSessionId(null);
  ctx.updateState({ session: undefined });
  const newSessionId = await setupLoopSession(ctx);
  ctx.emitLog("info", "AI session recreated", {
    previousSessionId,
    newSessionId,
  });
  return newSessionId;
}

export async function handleModelChange(ctx: SessionOperationContext): Promise<void> {
  const pendingModel = ctx.state.pendingModel;
  if (!pendingModel) {
    return;
  }

  const currentModel = ctx.config.model;
  const currentModelID = currentModel?.modelID;
  const newModelID = pendingModel.modelID;
  const currentVariant = currentModel?.variant ?? "";
  const newVariant = pendingModel.variant ?? "";
  if (
    currentModel?.providerID === pendingModel.providerID
    && currentModelID === newModelID
    && currentVariant === newVariant
  ) {
    ctx.updateState({ pendingModel: undefined });
    return;
  }

  ctx.emitLog("info", "Model change detected — setting via config option", {
    previousModel: currentModelID ? `${currentModelID}${currentVariant ? ` (${currentVariant})` : ""}` : "default",
    newModel: `${newModelID}${newVariant ? ` (${newVariant})` : ""}`,
  });

  ctx.config.model = pendingModel;
  ctx.updateState({ pendingModel: undefined });

  if (ctx.getSessionId()) {
    try {
      await ctx.backend.setConfigOption(ctx.getSessionId()!, "model", newModelID);
      ctx.emitLog("info", "Model changed via config option", {
        model: newModelID,
        sessionId: ctx.getSessionId(),
      });
      return;
    } catch {
      log.debug("[LoopEngine] session/set_config_option not supported, trying session/set_model");
    }

    try {
      await ctx.backend.setSessionModel(ctx.getSessionId()!, newModelID);
      ctx.emitLog("info", "Model changed via session/set_model", {
        model: newModelID,
        sessionId: ctx.getSessionId(),
      });
    } catch (error) {
      log.warn("[LoopEngine] Failed to set model via config option or set_model, will use per-prompt model", {
        error: String(error),
        model: newModelID,
      });
      ctx.emitLog("warn", "Could not set model via ACP — will use per-prompt model override", {
        model: newModelID,
        error: String(error),
      });
    }
  }
}

export async function setModelAfterSessionCreate(ctx: SessionOperationContext, session: AgentSession): Promise<void> {
  const desiredModel = ctx.config.model?.modelID;
  if (!desiredModel || !ctx.getSessionId()) {
    return;
  }

  if (session.model === desiredModel) {
    log.debug("[LoopEngine] Session already using desired model", { model: desiredModel });
    return;
  }

  try {
    await ctx.backend.setConfigOption(ctx.getSessionId()!, "model", desiredModel);
    ctx.emitLog("info", "Model configured via session config option", {
      model: desiredModel,
      sessionId: ctx.getSessionId(),
    });
    return;
  } catch {
    log.debug("[LoopEngine] session/set_config_option not supported, trying session/set_model");
  }

  try {
    await ctx.backend.setSessionModel(ctx.getSessionId()!, desiredModel);
    ctx.emitLog("info", "Model configured via session/set_model", {
      model: desiredModel,
      sessionId: ctx.getSessionId(),
    });
  } catch (error) {
    log.warn("[LoopEngine] Failed to set model via config option or set_model after session creation", {
      error: String(error),
      model: desiredModel,
    });
    ctx.emitLog("debug", "Model setting not supported — will use per-prompt model override", {
      model: desiredModel,
    });
  }
}

export function isSessionNotFoundError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    (normalized.includes("session") && normalized.includes("not found")) ||
    normalized.includes("unknown session")
  );
}

export function resetIterationContextForRetry(ctx: IterationContext): void {
  ctx.responseContent = "";
  ctx.reasoningContent = "";
  ctx.messageCount = 0;
  ctx.toolCallCount = 0;
  ctx.outcome = "continue";
  ctx.error = undefined;
  ctx.currentMessageId = null;
  ctx.toolCalls.clear();
  ctx.currentResponseLogId = null;
  ctx.currentResponseLogContent = "";
  ctx.currentReasoningLogId = null;
  ctx.currentReasoningLogContent = "";
}
