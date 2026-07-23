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
    expect(event.tool["input"]).toBeUndefined();
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
    expect(recording.resources).toEqual([]);
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
