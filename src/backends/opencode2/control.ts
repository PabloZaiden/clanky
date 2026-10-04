/**
 * Native session and shell controls with lineage and session metadata ownership.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type { OpenCodeClient } from "@opencode/client";
import type {
  HarnessActivity, HarnessActivitySnapshot, HarnessActivityStopResult, HarnessCapabilities, HarnessCleanupResult,
  HarnessControl, HarnessInputAdmission, HarnessInputRecoveryRequest, HarnessSteerRequest,
} from "@/shared/harness-control";
import { HarnessError } from "../harness-errors";
import type { OpenCodeSessionService } from "./session-service";
import { toOpenCodePrompt } from "./prompt";

const log = createLogger("opencode2-control");

export class OpenCodeControl implements HarnessControl {
  readonly capabilities: HarnessCapabilities = {
    adapter: "opencode2", experimental: true, activity: "native", steering: "active-session",
    stopScopes: ["child-execution", "command"],
    questionPolicy: "session",
  };
  constructor(private readonly resolve: () => { client: OpenCodeClient; sessions: OpenCodeSessionService; directory: string }) {}

  async getActivity(rootId: string): Promise<HarnessActivitySnapshot> {
    const { client, sessions, directory } = this.resolve();
    sessions.get(rootId);
    await sessions.reconcileDescendants(rootId);
    const [active, shells] = await Promise.all([client.session.active(), client.shell.list({ location: { directory } })]);
    const descendants = sessions.descendants(rootId);
    const owned = new Set([rootId, ...descendants.map((session) => session.id)]);
    const activities: HarnessActivity[] = descendants.map((session) => ({
      id: session.id, parentId: session.parentID === rootId ? undefined : session.parentID,
      kind: "subagent", description: session.title ?? session.agent ?? "Subagent",
      status: active[session.id] ? "running" : session.outcome === "failed" ? "failed" : session.outcome === "interrupted" ? "stopped" : "idle",
      ownership: "owned", workspaceWrites: "possible",
      requestedModel: session.model?.id,
      native: { adapter: "opencode2", conversationId: session.id, activityId: session.id },
    }));
    for (const shell of shells.data) {
      const owner: unknown = shell.metadata["sessionID"];
      const isOwned = typeof owner === "string" && owned.has(owner);
      activities.push({
        id: `shell:${shell.id}`, parentId: isOwned && owner !== rootId ? owner : undefined,
        kind: isOwned ? "process" : "external", description: shell.command.slice(0, 4096),
        status: shell.status === "running" ? "running" : shell.status === "killed" ? "stopped" : shell.status === "timeout" ? "failed" : "completed",
        ownership: isOwned ? "owned" : "unverified", workspaceWrites: "possible",
        native: { adapter: "opencode2", conversationId: typeof owner === "string" ? owner : undefined, commandId: shell.id },
      });
    }
    if (activities.length > 2000) throw new HarnessError("harness_event_gap", "Native activity observation capacity reached.");
    return { observation: "available", coverage: "native", observedAt: new Date().toISOString(), principalProcessing: active[rootId] !== undefined, activities };
  }

  async abort(rootId: string): Promise<void> {
    const { client, sessions } = this.resolve();
    sessions.get(rootId);
    await client.session.interrupt({ sessionID: rootId });
  }
  async stopActivity(rootId: string, activityId: string): Promise<HarnessActivityStopResult> {
    const snapshot = await this.getActivity(rootId);
    const activity = snapshot.observation === "available" ? snapshot.activities.find((entry) => entry.id === activityId) : undefined;
    if (!activity || activity.ownership !== "owned") throw new HarnessError("harness_activity_not_owned", "The native activity has no owned control scope.");
    const { client, directory } = this.resolve();
    const stoppedSessions = new Set<string>();
    if (activity.kind === "process") {
      await client.shell.remove({ id: activity.native.commandId!, location: { directory } });
    } else {
      stoppedSessions.add(activity.id);
      if (snapshot.observation === "available") {
        let previousSize = 0;
        while (previousSize !== stoppedSessions.size) {
          previousSize = stoppedSessions.size;
          for (const child of snapshot.activities) if (child.kind === "subagent" && child.parentId && stoppedSessions.has(child.parentId)) stoppedSessions.add(child.id);
        }
      }
      for (const sessionID of stoppedSessions) await client.session.interrupt({ sessionID });
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = await this.getActivity(rootId);
      if (current.observation === "unavailable") return { status: "unknown", activityId };
      if (activity.kind === "process") {
        if (!current.activities.some((entry) => entry.id === activityId && entry.status === "running")) return { status: "stopped", activityId };
      } else {
        const remaining = current.activities.some((entry) =>
          (stoppedSessions.has(entry.id) || (entry.parentId && stoppedSessions.has(entry.parentId))) && entry.status === "running",
        );
        if (!remaining) return { status: "stopped", activityId };
      }
      await Bun.sleep(100);
    }
    return { status: "stopping", activityId };
  }

  async steer(rootId: string, request: HarnessSteerRequest): Promise<HarnessInputAdmission> {
    const { client, sessions } = this.resolve();
    sessions.get(rootId);
    if (request.expectedTurnId) return { status: "rejected", inputId: request.inputId, code: "turn-changed" };
    if (request.prompt.model) throw new HarnessError("harness_invalid_model_option", "Steering cannot change the active model.");
    if (!(await client.session.active())[rootId]) return { status: "rejected", inputId: request.inputId, code: "not-running" };
    try {
      const admitted = await client.session.prompt({ sessionID: rootId, delivery: "steer", ...toOpenCodePrompt(request.prompt) });
      return { status: "accepted", inputId: request.inputId, nativeMessageId: admitted.id };
    } catch {
      log.warn("Native steering admission is unknown", { inputId: request.inputId });
      return { status: "unknown", inputId: request.inputId };
    }
  }
  async reconcileInput(rootId: string, request: HarnessInputRecoveryRequest): Promise<HarnessInputAdmission> {
    const { client, sessions } = this.resolve();
    sessions.get(rootId);
    if (!request.nativeMessageId) return { status: "unknown", inputId: request.inputId };
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const history = await client.message.list({ sessionID: rootId, order: "desc", limit: 100, cursor, type: "user" });
      if (history.data.some((message) => message.id === request.nativeMessageId)) {
        return { status: "delivered", inputId: request.inputId, nativeMessageId: request.nativeMessageId };
      }
      if (!history.cursor.next) break;
      cursor = history.cursor.next;
    }
    return { status: "unknown", inputId: request.inputId };
  }
  async settleOwnedWork(rootId: string): Promise<HarnessCleanupResult> {
    await this.abort(rootId);
    const snapshot = await this.getActivity(rootId);
    if (snapshot.observation === "unavailable") return { status: "unavailable", reason: snapshot.reason };
    for (const activity of snapshot.activities) if (activity.ownership === "owned" && activity.kind === "subagent" && activity.status === "running") await this.stopActivity(rootId, activity.id);
    const currentShells = await this.getActivity(rootId);
    if (currentShells.observation === "unavailable") return { status: "unavailable", reason: currentShells.reason };
    for (const activity of currentShells.activities) if (activity.ownership === "owned" && activity.kind === "process" && activity.status === "running") await this.stopActivity(rootId, activity.id);
    const current = await this.getActivity(rootId);
    if (current.observation === "unavailable") return { status: "unavailable", reason: current.reason };
    const activityIds = current.activities.filter((activity) => activity.ownership === "owned" && activity.status === "running").map((activity) => activity.id);
    if (current.principalProcessing) activityIds.push(rootId);
    return activityIds.length ? { status: "pending", activityIds } : { status: "settled", observedAt: current.observedAt };
  }
}
