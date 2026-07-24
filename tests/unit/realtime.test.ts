import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { RealtimeBus, type WebSocketData } from "@pablozaiden/webapp/server";
import { isServerEvent } from "../../src/core/backend/backend-state";
import {
  CLANKY_REALTIME_RESOURCES,
  createClankyRealtimePublisher,
  publishClankyDomainEvent,
  type ClankyRealtimeEvent,
  type ClankyRealtimePublisher,
} from "../../src/realtime";
import {
  mergeTranscriptPages,
  mergeTranscriptRecords,
  mergeTranscriptSnapshot,
  mergeTranscriptSnapshotRecords,
  mergeTranscriptToolCalls,
} from "../../src/shared/chat-transcript";
import { createToolCallSummary, isToolCallDetailsStale } from "../../src/shared/tool-call";

interface PublishedResource {
  ownerId: string;
  resource: string;
  action: "changed" | "deleted";
  id?: string;
  scope?: string;
}

interface PublishedStream {
  ownerId: string;
  type: string;
  target: Record<string, string | undefined>;
}

function createRecordingPublisher(): {
  publisher: ClankyRealtimePublisher;
  resources: PublishedResource[];
  streams: PublishedStream[];
} {
  const resources: PublishedResource[] = [];
  const streams: PublishedStream[] = [];
  return {
    publisher: {
      publishResource(owner, publication) {
        resources.push({
          ownerId: owner.userId,
          resource: publication.resource,
          action: publication.action,
          id: publication.id,
          scope: publication.scope,
        });
      },
      publishStream(owner, event, target) {
        streams.push({
          ownerId: owner.userId,
          type: event.type,
          target,
        });
      },
    },
    resources,
    streams,
  };
}

function createSocket(userId: string, filters?: Record<string, string>): {
  socket: ServerWebSocket<WebSocketData>;
  messages: string[];
} {
  const messages: string[] = [];
  const socket = {
    data: { userId, filters },
    send(message: string): number {
      messages.push(message);
      return message.length;
    },
  } as unknown as ServerWebSocket<WebSocketData>;
  return { socket, messages };
}

describe("Clanky realtime migration", () => {
  test("classifies backend server events before domain publication", () => {
    expect(isServerEvent({ type: "server.reset" })).toBe(true);
    expect(isServerEvent({ type: "task.started" })).toBe(false);
  });

  test("maps lifecycle events to owner-targeted resource invalidations", () => {
    const recording = createRecordingPublisher();

    publishClankyDomainEvent(recording.publisher, {
      type: "task.started",
      taskId: "task-1",
      iteration: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
    }, { userId: "user-1" });

    expect(recording.resources).toEqual([{
      ownerId: "user-1",
      resource: CLANKY_REALTIME_RESOURCES.tasks,
      action: "changed",
      id: "task-1",
      scope: undefined,
    }]);
    expect(recording.streams).toEqual([]);
  });

  test("retains incremental events while also invalidating authoritative state", () => {
    const recording = createRecordingPublisher();

    publishClankyDomainEvent(recording.publisher, {
      type: "task.iteration.end",
      taskId: "task-1",
      iteration: 2,
      outcome: "complete",
      timestamp: "2026-01-01T00:00:00.000Z",
    }, { userId: "user-1" });

    expect(recording.streams).toEqual([{
      ownerId: "user-1",
      type: "task.iteration.end",
      target: { taskId: "task-1" },
    }]);
    expect(recording.resources).toEqual([{
      ownerId: "user-1",
      resource: CLANKY_REALTIME_RESOURCES.tasks,
      action: "changed",
      id: "task-1",
      scope: undefined,
    }]);
  });

  test("retains chat status events while also invalidating authoritative chat state", () => {
    const recording = createRecordingPublisher();

    publishClankyDomainEvent(recording.publisher, {
      type: "chat.status",
      chatId: "chat-1",
      scope: "workspace",
      status: "idle",
      timestamp: "2026-01-01T00:00:00.000Z",
    }, { userId: "user-1" });

    expect(recording.streams).toEqual([{
      ownerId: "user-1",
      type: "chat.status",
      target: { chatId: "chat-1" },
    }]);
    expect(recording.resources).toEqual([{
      ownerId: "user-1",
      resource: CLANKY_REALTIME_RESOURCES.chats,
      action: "changed",
      id: "chat-1",
      scope: undefined,
    }]);
  });

  test("publishes chat tool events without tool payloads", () => {
    const events: unknown[] = [];
    const publisher: ClankyRealtimePublisher = {
      publishResource() {},
      publishStream(_owner, event) {
        events.push(event);
      },
    };

    publishClankyDomainEvent(publisher, {
      type: "chat.tool_call",
      chatId: "chat-1",
      scope: "workspace",
      tool: {
        id: "tool-1",
        name: "Read",
        input: { filePath: "src/index.ts" },
        output: { content: "x".repeat(10_000) },
        status: "completed",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      timestamp: "2026-01-01T00:00:00.000Z",
    }, { userId: "user-1" });

    const event = events[0] as {
      tool: Record<string, unknown>;
    };
    expect(event.tool["id"]).toBe("tool-1");
    expect(event.tool["detailAvailable"]).toBe(true);
    expect(event.tool["input"]).toEqual({ filePath: "src/index.ts" });
    expect(event.tool["output"]).toBeUndefined();
  });

  test("does not stream chat tool extras containing image bytes", () => {
    const recording = createRecordingPublisher();

    publishClankyDomainEvent(recording.publisher, {
      type: "chat.tool_call.extra",
      chatId: "chat-1",
      scope: "workspace",
      toolId: "tool-1",
      extra: {
        id: "preview-1",
        type: "image_preview",
        image: {
          id: "image-1",
          filename: "preview.png",
          mimeType: "image/png",
          data: "base64-image-data",
          size: 17,
        },
      },
      timestamp: "2026-01-01T00:00:01.000Z",
    }, { userId: "user-1" });

    expect(recording.streams).toEqual([]);
    expect(recording.resources).toEqual([{
      ownerId: "user-1",
      resource: CLANKY_REALTIME_RESOURCES.chats,
      action: "changed",
      id: "chat-1",
      scope: undefined,
    }]);
  });

  test("marks lazy tool details stale when the server detail revision changes", () => {
    const summary = createToolCallSummary({
      id: "tool-1",
      name: "Read",
      input: { filePath: "src/index.ts" },
      output: { content: "initial" },
      status: "completed",
      timestamp: "2026-01-01T00:00:00.000Z",
      detailRevision: "revision-1",
    });
    const details = {
      id: "tool-1",
      name: "Read",
      input: { filePath: "src/index.ts" },
      output: { content: "initial" },
      status: "completed" as const,
      timestamp: "2026-01-01T00:00:00.000Z",
      detailRevision: "revision-1",
    };

    expect(isToolCallDetailsStale(summary, details)).toBe(false);
    expect(isToolCallDetailsStale(
      { ...summary, detailRevision: "revision-2" },
      details,
    )).toBe(true);
  });

  test("merges newer tool-call summaries without regressing completion status", () => {
    const running = createToolCallSummary({
      id: "tool-1",
      name: "Read",
      input: { filePath: "src/index.ts" },
      status: "running",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const completed = createToolCallSummary({
      id: "tool-1",
      name: "Read",
      input: { filePath: "src/index.ts" },
      output: { content: "done" },
      status: "completed",
      timestamp: "2026-01-01T00:00:01.000Z",
    });

    expect(mergeTranscriptToolCalls([running], [completed])[0]).toMatchObject({
      status: "completed",
      summary: "View src/index.ts",
    });
    expect(mergeTranscriptToolCalls([completed], [running])[0]).toMatchObject({
      status: "completed",
      summary: "View src/index.ts",
    });
  });

  test("sorts transcript records and tool calls deterministically for tied timestamps", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const messages = mergeTranscriptRecords(
      [
        { id: "message-b", role: "user" as const, content: "b", timestamp },
        { id: "message-a", role: "user" as const, content: "a", timestamp },
      ],
      [],
    );
    const toolCalls = mergeTranscriptToolCalls(
      [
        { id: "tool-b", name: "Read", status: "completed" as const, timestamp },
        { id: "tool-a", name: "Read", status: "completed" as const, timestamp },
      ],
      [],
    );

    expect(messages.map((message) => message.id)).toEqual(["message-a", "message-b"]);
    expect(toolCalls.map((toolCall) => toolCall.id)).toEqual(["tool-a", "tool-b"]);
  });

  test("preserves loaded older transcript pages during snapshot refresh", () => {
    const current = {
      messages: [{
        id: "message-old",
        role: "user" as const,
        content: "old",
        timestamp: "2026-01-01T00:00:00.000Z",
      }],
      logs: [],
      toolCalls: [],
      hasOlder: true,
      nextCursor: "cursor-before-old",
      revision: "revision-old",
      totalEntries: 100,
    };
    const incoming = {
      messages: [{
        id: "message-new",
        role: "assistant" as const,
        content: "new",
        timestamp: "2026-01-01T00:00:01.000Z",
      }],
      logs: [],
      toolCalls: [],
      hasOlder: false,
      nextCursor: undefined,
      revision: "revision-new",
      totalEntries: 101,
    };

    expect(mergeTranscriptPages(current, incoming)).toEqual({
      messages: [...current.messages, ...incoming.messages],
      logs: [],
      toolCalls: [],
      hasOlder: true,
      nextCursor: "cursor-before-old",
      revision: "revision-new",
      totalEntries: 101,
    });
  });

  test("uses full snapshots to repair stale records while retaining newer live records", () => {
    const current = {
      messages: [
        {
          id: "message-stale",
          role: "assistant" as const,
          content: "partial",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "message-deleted",
          role: "user" as const,
          content: "deleted",
          timestamp: "2025-12-31T23:59:59.000Z",
        },
        {
          id: "message-live",
          role: "assistant" as const,
          content: "live",
          timestamp: "2026-01-01T00:00:02.000Z",
        },
      ],
      logs: [],
      toolCalls: [],
      hasOlder: true,
      revision: "revision-old",
      totalEntries: 3,
    };
    const incoming = {
      messages: [
        {
          id: "message-stale",
          role: "assistant" as const,
          content: "canonical",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
      logs: [],
      toolCalls: [],
      hasOlder: false,
      revision: "revision-new",
      totalEntries: 1,
    };

    expect(mergeTranscriptSnapshot(current, incoming).messages).toEqual([
      incoming.messages[0]!,
      current.messages[2]!,
    ]);
    expect(mergeTranscriptSnapshotRecords(
      current.messages,
      incoming.messages,
    )).not.toContainEqual(current.messages[1]);
  });

  test("invalidates the task resource when an iteration starts", () => {
    const recording = createRecordingPublisher();

    publishClankyDomainEvent(recording.publisher, {
      type: "task.iteration.start",
      taskId: "task-1",
      iteration: 3,
      timestamp: "2026-01-01T00:00:00.000Z",
    }, { userId: "user-1" });

    expect(recording.streams).toEqual([{
      ownerId: "user-1",
      type: "task.iteration.start",
      target: { taskId: "task-1" },
    }]);
    expect(recording.resources).toEqual([{
      ownerId: "user-1",
      resource: CLANKY_REALTIME_RESOURCES.tasks,
      action: "changed",
      id: "task-1",
      scope: undefined,
    }]);
  });

  test("publishes scoped run and preview changes with stable resource identities", () => {
    const recording = createRecordingPublisher();

    publishClankyDomainEvent(recording.publisher, {
      type: "agent.run.status",
      agentId: "agent-1",
      agentRunId: "run-1",
      status: "completed",
      timestamp: "2026-01-01T00:00:00.000Z",
    }, { userId: "user-1" });
    publishClankyDomainEvent(recording.publisher, {
      type: "preview.closed",
      previewId: "preview-1",
      workspaceId: "workspace-1",
      preview: {
        config: {
          id: "preview-1",
          workspaceId: "workspace-1",
          remoteHost: "127.0.0.1",
          remotePort: 3000,
          localHost: "127.0.0.1",
          localPort: 3001,
          localUrl: "http://127.0.0.1:3001",
          initialPath: "/",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        state: { status: "closed" },
      },
      timestamp: "2026-01-01T00:00:00.000Z",
    }, { userId: "user-1" });

    expect(recording.resources).toEqual([
      {
        ownerId: "user-1",
        resource: CLANKY_REALTIME_RESOURCES.agentRuns,
        action: "changed",
        id: "run-1",
        scope: "agent-1",
      },
      {
        ownerId: "user-1",
        resource: CLANKY_REALTIME_RESOURCES.agents,
        action: "changed",
        id: "agent-1",
        scope: undefined,
      },
      {
        ownerId: "user-1",
        resource: CLANKY_REALTIME_RESOURCES.previews,
        action: "deleted",
        id: "preview-1",
        scope: "workspace-1",
      },
    ]);
  });

  test("delivers owner-targeted resource events only to matching users and filters", () => {
    const bus = new RealtimeBus<ClankyRealtimeEvent>();
    const userOne = createSocket("user-1", { resource: "tasks", id: "task-1" });
    const userTwo = createSocket("user-2", { resource: "tasks", id: "task-1" });
    const otherTask = createSocket("user-1", { resource: "tasks", id: "task-2" });
    bus.add(userOne.socket);
    bus.add(userTwo.socket);
    bus.add(otherTask.socket);

    createClankyRealtimePublisher(bus).publishResource(
      { userId: "user-1" },
      {
        resource: CLANKY_REALTIME_RESOURCES.tasks,
        action: "changed",
        id: "task-1",
      },
    );

    expect(userOne.messages).toHaveLength(1);
    expect(userTwo.messages).toHaveLength(0);
    expect(otherTask.messages).toHaveLength(0);
    expect(JSON.parse(userOne.messages[0] as string)).toEqual({
      type: "event",
      event: {
        type: "tasks.changed",
        resource: "tasks",
        action: "changed",
        id: "task-1",
      },
    });
  });

  test("rejects unaddressable deleted resource publications", () => {
    const publisher = createClankyRealtimePublisher(new RealtimeBus<ClankyRealtimeEvent>());

    expect(() => publisher.publishResource(
      { userId: "user-1" },
      {
        resource: CLANKY_REALTIME_RESOURCES.tasks,
        action: "deleted",
      },
    )).toThrow("Deleted realtime publication requires an id");
  });
});
