/**
 * Scoped descendant and terminal control; turn interruption alone is insufficient.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type {
  HarnessActivity, HarnessActivitySnapshot, HarnessActivityStopResult, HarnessCapabilities,
  HarnessCleanupResult, HarnessControl, HarnessInputAdmission, HarnessInputRecoveryRequest, HarnessSteerRequest,
} from "@/shared/harness-control";
import { HarnessError } from "../harness-errors";
import { CodexRpcError } from "./rpc-session";
import type { CodexRuntime } from "./runtime";
import type { CodexSessionService } from "./session-service";
import { toCodexInput } from "./prompt";

const log = createLogger("codex-control");

export class CodexControl implements HarnessControl {
  readonly capabilities: HarnessCapabilities = {
    adapter: "codex", experimental: true, steering: "expected-turn", activity: "partial",
    stopScopes: ["child-execution", "command"],
  };
  constructor(private readonly resolve: () => { runtime: CodexRuntime; sessions: CodexSessionService }) {}

  async getActivity(rootId: string): Promise<HarnessActivitySnapshot> {
    const { runtime, sessions } = this.resolve();
    if (!runtime.isOpen()) return { observation: "unavailable", reason: "disconnected" };
    await sessions.reconcileDescendants(rootId);
    const root = await runtime.rpc.request("thread/read", { threadId: rootId, includeTurns: false });
    const activities: HarnessActivity[] = [];
    const descendants = sessions.descendants(rootId);
    const threads = [root.thread, ...descendants.map((entry) => entry.thread)];
    for (const thread of threads) {
      if (thread.id !== rootId) activities.push({
        id: thread.id, parentId: thread.parentThreadId === rootId ? undefined : thread.parentThreadId ?? undefined,
        kind: "subagent", description: thread.agentNickname ?? thread.agentRole ?? thread.name ?? "Subagent",
        status: thread.status.type === "active" ? (thread.status.activeFlags.length ? "waiting" : "running")
          : thread.status.type === "idle" ? "idle" : thread.status.type === "systemError" ? "failed" : "unknown",
        ownership: "owned", workspaceWrites: thread.status.type === "notLoaded" ? "unknown" : "possible",
        spawningToolCallId: sessions.getThread(thread.id)?.spawningToolCallId,
        native: { adapter: "codex", conversationId: thread.id, activityId: thread.id },
      });
      if (thread.status.type === "notLoaded") continue;
      const terminals = await runtime.rpc.request("thread/backgroundTerminals/list", { threadId: thread.id });
      for (const terminal of terminals.data) activities.push({
        id: `terminal:${thread.id}:${terminal.processId}`,
        parentId: thread.id === rootId ? undefined : thread.id,
        kind: "process", description: terminal.command.slice(0, 4096), status: "running",
        ownership: "owned", workspaceWrites: "possible",
        native: { adapter: "codex", conversationId: thread.id, commandId: terminal.processId, toolCallId: terminal.itemId },
      });
    }
    return {
      observation: "available", observedAt: new Date().toISOString(),
      coverage: threads.some((thread) => thread.status.type === "notLoaded") ? "partial" : "native",
      principalProcessing: root.thread.status.type === "active", activities,
    };
  }

  async abort(rootId: string): Promise<void> {
    const { runtime, sessions } = this.resolve();
    sessions.get(rootId);
    const turns = await runtime.rpc.request("thread/turns/list", { threadId: rootId, limit: 20, sortDirection: "desc" });
    const active = turns.data.find((turn) => turn.status === "inProgress");
    if (active) await runtime.rpc.request("turn/interrupt", { threadId: rootId, turnId: active.id });
  }

  async stopActivity(rootId: string, activityId: string): Promise<HarnessActivityStopResult> {
    const snapshot = await this.getActivity(rootId);
    const activity = snapshot.observation === "available" ? snapshot.activities.find((entry) => entry.id === activityId) : undefined;
    if (!activity || activity.ownership !== "owned") throw new HarnessError("harness_activity_not_owned", "The activity is outside this owned native conversation.");
    const { runtime } = this.resolve();
    const threadId = activity.native.conversationId!;
    if (activity.kind === "process") {
      await runtime.rpc.request("thread/backgroundTerminals/terminate", { threadId, processId: activity.native.commandId! });
    } else {
      if (threadId === rootId) throw new HarnessError("harness_activity_not_owned", "Individual child Stop cannot target the principal.");
      await this.stopThread(threadId);
      const subtree = new Set([threadId]);
      let previousSize = 0;
      while (subtree.size !== previousSize) {
        previousSize = subtree.size;
        for (const candidate of snapshot.observation === "available" ? snapshot.activities : []) {
          if (candidate.kind === "subagent" && candidate.parentId && subtree.has(candidate.parentId)) subtree.add(candidate.id);
        }
      }
      for (const descendantId of subtree) if (descendantId !== threadId) await this.stopThread(descendantId);
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = await this.getActivity(rootId);
      if (current.observation === "unavailable") return { status: "unknown", activityId };
      if (activity.kind === "process") {
        if (!current.activities.some((entry) => entry.id === activityId)) return { status: "stopped", activityId };
      } else {
        const child = current.activities.find((entry) => entry.id === activityId);
        if (child?.status === "idle" && !current.activities.some((entry) => entry.parentId === activityId && entry.status === "running")) return { status: "stopped", activityId };
        if (!child || child.status === "unknown") return { status: "unknown", activityId };
      }
      await Bun.sleep(100);
    }
    return { status: "stopping", activityId };
  }

  async steer(rootId: string, request: HarnessSteerRequest): Promise<HarnessInputAdmission> {
    const { runtime, sessions } = this.resolve();
    sessions.get(rootId);
    if (request.prompt.model) throw new HarnessError("harness_invalid_model_option", "Steering cannot change the active model.");
    const turnId = request.expectedTurnId ?? sessions.getThread(rootId)?.turnId;
    if (!turnId) return { status: "rejected", inputId: request.inputId, code: "not-running" };
    try {
      const accepted = await runtime.rpc.request("turn/steer", {
        threadId: rootId, expectedTurnId: turnId, clientUserMessageId: request.inputId, input: toCodexInput(request.prompt),
      });
      return { status: "accepted", inputId: request.inputId, nativeClientInputId: request.inputId, nativeTurnId: accepted.turnId };
    } catch (error) {
      if (error instanceof CodexRpcError && error.rpcCode === -32600) {
        return { status: "rejected", inputId: request.inputId, code: "turn-changed" };
      }
      log.warn("Native steering admission is unknown", { inputId: request.inputId });
      return { status: "unknown", inputId: request.inputId };
    }
  }

  async reconcileInput(rootId: string, request: HarnessInputRecoveryRequest): Promise<HarnessInputAdmission> {
    const { runtime, sessions } = this.resolve();
    sessions.get(rootId);
    // The durable queue ID is also Codex's client ID, even when the RPC reply was lost.
    const clientId = request.nativeClientInputId ?? request.inputId;
    let cursor: string | null | undefined;
    for (let page = 0; page < 100; page += 1) {
      const history = await runtime.rpc.request("thread/items/list", { threadId: rootId, turnId: request.nativeTurnId, cursor, limit: 100, sortDirection: "desc" });
      const message = history.data.find((entry) => entry.item.type === "userMessage" && entry.item.clientId === clientId);
      if (message) return {
        status: "delivered", inputId: request.inputId, nativeMessageId: message.item.id,
        nativeClientInputId: clientId, nativeTurnId: message.turnId,
      };
      if (!history.nextCursor) break;
      cursor = history.nextCursor;
    }
    return { status: "unknown", inputId: request.inputId };
  }

  async settleOwnedWork(rootId: string): Promise<HarnessCleanupResult> {
    await this.abort(rootId);
    const snapshot = await this.getActivity(rootId);
    if (snapshot.observation === "unavailable") return { status: "unavailable", reason: snapshot.reason };
    for (const activity of snapshot.activities) {
      if (activity.kind === "subagent" && ["running", "waiting"].includes(activity.status)) await this.stopActivity(rootId, activity.id);
    }
    const afterChildren = await this.getActivity(rootId);
    if (afterChildren.observation === "unavailable") return { status: "unavailable", reason: afterChildren.reason };
    for (const activity of afterChildren.activities) {
      if (activity.kind === "process") {
        await this.resolve().runtime.rpc.request("thread/backgroundTerminals/terminate", {
          threadId: activity.native.conversationId!, processId: activity.native.commandId!,
        });
      }
    }
    const current = await this.getActivity(rootId);
    if (current.observation === "unavailable") return { status: "unavailable", reason: current.reason };
    const activityIds = current.activities.filter((activity) => ["running", "waiting", "stopping", "unknown"].includes(activity.status)).map((activity) => activity.id);
    if (current.principalProcessing) activityIds.push(rootId);
    return activityIds.length ? { status: "pending", activityIds } : { status: "settled", observedAt: current.observedAt };
  }

  private async stopThread(threadId: string): Promise<void> {
    const { runtime } = this.resolve();
    const turns = await runtime.rpc.request("thread/turns/list", { threadId, limit: 20, sortDirection: "desc" });
    const active = turns.data.find((turn) => turn.status === "inProgress");
    if (active) await runtime.rpc.request("turn/interrupt", { threadId, turnId: active.id });
    const terminals = await runtime.rpc.request("thread/backgroundTerminals/list", { threadId });
    for (const terminal of terminals.data) await runtime.rpc.request("thread/backgroundTerminals/terminate", { threadId, processId: terminal.processId });
  }
}
