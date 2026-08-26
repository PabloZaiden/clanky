import type { ServerWebSocket } from "bun";
import { createLogger, type RealtimeBus, type WebSocketData } from "@pablozaiden/webapp/server";

const log = createLogger("realtime:heartbeat");
export const REALTIME_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Adds control-frame heartbeats to the framework-owned realtime bus without
 * involving Clanky's raw terminal, VNC, or preview websocket handlers.
 */
export function installRealtimeHeartbeat(
  realtime: RealtimeBus,
  intervalMs = REALTIME_HEARTBEAT_INTERVAL_MS,
): () => void {
  const sockets = new Set<ServerWebSocket<WebSocketData>>();
  const originalAdd = realtime.add.bind(realtime);
  const originalRemove = realtime.remove.bind(realtime);

  realtime.add = (socket) => {
    originalAdd(socket);
    sockets.add(socket);
  };
  realtime.remove = (socket) => {
    originalRemove(socket);
    sockets.delete(socket);
  };

  const timer = setInterval(() => {
    for (const socket of sockets) {
      try {
        socket.ping();
      } catch (error) {
        log.trace("Failed to send realtime heartbeat", { error: String(error) });
      }
    }
  }, intervalMs);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    realtime.add = originalAdd;
    realtime.remove = originalRemove;
    sockets.clear();
  };
}
