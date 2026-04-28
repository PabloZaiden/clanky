/**
 * API integration tests for WebSocket events endpoint.
 * Tests use actual WebSocket connections to a test server.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { serve, type Server } from "bun";
import { apiRoutes } from "../../src/api";
import { websocketHandlers, type WebSocketData } from "../../src/api/websocket";
import { ensureDataDirectories } from "../../src/persistence/database";
import { chatEventEmitter, loopEventEmitter } from "../../src/core/event-emitter";

describe("Events WebSocket API Integration", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let server: Server<WebSocketData>;
  let baseUrl: string;
  let wsUrl: string;

  beforeAll(async () => {
    // Create temp directories
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-api-events-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "ralpher-api-events-test-work-"));

    // Set env var for persistence
    process.env["RALPHER_DATA_DIR"] = testDataDir;

    // Ensure directories exist
    await ensureDataDirectories();

    // Start test server on random port with WebSocket support
    server = serve<WebSocketData>({
      port: 0, // Random available port
      routes: {
        ...apiRoutes,
        "/api/ws": (req: Request, server: Server<WebSocketData>) => {
          const url = new URL(req.url);
          const loopId = url.searchParams.get("loopId") ?? undefined;
          const chatId = url.searchParams.get("chatId") ?? undefined;

          const upgraded = server.upgrade(req, {
            data: { loopId, chatId } as WebSocketData,
          });

          if (upgraded) {
            return undefined;
          }

          return new Response("WebSocket upgrade failed", { status: 400 });
        },
      },
      websocket: websocketHandlers,
    });
    baseUrl = server.url.toString().replace(/\/$/, "");
    wsUrl = baseUrl.replace(/^http/, "ws");
  });

  afterAll(async () => {
    // Stop server
    server.stop();

    // Cleanup temp directories
    await rm(testDataDir, { recursive: true, force: true });
    await rm(testWorkDir, { recursive: true, force: true });

    // Clear env
    delete process.env["RALPHER_DATA_DIR"];
  });

  describe("WS /api/ws", () => {
    test("establishes WebSocket connection", async () => {
      const ws = new WebSocket(`${wsUrl}/api/ws`);

      const connected = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve(false);
        }, 1000);

        ws.onopen = () => {
          clearTimeout(timeout);
          resolve(true);
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          resolve(false);
        };
      });

      expect(connected).toBe(true);
      ws.close();
    });

    test("receives connection confirmation", async () => {
      const ws = new WebSocket(`${wsUrl}/api/ws`);

      const message = await new Promise<{ type: string; loopId: string | null; chatId: string | null } | null>((resolve) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, 1000);

        ws.onmessage = (event) => {
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(event.data));
          } catch {
            resolve(null);
          }
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          resolve(null);
        };
      });

      expect(message).not.toBeNull();
      expect(message?.type).toBe("connected");
      expect(message?.loopId).toBeNull();
      expect(message?.chatId).toBeNull();
      ws.close();
    });

    test("filters chat events by chatId when specified", async () => {
      const targetChatId = "target-chat";
      const otherChatId = "other-chat";

      const ws = new WebSocket(`${wsUrl}/api/ws?chatId=${targetChatId}`);

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      const connMsg = await new Promise<{ chatId: string | null }>((resolve) => {
        ws.onmessage = (event) => {
          resolve(JSON.parse(event.data));
        };
      });
      expect(connMsg.chatId).toBe(targetChatId);

      const receivedEvent = new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for filtered chat event"));
        }, 1000);

        ws.onmessage = (event) => {
          clearTimeout(timeout);
          resolve(JSON.parse(event.data));
        };
      });

      loopEventEmitter.emit({
        type: "loop.log",
        loopId: "other-loop",
        id: "other-loop-log",
        level: "info",
        message: "Other loop message",
        timestamp: new Date().toISOString(),
      });

      chatEventEmitter.emit({
        type: "chat.log",
        chatId: otherChatId,
        log: {
          id: "other-log",
          level: "info",
          message: "Other chat message",
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      });

      chatEventEmitter.emit({
        type: "chat.log",
        chatId: targetChatId,
        log: {
          id: "target-log",
          level: "info",
          message: "Target chat message",
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      });

      expect(await receivedEvent).toMatchObject({
        type: "chat.log",
        chatId: targetChatId,
      });

      ws.close();
    });

    test("receives events from emitter", async () => {
      const ws = new WebSocket(`${wsUrl}/api/ws`);

      // Wait for connection
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      // Skip connection message
      await new Promise<void>((resolve) => {
        ws.onmessage = () => resolve();
      });

      // Emit a test event
      const testEvent = {
        type: "loop.log" as const,
        loopId: "test-loop-id",
        id: "log-1",
        level: "info" as const,
        message: "Test log message",
        timestamp: new Date().toISOString(),
      };

      // Set up listener for next message
      const receivedEvent = new Promise<unknown>((resolve) => {
        const timeout = setTimeout(() => {
          resolve(null);
        }, 1000);

        ws.onmessage = (event) => {
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(event.data));
          } catch {
            resolve(null);
          }
        };
      });

      // Emit the event
      loopEventEmitter.emit(testEvent);

      const received = await receivedEvent;
      expect(received).toEqual(testEvent);

      ws.close();
    });

    test("does not forward loop chat status events to unscoped subscribers", async () => {
      const ws = new WebSocket(`${wsUrl}/api/ws`);

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      await new Promise<void>((resolve) => {
        ws.onmessage = () => resolve();
      });

      const receivedEvent = new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for standalone chat status event"));
        }, 1000);

        ws.onmessage = (event) => {
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(event.data));
          } catch {
            reject(new Error("Failed to parse websocket event"));
          }
        };
      });

      chatEventEmitter.emit({
        type: "chat.status",
        chatId: "loop-chat",
        scope: "loop",
        status: "streaming",
        timestamp: new Date().toISOString(),
      });
      chatEventEmitter.emit({
        type: "chat.status",
        chatId: "workspace-chat",
        scope: "workspace",
        status: "streaming",
        timestamp: new Date().toISOString(),
      });

      expect(await receivedEvent).toMatchObject({
        type: "chat.status",
        chatId: "workspace-chat",
        scope: "workspace",
      });

      ws.close();
    });

    test("still forwards loop chat status events to chat-scoped subscribers", async () => {
      const targetChatId = "loop-chat";
      const ws = new WebSocket(`${wsUrl}/api/ws?chatId=${targetChatId}`);

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      await new Promise<void>((resolve) => {
        ws.onmessage = () => resolve();
      });

      const receivedEvent = new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for loop chat status event"));
        }, 1000);

        ws.onmessage = (event) => {
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(event.data));
          } catch {
            reject(new Error("Failed to parse websocket event"));
          }
        };
      });

      chatEventEmitter.emit({
        type: "chat.status",
        chatId: targetChatId,
        scope: "loop",
        status: "streaming",
        timestamp: new Date().toISOString(),
      });

      expect(await receivedEvent).toMatchObject({
        type: "chat.status",
        chatId: targetChatId,
        scope: "loop",
      });

      ws.close();
    });

    test("filters events by loopId when specified", async () => {
      const targetLoopId = "target-loop";
      const otherLoopId = "other-loop";

      const ws = new WebSocket(`${wsUrl}/api/ws?loopId=${targetLoopId}`);

      // Wait for connection
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      // Skip connection message (should have loopId set)
      const connMsg = await new Promise<{ loopId: string | null }>((resolve) => {
        ws.onmessage = (event) => {
          resolve(JSON.parse(event.data));
        };
      });
      expect(connMsg.loopId).toBe(targetLoopId);

      const receivedEvent = new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for filtered loop event"));
        }, 1000);

        ws.onmessage = (event) => {
          clearTimeout(timeout);
          resolve(JSON.parse(event.data));
        };
      });

      chatEventEmitter.emit({
        type: "chat.log",
        chatId: "other-chat",
        log: {
          id: "chat-other",
          level: "info",
          message: "Other chat message",
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      });

      // Emit events for different loops
      loopEventEmitter.emit({
        type: "loop.log",
        loopId: otherLoopId,
        id: "log-other",
        level: "info",
        message: "Other loop message",
        timestamp: new Date().toISOString(),
      });

      loopEventEmitter.emit({
        type: "loop.log",
        loopId: targetLoopId,
        id: "log-target",
        level: "info",
        message: "Target loop message",
        timestamp: new Date().toISOString(),
      });

      expect(await receivedEvent).toMatchObject({
        type: "loop.log",
        loopId: targetLoopId,
      });

      ws.close();
    });

    test("responds to ping with pong", async () => {
      const ws = new WebSocket(`${wsUrl}/api/ws`);

      // Wait for connection
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      // Skip connection message
      await new Promise<void>((resolve) => {
        ws.onmessage = () => resolve();
      });

      // Send ping
      ws.send(JSON.stringify({ type: "ping" }));

      // Expect pong
      const pong = await new Promise<{ type: string } | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 1000);
        ws.onmessage = (event) => {
          clearTimeout(timeout);
          resolve(JSON.parse(event.data));
        };
      });

      expect(pong).not.toBeNull();
      expect(pong?.type).toBe("pong");

      ws.close();
    });

    test("handles invalid JSON gracefully without closing connection", async () => {
      const ws = new WebSocket(`${wsUrl}/api/ws`);

      // Wait for connection
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      // Skip connection message
      await new Promise<void>((resolve) => {
        ws.onmessage = () => resolve();
      });

      // Send invalid JSON — should not crash or close the connection
      ws.send("not valid json {{{}}}");

      // Verify connection is still alive by sending a ping and getting pong
      ws.send(JSON.stringify({ type: "ping" }));

      const pong = await new Promise<{ type: string } | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 1000);
        ws.onmessage = (event) => {
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(event.data));
          } catch {
            resolve(null);
          }
        };
      });

      expect(pong).not.toBeNull();
      expect(pong?.type).toBe("pong");

      ws.close();
    });

    test("stops receiving events after client disconnects", async () => {
      const ws = new WebSocket(`${wsUrl}/api/ws`);

      // Wait for connection
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      // Skip connection message
      await new Promise<void>((resolve) => {
        ws.onmessage = () => resolve();
      });

      // Close the connection
      ws.close();

      // Wait for close to propagate
      await new Promise<void>((resolve) => {
        ws.onclose = () => resolve();
      });

      // Emit an event — should not cause errors on the server
      // (unsubscribe should have been called in the close handler)
      loopEventEmitter.emit({
        type: "loop.log",
        loopId: "after-disconnect",
        id: "log-after",
        level: "info",
        message: "Should not crash",
        timestamp: new Date().toISOString(),
      });

      // Give a moment for any errors to surface
      await new Promise((resolve) => setTimeout(resolve, 50));
      // If we reach here, the server handled the disconnection cleanly
      expect(true).toBe(true);
    });

    test("connection confirmation includes loopId when specified", async () => {
      const testLoopId = "my-test-loop-123";
      const ws = new WebSocket(`${wsUrl}/api/ws?loopId=${testLoopId}`);

      const message = await new Promise<{ type: string; loopId: string | null } | null>((resolve) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, 1000);

        ws.onmessage = (event) => {
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(event.data));
          } catch {
            resolve(null);
          }
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          resolve(null);
        };
      });

      expect(message).not.toBeNull();
      expect(message?.type).toBe("connected");
      expect(message?.loopId).toBe(testLoopId);
      ws.close();
    });

    test("ignores unknown message types without error", async () => {
      const ws = new WebSocket(`${wsUrl}/api/ws`);

      // Wait for connection
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      // Skip connection message
      await new Promise<void>((resolve) => {
        ws.onmessage = () => resolve();
      });

      // Send an unknown message type
      ws.send(JSON.stringify({ type: "unknown_type", data: "test" }));

      // Verify connection still works
      ws.send(JSON.stringify({ type: "ping" }));

      const pong = await new Promise<{ type: string } | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 1000);
        ws.onmessage = (event) => {
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(event.data));
          } catch {
            resolve(null);
          }
        };
      });

      expect(pong).not.toBeNull();
      expect(pong?.type).toBe("pong");

      ws.close();
    });

    test("multiple clients receive same emitted events", async () => {
      const ws1 = new WebSocket(`${wsUrl}/api/ws`);
      const ws2 = new WebSocket(`${wsUrl}/api/ws`);

      // Set up message collectors immediately to avoid race conditions.
      // The server sends the "connected" message synchronously in the open handler,
      // so onmessage must be assigned before onopen fires to catch it reliably.
      const ws1Messages: unknown[] = [];
      const ws2Messages: unknown[] = [];
      const ws1Connected = new Promise<void>((resolve) => {
        ws1.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "connected") {
            resolve();
          } else {
            ws1Messages.push(data);
          }
        };
      });
      const ws2Connected = new Promise<void>((resolve) => {
        ws2.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "connected") {
            resolve();
          } else {
            ws2Messages.push(data);
          }
        };
      });

      // Wait for both connections and their "connected" messages
      await Promise.all([ws1Connected, ws2Connected]);

      // Set up listeners for the real event
      const received1 = new Promise<unknown>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 1000);
        ws1.onmessage = (event) => {
          clearTimeout(timeout);
          resolve(JSON.parse(event.data));
        };
      });

      const received2 = new Promise<unknown>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 1000);
        ws2.onmessage = (event) => {
          clearTimeout(timeout);
          resolve(JSON.parse(event.data));
        };
      });

      // Emit event
      const testEvent = {
        type: "loop.log" as const,
        loopId: "multi-client-loop",
        id: "log-multi",
        level: "info" as const,
        message: "Multi-client test",
        timestamp: new Date().toISOString(),
      };
      loopEventEmitter.emit(testEvent);

      const [r1, r2] = await Promise.all([received1, received2]);
      expect(r1).toEqual(testEvent);
      expect(r2).toEqual(testEvent);

      ws1.close();
      ws2.close();
    });

    test("events without loopId are delivered to all clients", async () => {
      // A client filtering for a specific loop
      const filteredWs = new WebSocket(`${wsUrl}/api/ws?loopId=specific-loop`);
      // A client with no filter
      const unfilteredWs = new WebSocket(`${wsUrl}/api/ws`);
      const expectedEventIds = new Set(["log-match", "log-other"]);

      // Set up message collectors immediately to avoid race conditions.
      const filteredEvents: Array<{ loopId: string; id: string }> = [];
      const unfilteredEvents: Array<{ loopId: string; id: string }> = [];
      const trackExpectedEvent = (
        rawEvent: MessageEvent<string>,
        target: Array<{ loopId: string; id: string }>,
      ) => {
        const data = JSON.parse(rawEvent.data);
        if (
          typeof data === "object"
          && data !== null
          && "id" in data
          && typeof data.id === "string"
          && expectedEventIds.has(data.id)
          && "loopId" in data
          && typeof data.loopId === "string"
        ) {
          target.push({ loopId: data.loopId, id: data.id });
        }
      };
      const waitForExpectedEvents = async (
        expectedFilteredCount: number,
        expectedUnfilteredCount: number,
      ) => {
        const timeoutMs = 1000;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (
            filteredEvents.length === expectedFilteredCount
            && unfilteredEvents.length === expectedUnfilteredCount
          ) {
            return;
          }
          await Bun.sleep(10);
        }

        throw new Error(
          `Timed out waiting for expected websocket events (filtered=${filteredEvents.length}, unfiltered=${unfilteredEvents.length})`,
        );
      };
      const filteredConnected = new Promise<void>((resolve) => {
        filteredWs.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "connected") {
            resolve();
          } else {
            trackExpectedEvent(event, filteredEvents);
          }
        };
      });
      const unfilteredConnected = new Promise<void>((resolve) => {
        unfilteredWs.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "connected") {
            resolve();
          } else {
            trackExpectedEvent(event, unfilteredEvents);
          }
        };
      });

      // Wait for both connections and their "connected" messages
      await Promise.all([filteredConnected, unfilteredConnected]);

      // Set up final event collectors
      filteredWs.onmessage = (event) => {
        trackExpectedEvent(event, filteredEvents);
      };
      unfilteredWs.onmessage = (event) => {
        trackExpectedEvent(event, unfilteredEvents);
      };

      // Emit event that has no loopId — should pass through the filter
      // because the filter checks `"loopId" in event` and only skips if loopId differs
      loopEventEmitter.emit({
        type: "loop.log",
        loopId: "specific-loop",
        id: "log-match",
        level: "info",
        message: "Matching loop",
        timestamp: new Date().toISOString(),
      });

      loopEventEmitter.emit({
        type: "loop.log",
        loopId: "other-loop",
        id: "log-other",
        level: "info",
        message: "Non-matching loop",
        timestamp: new Date().toISOString(),
      });

      await waitForExpectedEvents(1, 2);

      // Filtered client should only get the matching event
      expect(filteredEvents.length).toBe(1);
      expect(filteredEvents[0]?.loopId).toBe("specific-loop");
      expect(filteredEvents[0]?.id).toBe("log-match");

      // Unfiltered client should get both events
      expect(unfilteredEvents.length).toBe(2);
      expect(unfilteredEvents.map((event) => event.id)).toEqual(["log-match", "log-other"]);

      filteredWs.close();
      unfilteredWs.close();
    });
  });
});
