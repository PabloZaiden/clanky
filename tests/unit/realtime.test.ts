import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { RealtimeBus, type WebSocketData } from "@pablozaiden/webapp/server";

import {
  CLANKY_REALTIME_RESOURCES,
  createClankyRealtimePublisher,
  publishClankyDomainEvent,
  type ClankyRealtimeEvent,
  type ClankyRealtimePublisher,
} from "../../src/realtime";
import type { ExecutionHostBinding, PreviewSession } from "@/shared";

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

function createPreview(
  binding: ExecutionHostBinding,
  targetKind: "workspace" | "server",
  workspaceId?: string,
): PreviewSession {
  return {
    config: {
      id: "preview-1",
      targetKind,
      ...(workspaceId ? { workspaceId } : {}),
      executionHostBinding: binding,
      remoteHost: "localhost",
      remotePort: 3000,
      localHost: "127.0.0.1",
      localPort: 43000,
      localUrl: "http://127.0.0.1:43000/",
      initialPath: "/",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    state: { status: "active" },
  };
}

describe("Clanky realtime migration", () => {

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

  test("scopes workspace and direct server preview invalidations separately", () => {
    const recording = createRecordingPublisher();
    const binding: ExecutionHostBinding = {
      host: { kind: "local", nodeId: "local-node" },
      targetKey: "local:node",
      revision: 2,
    };

    publishClankyDomainEvent(recording.publisher, {
      type: "preview.created",
      previewId: "workspace-preview",
      preview: createPreview(binding, "workspace", "workspace-1"),
      workspaceId: "workspace-1",
      executionHostBinding: binding,
      timestamp: "2026-01-01T00:00:00.000Z",
    }, { userId: "user-1" });
    publishClankyDomainEvent(recording.publisher, {
      type: "preview.created",
      previewId: "server-preview",
      preview: createPreview(binding, "server"),
      executionHostBinding: binding,
      timestamp: "2026-01-01T00:00:01.000Z",
    }, { userId: "user-1" });

    expect(recording.resources).toEqual([
      {
        ownerId: "user-1",
        resource: CLANKY_REALTIME_RESOURCES.previews,
        action: "changed",
        id: "workspace-preview",
        scope: "workspace-1",
      },
      {
        ownerId: "user-1",
        resource: CLANKY_REALTIME_RESOURCES.previews,
        action: "changed",
        id: "server-preview",
        scope: "local:local-node",
      },
    ]);
  });

  test("publishes execution-host invalidations for binding revisions", () => {
    const recording = createRecordingPublisher();

    publishClankyDomainEvent(recording.publisher, {
      type: "mesh.changed",
      executionHostsChanged: true,
    }, { userId: "user-1" });

    expect(recording.resources).toContainEqual({
      ownerId: "user-1",
      resource: CLANKY_REALTIME_RESOURCES.executionHosts,
      action: "changed",
      id: undefined,
      scope: undefined,
    });
  });
});
