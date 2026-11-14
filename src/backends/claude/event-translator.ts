import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessEvent, HarnessEventPayload, HarnessEventScope } from "@/shared/harness-events";
import type { HarnessActivity } from "@/shared/harness-control";
import { projectProviderImageOutput, redactProviderImagePayloads } from "../provider-image-output";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ClaudeEventTranslator {
  readonly activities = new Map<string, HarnessActivity>();
  private readonly tools = new Map<string, { name: string; input: unknown }>();
  private readonly streamed = new Map<string, string>();
  private readonly started = new Set<string>();
  private readonly finished = new Set<string>();
  private readonly snapshots = new Map<string, { id: string; text: string }>();
  private readonly reasoning = new Set<string>();
  private readonly streamIds = new Map<string, string>();
  private backgroundIds = new Set<string>();
  private sequence = 0;
  processing = false;
  interrupted = false;
  coverage: "partial" | "native" = "native";

  constructor(private readonly sessionId: string) {}

  translate(message: SDKMessage): HarnessEvent[] {
    const scope = this.scope(message);
    const wrap = (event: HarnessEventPayload): HarnessEvent => ({
      ...event, scope, sourceSequence: ++this.sequence,
      sourceEventId: `${message.uuid}:${this.sequence}`,
      timestamp: "timestamp" in message && typeof message.timestamp === "string" ? message.timestamp : undefined,
    });
    if (message.type === "stream_event") {
      const event = message.event;
      const key = this.scopeKey(scope);
      if (event.type === "message_start") {
        this.streamIds.set(key, event.message.id);
        this.streamed.set(event.message.id, "");
        return [];
      }
      const messageId = this.streamIds.get(key);
      if (event.type === "content_block_delta" && messageId) {
        if (event.delta.type === "text_delta") {
          const start = !this.started.has(messageId);
          this.started.add(messageId);
          this.streamed.set(messageId, (this.streamed.get(messageId) ?? "") + event.delta.text);
          return [
            ...(start ? [wrap({ type: "message.start", messageId })] : []),
            wrap({ type: "message.delta", messageId, content: event.delta.text }),
          ];
        }
        if (event.delta.type === "thinking_delta") {
          const reasoningId = `${messageId}:${event.index}`;
          this.reasoning.add(reasoningId);
          return [wrap({ type: "reasoning.delta", reasoningId, content: event.delta.thinking })];
        }
      }
      if (event.type === "message_stop" && messageId) {
        const text = this.streamed.get(messageId) ?? "";
        const visible = this.started.delete(messageId);
        this.streamed.delete(messageId);
        this.streamIds.delete(key);
        this.finished.add(messageId);
        if (this.finished.size > 256) this.finished.delete(this.finished.values().next().value!);
        return visible ? [wrap({ type: "message.complete", messageId, content: text })] : [];
      }
      return [];
    }
    if (message.type === "assistant") {
      if (message.error) return [wrap({ type: "error", code: "harness_request_failed", message: `Claude inference failed: ${message.error}.` })];
      return this.content(message.message.content, message.message.id, scope, wrap);
    }
    if (message.type === "user") {
      return this.userContent(message.message.content, message.tool_use_result, wrap);
    }
    if (message.type === "result") {
      this.processing = (message.queued_turn_count ?? 0) > 0;
      if (message.is_error) {
        if (this.interrupted) {
          this.interrupted = false;
          return [wrap({ type: "prompt.complete", outcome: "interrupted" })];
        }
        return [wrap({ type: "error", code: "harness_request_failed", message: message.subtype === "success" ? message.result : message.errors.join("\n") })];
      }
      const interrupted = this.interrupted;
      this.interrupted = false;
      return [wrap({ type: "prompt.complete", outcome: interrupted ? "interrupted" : "completed" })];
    }
    if (message.type === "system") {
      if (message.subtype === "task_started") {
        const activity: HarnessActivity = {
          id: message.task_id, parentId: message.parent_task_id,
          spawningToolCallId: message.tool_use_id,
          kind: message.task_type === "local_agent" ? "subagent" : message.task_type === "local_bash" ? "process" : "external",
          description: message.description, status: "running",
          ownership: !message.ambient && (message.task_type === "local_agent" || message.task_type === "local_bash") ? "owned" : "unverified",
          workspaceWrites: "possible",
          native: { adapter: "claude", conversationId: this.sessionId, activityId: message.task_id },
        };
        this.activities.set(activity.id, activity);
        return [wrap({ type: "activity.changed", activity })];
      }
      if (message.subtype === "task_progress") {
        const activity = this.activities.get(message.task_id);
        if (activity) {
          activity.lastActivity = message.summary ?? message.description;
          return [wrap({ type: "activity.changed", activity: { ...activity } })];
        }
      }
      if (message.subtype === "task_notification" || message.subtype === "task_updated") {
        const activity = this.activities.get(message.task_id);
        if (activity) {
          if (message.subtype === "task_notification") {
            activity.status = message.status;
            activity.lastActivity = message.summary;
          } else {
            const status = message.patch.status;
            if (status) activity.status = status === "pending" ? "queued" : status === "killed" ? "stopped" : status === "paused" ? "waiting" : status;
            if (message.patch.description) activity.description = message.patch.description;
          }
          return [wrap({ type: "activity.changed", activity: { ...activity } })];
        }
      }
      if (message.subtype === "background_tasks_changed") {
        const live = new Set(message.tasks.map((task) => task.task_id));
        for (const task of message.tasks) {
          if (this.activities.has(task.task_id)) continue;
          this.activities.set(task.task_id, {
            id: task.task_id, parentId: task.parent_task_id,
            kind: task.task_type === "local_agent" ? "subagent" : task.task_type === "local_bash" ? "process" : "external",
            description: task.description, status: "running",
            ownership: !task.ambient && (task.task_type === "local_agent" || task.task_type === "local_bash") ? "owned" : "unverified",
            workspaceWrites: "possible",
            native: { adapter: "claude", conversationId: this.sessionId, activityId: task.task_id },
          });
        }
        for (const activity of this.activities.values()) {
          if (this.backgroundIds.has(activity.id) && !live.has(activity.id)
            && ["running", "stopping"].includes(activity.status)) activity.status = "unknown";
        }
        this.backgroundIds = live;
        return [wrap({ type: "activity.changed" })];
      }
    }
    return [];
  }

  history(message: SessionMessage, activityId?: string): HarnessEvent[] {
    const scope: HarnessEventScope = activityId
      ? { kind: "child", activityId, native: { adapter: "claude", conversationId: this.sessionId, activityId } }
      : { kind: "principal", native: { adapter: "claude", conversationId: this.sessionId } };
    const wrap = (event: HarnessEventPayload): HarnessEvent => ({
      ...event, scope, sourceEventId: `${message.uuid}:${++this.sequence}`, sourceSequence: this.sequence,
    });
    if (!isRecord(message.message)) return [];
    if (message.type === "assistant") {
      const id = typeof message.message["id"] === "string" ? message.message["id"] : message.uuid;
      return this.content(message.message["content"], id, scope, wrap);
    }
    if (message.type === "user") {
      const events = this.userContent(message.message["content"], undefined, wrap);
      if (events.length || !activityId) return events;
      const content = message.message["content"];
      const text = typeof content === "string" ? content : Array.isArray(content)
        ? content.filter(isRecord).filter((block) => block["type"] === "text")
          .map((block) => typeof block["text"] === "string" ? block["text"] : "").join("\n")
        : "";
      return text ? [wrap({ type: "user.message", content: text, messageId: message.uuid })] : [];
    }
    return [];
  }

  private content(value: unknown, id: string, scope: HarnessEventScope, wrap: (event: HarnessEventPayload) => HarnessEvent): HarnessEvent[] {
    if (!Array.isArray(value)) return [];
    const events: HarnessEvent[] = [];
    const text = value.filter(isRecord).filter((block) => block["type"] === "text").map((block) => typeof block["text"] === "string" ? block["text"] : "").join("");
    if (text && !this.streamed.has(id) && !this.finished.has(id)) {
      const key = this.scopeKey(scope);
      const previous = this.snapshots.get(key);
      const combined = previous?.id === id ? previous.text + text : text;
      if (previous?.id !== id) events.push(wrap({ type: "message.start", messageId: id }));
      events.push(wrap({ type: "message.complete", messageId: id, content: combined }));
      this.snapshots.set(key, { id, text: combined });
    }
    for (const [index, block] of value.entries()) {
      if (!isRecord(block)) continue;
      if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
        const reasoningId = `${id}:${index}`;
        events.push(wrap({ type: "reasoning.delta", reasoningId, content: this.reasoning.has(reasoningId) ? "" : block["thinking"], complete: true }));
        this.reasoning.delete(reasoningId);
      }
      if (block["type"] === "tool_use" && typeof block["id"] === "string" && typeof block["name"] === "string") {
        if (this.tools.has(block["id"])) continue;
        this.tools.set(block["id"], { name: block["name"], input: block["input"] });
        events.push(wrap({ type: "tool.start", toolCallId: block["id"], toolName: block["name"], input: block["input"] }));
      }
    }
    return events;
  }

  private userContent(content: unknown, structured: unknown, wrap: (event: HarnessEventPayload) => HarnessEvent): HarnessEvent[] {
    if (!Array.isArray(content)) return [];
    const events: HarnessEvent[] = [];
    for (const block of content) {
      if (!isRecord(block) || block["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string") continue;
      const id = block["tool_use_id"];
      const tool = this.tools.get(id);
      if (!tool) {
        events.push(wrap({ type: "error", code: "harness_event_gap", message: "A Claude tool completed without its observed start." }));
        continue;
      }
      this.tools.delete(id);
      const output = structured ?? block["content"];
      const projection = block["is_error"] ? undefined : projectProviderImageOutput(output, `claude-tool:${id}`);
      events.push(wrap({
        type: "tool.complete", toolCallId: id, toolName: tool.name, input: tool.input,
        output: projection?.output ?? redactProviderImagePayloads(output),
      }));
      events.push(...(projection?.events ?? []).map(wrap));
    }
    return events;
  }

  private scope(message: SDKMessage): HarnessEventScope {
    const agentId = "agent_id" in message && typeof message.agent_id === "string" ? message.agent_id : undefined;
    if (agentId) return { kind: "child", activityId: agentId, native: { adapter: "claude", conversationId: this.sessionId, activityId: agentId } };
    const parent = "parent_tool_use_id" in message ? message.parent_tool_use_id : undefined;
    if (parent) {
      const activity = [...this.activities.values()].find((activity) => activity.spawningToolCallId === parent);
      return activity ? { kind: "child", activityId: activity.id, native: activity.native } : { kind: "unknown", native: { adapter: "claude", conversationId: this.sessionId, toolCallId: parent } };
    }
    return { kind: "principal", native: { adapter: "claude", conversationId: this.sessionId } };
  }

  private scopeKey(scope: HarnessEventScope): string {
    return scope.kind === "child" ? scope.activityId : scope.kind;
  }
}
