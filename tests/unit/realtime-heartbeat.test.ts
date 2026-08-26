import { describe, expect, test } from "bun:test";
import { RealtimeBus, type WebSocketData } from "@pablozaiden/webapp/server";
import type { ServerWebSocket } from "bun";
import { installRealtimeHeartbeat } from "../../src/realtime-heartbeat";

describe("realtime heartbeat", () => {
  test("pings sockets registered with the framework realtime bus", async () => {
    let pingCount = 0;
    let resolvePing!: () => void;
    const pingObserved = new Promise<void>((resolve) => {
      resolvePing = resolve;
    });
    const socket = {
      ping() {
        pingCount += 1;
        resolvePing();
      },
    } as unknown as ServerWebSocket<WebSocketData>;
    const realtime = new RealtimeBus();
    const cleanup = installRealtimeHeartbeat(realtime, 1);

    try {
      realtime.add(socket);
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          pingObserved,
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error("Realtime heartbeat was not sent")), 1000);
          }),
        ]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
      expect(pingCount).toBe(1);
    } finally {
      cleanup();
    }
  });
});
