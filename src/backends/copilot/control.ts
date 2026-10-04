/**
 * Native task control and admission recovery; ACKs never imply process settlement.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type {
  HarnessActivitySnapshot, HarnessActivityStopResult, HarnessCapabilities,
  HarnessCleanupResult, HarnessControl, HarnessInputAdmission,
  HarnessInputRecoveryRequest, HarnessSteerRequest,
} from "@/shared/harness-control";
import { HarnessError } from "../harness-errors";
import type { CopilotConnection } from "./connection";
import { toCopilotMessage } from "./prompt";
import { settleCopilotWork, stopCopilotActivity } from "./work-service";

const log = createLogger("copilot-control");

export class CopilotControl implements HarnessControl {
  constructor(private readonly connection: CopilotConnection) {}

  get capabilities(): HarnessCapabilities {
    return {
      adapter: "copilot", experimental: true,
      steering: "active-session", activity: "native",
      stopScopes: ["child-execution", "command"],
    };
  }

  async getActivity(sessionId: string): Promise<HarnessActivitySnapshot> {
    if (!this.connection.isConnected()) return { observation: "unavailable", reason: "disconnected" };
    const session = this.connection.requireServices().sessions.get(sessionId).native;
    await session.rpc.tasks.refresh();
    const [listing, processing] = await Promise.all([
      session.rpc.tasks.list(), session.rpc.metadata.isProcessing(),
    ]);
    return {
      observation: "available",
      coverage: listing.tasks.length > 1000 || listing.tasks.some((task) => task.type === "client") ? "partial" : "native",
      observedAt: new Date().toISOString(),
      principalProcessing: processing.processing,
      activities: listing.tasks.slice(0, 1000).map((task) => ({
        id: task.id,
        kind: task.type === "agent" ? "subagent" : task.type === "shell" ? "process" : "external",
        description: task.description.slice(0, 4096),
        status: task.status === "cancelled" ? "stopped" : task.status === "orphaned" ? "unknown" : task.status,
        ownership: task.type === "client" ? "unverified" : "owned",
        workspaceWrites: task.type === "client" ? "unknown" : "possible",
        native: { adapter: "copilot", conversationId: sessionId, activityId: task.id },
        spawningToolCallId: task.type === "agent" ? task.toolCallId : undefined,
        requestedModel: task.type === "agent" ? task.model ?? undefined : undefined,
        effectiveModel: task.type === "agent" ? task.resolvedModel ?? undefined : undefined,
        lastActivity: task.type === "agent" ? task.latestResponse?.slice(-4096) : undefined,
      })),
    };
  }

  async stopActivity(sessionId: string, activityId: string): Promise<HarnessActivityStopResult> {
    const session = this.connection.requireServices().sessions.get(sessionId).native;
    return stopCopilotActivity(session, activityId);
  }

  async steer(sessionId: string, request: HarnessSteerRequest): Promise<HarnessInputAdmission> {
    const session = this.connection.requireServices().sessions.get(sessionId).native;
    if (request.expectedTurnId) return { status: "rejected", inputId: request.inputId, code: "turn-changed" };
    if (request.prompt.model) {
      throw new HarnessError("harness_invalid_model_option", "Steering cannot change the active model.");
    }
    if (!(await session.rpc.metadata.isProcessing()).processing) {
      return { status: "rejected", inputId: request.inputId, code: "not-running" };
    }
    try {
      const nativeMessageId = await session.send({ ...toCopilotMessage(request.prompt), mode: "immediate" });
      return { status: "accepted", inputId: request.inputId, nativeMessageId };
    } catch {
      // A failed admission RPC may have reached the runtime. Never retry it blindly.
      log.warn("Native steering admission is unknown", { inputId: request.inputId });
      return { status: "unknown", inputId: request.inputId };
    }
  }

  async reconcileInput(sessionId: string, request: HarnessInputRecoveryRequest): Promise<HarnessInputAdmission> {
    if (!request.nativeMessageId) return { status: "unknown", inputId: request.inputId };
    const session = this.connection.requireServices().sessions.get(sessionId).native;
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const history = await session.rpc.eventLog.read({
        cursor, direction: "backward", includeEphemeral: false, max: 200,
      });
      if (history.cursorStatus !== "ok") break;
      if (history.events.some((event) => event.type === "user.message" && event.data.messageId === request.nativeMessageId)) {
        return { status: "delivered", inputId: request.inputId, nativeMessageId: request.nativeMessageId };
      }
      if (!history.hasMore) break;
      cursor = history.cursor;
    }
    return { status: "unknown", inputId: request.inputId };
  }

  async settleOwnedWork(sessionId: string): Promise<HarnessCleanupResult> {
    return settleCopilotWork(this.connection.requireServices().sessions.get(sessionId).native);
  }
}
