import { createLogger } from "@pablozaiden/webapp/server";
import type { Backend } from "../backends/types";
import type { HarnessActivity, HarnessActivitySnapshot, HarnessConversationBinding } from "@/shared/harness-control";
import type { HarnessEvent } from "@/shared/harness-events";
import type { Subagent, SubagentContext } from "@/shared/subagent";
import type { PersistedMessage, TaskLogEntry, ToolCallRecord, TranscriptEntryUpsert, TranscriptStreamEvent, StreamPosition } from "@/shared";
import { createToolCallSummary, mergeToolCallRecord } from "@/shared";
import { HarnessError } from "../backends/harness-errors";
import { getSubagentLog, listSubagents, retainSubagent, updateSubagent, writeSubagentEntry } from "../persistence/subagents";
import { subagentTranscriptStore } from "../persistence/transcripts/subagent-store";
import { KeyedOperationQueue } from "../utils/keyed-operation-queue";
import { StreamVersion } from "./stream-version";
import { subagentEventEmitter } from "./event-emitter";
import { requireExecutionOwnerUser, runWithExecutionOwner } from "../context/user-context";

const log = createLogger("subagent-transcripts");
const livePositions = new Map<string, StreamVersion>();

export function getSubagentStreamPosition(id: string): StreamPosition | undefined {
  return livePositions.get(id)?.position;
}

interface Child {
  record: Subagent;
  version: StreamVersion;
  recovered: boolean;
  recoveryFailures: number;
  nextRecoveryAt: number;
}

type CaptureBackend = Pick<Backend, "harness" | "readSubagentHistory" | "isConnected">;

export class SubagentTranscriptObserver {
  private readonly owner = requireExecutionOwnerUser();
  private readonly children = new Map<string, Child>();
  private readonly operations = new KeyedOperationQueue();
  private restored = false;

  constructor(
    private readonly context: SubagentContext,
    private readonly binding: HarnessConversationBinding,
    private readonly backend: CaptureBackend,
  ) {}

  consume(event: HarnessEvent): Promise<void> {
    return this.operations.run("capture", () => runWithExecutionOwner(this.owner, async () => {
      if (event.type === "activity.changed" && event.activity?.kind === "subagent" && event.activity.ownership === "owned") {
        this.child(event.activity);
      }
      if (event.scope.kind === "child") {
        const child = this.childForEvent(event);
        try {
          this.project(child, event, false);
        } catch (error) {
          log.error("Native child event could not be saved", { subagentId: child.record.id, error: String(error) });
          child.record = updateSubagent(child.record, {
            coverage: "partial", observation: "error", error: "Some native subagent events could not be saved.",
          });
          this.changed(child);
        }
      }
    }));
  }

  reconcile(snapshot: HarnessActivitySnapshot, final = false): Promise<void> {
    return this.operations.run("capture", () => runWithExecutionOwner(this.owner, async () => {
      if (!this.restored) {
        let before: string | undefined;
        do {
          const page = listSubagents(this.context, before);
          for (const record of page.items) {
            if (record.binding.nativeId === this.binding.nativeId && record.binding.adapter === this.binding.adapter
              && JSON.stringify(record.binding.executionHost) === JSON.stringify(this.binding.executionHost)) {
              this.adopt(record);
            }
          }
          before = page.nextCursor;
        } while (before);
        this.restored = true;
      }
      if (snapshot.observation !== "available") {
        this.unavailable(snapshot.reason === "unsupported" ? "unsupported" : "disconnected");
        return;
      }
      for (const activity of snapshot.activities) {
        if (activity.kind === "subagent" && activity.ownership === "owned") this.child(activity);
      }
      for (const child of this.children.values()) {
        if (final || !child.recovered && Date.now() >= child.nextRecoveryAt) await this.recover(child);
      }
    }));
  }

  disconnect(): Promise<void> {
    return this.operations.run("capture", () => runWithExecutionOwner(this.owner, async () => {
      try {
        this.unavailable("disconnected");
      } finally {
        for (const child of this.children.values()) livePositions.delete(child.record.id);
        this.children.clear();
      }
    }));
  }

  private adopt(record: Subagent): Child {
    const existing = this.children.get(record.activity.id);
    if (existing) return existing;
    if (this.children.size >= 1000) throw new HarnessError("harness_event_gap", "The captured native child graph exceeded its limit.");
    const child: Child = { record, version: new StreamVersion(), recovered: false, recoveryFailures: 0, nextRecoveryAt: 0 };
    this.children.set(record.activity.id, child);
    livePositions.set(record.id, child.version);
    this.changed(child);
    return child;
  }

  private child(activity: HarnessActivity): Child {
    const child = this.children.get(activity.id) ?? this.adopt(retainSubagent(this.context, this.binding, activity));
    const previous = child.record.activity;
    activity = { ...activity, parentId: activity.parentId ?? previous.parentId,
      spawningToolCallId: activity.spawningToolCallId ?? previous.spawningToolCallId };
    if (JSON.stringify(previous) !== JSON.stringify(activity) || child.record.observation !== "connected") {
      if (previous.status !== activity.status) {
        child.recovered = false;
        child.nextRecoveryAt = 0;
      }
      child.record = updateSubagent(child.record, { activity, observation: "connected" });
      this.changed(child);
    }
    return child;
  }

  private childForEvent(event: HarnessEvent): Child {
    if (event.scope.kind !== "child") throw new HarnessError("harness_event_gap", "Child capture requires an identified native actor.");
    const known = this.children.get(event.scope.activityId);
    if (known) return known;
    return this.child({
      id: event.scope.activityId, kind: "subagent", description: "Subagent",
      status: "unknown", ownership: "owned", workspaceWrites: "unknown",
      native: { adapter: this.binding.adapter, ...event.scope.native, activityId: event.scope.activityId },
    });
  }

  private async recover(child: Child): Promise<void> {
    if (!this.backend.readSubagentHistory || this.backend.harness.capabilities.subagentHistory !== "completed") {
      child.record = updateSubagent(child.record, { coverage: "partial", observation: "unsupported" });
      child.recovered = true;
      this.changed(child);
      return;
    }
    try {
      let cursor: string | undefined;
      let processing = false;
      let incomplete = false;
      const reasoning = new Map<string, string>();
      do {
        const page = await this.backend.readSubagentHistory(this.binding.nativeId, child.record.activity.id, cursor);
        processing = page.processing;
        for (let event of page.events) {
          if (event.scope.kind !== "child" || event.scope.activityId !== child.record.activity.id) {
            throw new HarnessError("harness_session_not_owned", "Native history returned content from another actor.");
          }
          if (event.type === "reasoning.delta") {
            if (!event.reasoningId) throw new HarnessError("harness_event_gap", "The native child reasoning has no identity.");
            if (!reasoning.has(event.reasoningId) && reasoning.size >= 1000) {
              throw new HarnessError("harness_event_gap", "Too many native child reasoning records.");
            }
            const content = event.complete ? event.content : `${reasoning.get(event.reasoningId) ?? ""}${event.content}`;
            reasoning.set(event.reasoningId, content);
            event = { ...event, content };
          }
          incomplete ||= event.type === "error" || event.type === "request.error";
          this.project(child, event, true);
        }
        cursor = page.nextCursor;
      } while (cursor);
      child.record = updateSubagent(child.record, {
        coverage: incomplete || processing || child.record.unfinishedMessageIds?.length ? "partial" : "complete",
        observation: "connected", error: undefined,
      });
      child.recovered = true;
      child.recoveryFailures = 0;
      child.nextRecoveryAt = 0;
    } catch (error) {
      log.warn("Native child history recovery failed", {
        subagentId: child.record.id, code: error instanceof HarnessError ? error.code : "harness_request_failed",
      });
      const unsupported = error instanceof HarnessError && error.code === "harness_unsupported_feature";
      child.record = updateSubagent(child.record, {
        coverage: "partial", observation: unsupported ? "unsupported" : "error",
        error: "Some native subagent history could not be recovered.",
      });
      child.recovered = unsupported;
      child.recoveryFailures = Math.min(child.recoveryFailures + 1, 6);
      child.nextRecoveryAt = Date.now() + Math.min(30_000, 1000 * 2 ** child.recoveryFailures);
    }
    this.changed(child);
  }

  private project(child: Child, event: HarnessEvent, recovered: boolean): void {
    const timestamp = event.timestamp ?? new Date().toISOString();
    const store = subagentTranscriptStore;
    const userId = this.binding.ownerId;
    if (event.type === "message.start" || event.type === "message.delta" || event.type === "message.complete") {
      if (!event.messageId) throw new HarnessError("harness_event_gap", "The native child message has no identity.");
      const previous = store.getMessageForUser(child.record.id, userId, event.messageId);
      const pending = new Set(child.record.unfinishedMessageIds ?? []);
      if (event.type !== "message.complete" && previous && !pending.has(event.messageId)) return;
      if (event.type === "message.start") {
        if (pending.size >= 1000) throw new HarnessError("harness_event_gap", "Too many unfinished child messages.");
        pending.add(event.messageId);
      } else if (event.type === "message.complete") pending.delete(event.messageId);
      else pending.add(event.messageId);
      child.record = { ...child.record, unfinishedMessageIds: [...pending] };
      const message: PersistedMessage = {
        id: event.messageId, role: "assistant", timestamp: previous?.timestamp ?? timestamp,
        content: event.type === "message.start" ? previous?.content ?? ""
          : event.type === "message.delta" ? `${previous?.content ?? ""}${event.content}` : event.content,
        attachments: event.type === "message.complete" ? event.attachments ?? previous?.attachments : previous?.attachments,
      };
      this.write(child, { id: message.id, kind: "message", timestamp: message.timestamp, payload: message },
        event.type === "message.delta" ? {
          type: "transcript.message.delta", messageId: message.id, role: "assistant",
          delta: event.content, baseLength: previous?.content.length ?? 0, messageTimestamp: message.timestamp,
        } : { type: "transcript.message", message });
    } else if (event.type === "user.message") {
      const id = event.messageId ?? event.scope.native?.messageId ?? event.sourceEventId;
      if (!id) throw new HarnessError("harness_event_gap", "The native child input has no identity.");
      const previous = store.getMessageForUser(child.record.id, userId, id);
      const message: PersistedMessage = { id, role: "user", content: event.content, timestamp: previous?.timestamp ?? timestamp };
      this.write(child, { id, kind: "message", timestamp: message.timestamp, payload: message }, { type: "transcript.message", message });
    } else if (event.type === "reasoning.delta") {
      if (!event.reasoningId) throw new HarnessError("harness_event_gap", "The native child reasoning has no identity.");
      const id = `reasoning:${event.reasoningId}`;
      const previous = getSubagentLog(child.record.id, id);
      if (!event.complete && previous?.details?.["complete"] === true) return;
      const oldText = previous?.details?.["responseContent"];
      const content = recovered || event.complete
        ? !event.complete && typeof oldText === "string" && oldText.startsWith(event.content) ? oldText : event.content
        : `${typeof oldText === "string" ? oldText : ""}${event.content}`;
      const entry: TaskLogEntry = {
        id, level: "agent", message: "AI reasoning...", timestamp: previous?.timestamp ?? timestamp,
        details: { logKind: "reasoning", responseContent: content, complete: event.complete === true },
      };
      this.write(child, { id, kind: "log", timestamp: entry.timestamp, payload: entry }, { type: "transcript.log", log: entry });
    } else if (event.type === "tool.start" || event.type === "tool.complete") {
      if (!event.toolCallId) throw new HarnessError("harness_event_gap", "The native child tool has no identity.");
      const previous = store.getToolCallForUser(child.record.id, userId, event.toolCallId);
      if (event.type === "tool.start" && previous?.status === "completed") return;
      const tool: ToolCallRecord = mergeToolCallRecord(previous ?? undefined, {
        id: event.toolCallId, name: event.toolName, input: event.input ?? previous?.input,
        output: event.type === "tool.complete" ? event.output : previous?.output,
        status: event.type === "tool.complete" ? "completed" : "running", timestamp: previous?.timestamp ?? timestamp,
      });
      this.write(child, { id: tool.id, kind: "tool", timestamp: tool.timestamp, payload: tool },
        { type: "transcript.tool", tool: createToolCallSummary(tool) });
    } else if (event.type === "error" || event.type === "request.error") {
      const entry: TaskLogEntry = {
        id: event.sourceEventId ?? crypto.randomUUID(), timestamp, level: "error", message: event.message,
        details: { logKind: "subagent-error" },
      };
      this.write(child, { id: entry.id, kind: "log", timestamp, payload: entry }, { type: "transcript.log", log: entry });
      child.record = updateSubagent(child.record, {
        ...(event.type === "error" ? { activity: { ...child.record.activity, status: "failed" as const } } : {}),
        coverage: "partial",
      });
      this.changed(child);
    } else if (event.type === "question.asked" || event.type === "question.resolved" || event.type === "permission.asked") {
      const entry: TaskLogEntry = {
        id: `interaction:${event.requestId}:${event.type}`, timestamp, level: "agent",
        details: { logKind: "interaction" },
        message: event.type === "question.asked"
          ? `${event.questions.map((question) => question.question).join("\n")}\nAnswer in the parent conversation.`
          : event.type === "permission.asked" ? `Permission requested: ${event.permission}. Managed by the parent conversation.`
            : `Question ${event.outcome}.`,
      };
      this.write(child, { id: entry.id, kind: "log", timestamp, payload: entry }, { type: "transcript.log", log: entry });
    } else if (!recovered && (event.type === "prompt.complete" || event.type === "session.status")) {
      const status = event.type === "prompt.complete" ? event.outcome === "interrupted" ? "stopped" : "idle"
        : event.status === "idle" ? "idle" : "running";
      child.record = updateSubagent(child.record, { activity: { ...child.record.activity, status } });
      child.recovered = false;
      this.changed(child);
    }
  }

  private write(child: Child, entry: TranscriptEntryUpsert, event: TranscriptStreamEvent): void {
    writeSubagentEntry(child.record, entry);
    child.version.advance();
    subagentEventEmitter.emit({
      type: "subagent.transcript", subagentId: child.record.id, chatId: child.record.chatId, taskId: child.record.taskId,
      timestamp: new Date().toISOString(), event, streamPosition: child.version.change,
    }, { userId: this.binding.ownerId });
  }

  private changed(child: Child): void {
    subagentEventEmitter.emit({
      type: "subagent.changed", subagentId: child.record.id, chatId: child.record.chatId, taskId: child.record.taskId,
      timestamp: new Date().toISOString(),
    }, { userId: this.binding.ownerId });
  }

  private unavailable(observation: Subagent["observation"]): void {
    for (const child of this.children.values()) {
      child.recovered = false;
      child.record = updateSubagent(child.record, { observation });
      this.changed(child);
    }
  }
}
