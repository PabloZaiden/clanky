import type { WebAppDuplex } from "@pablozaiden/webapp/web";
import {
  beginPerformanceSpan, confirmPerformanceConnection, newPerformanceSocket, performanceFailure, setPerformanceConnection,
} from "./performance-stats";

export async function measureRealtimeConnection(connect: () => Promise<WebAppDuplex>, signal?: AbortSignal): Promise<WebAppDuplex> {
  const id = newPerformanceSocket();
  let socket: WebAppDuplex;
  try {
    socket = await connect();
  } catch (error) {
    setPerformanceConnection(id, "closed");
    throw error;
  }
  const endOpen = beginPerformanceSpan("socket-open");
  let heartbeat: ReturnType<typeof beginPerformanceSpan>;
  let subscription: ReturnType<typeof beginPerformanceSpan>;
  let acknowledged = false;
  let retired = false;
  const retire = (outcome: "aborted" | "error" | "timeout") => {
    if (retired) return;
    retired = true;
    endOpen?.(outcome);
    heartbeat?.(outcome);
    subscription?.(outcome);
    setPerformanceConnection(id, "closed");
  };
  void socket.ready.then(() => {
    if (retired) return;
    endOpen?.("ok");
    setPerformanceConnection(id, "open");
  }, (error: unknown) => retire(performanceFailure(signal?.aborted ? signal.reason : error)));
  socket.subscribe({
    onMessage(data) {
      if (data === '{"type":"pong"}') {
        heartbeat?.("ok");
        heartbeat = undefined;
        confirmPerformanceConnection(id, false);
      } else if (!acknowledged && typeof data === "string" && data.startsWith('{"type":"subscribed",')) {
        acknowledged = true;
        subscription?.("ok");
        setPerformanceConnection(id, "subscribed");
        confirmPerformanceConnection(id, true);
      }
    },
    onError: () => retire("error"),
    onClose: ({ code }) => retire(code === 1000 ? "aborted" : "error"),
  });
  return {
    ready: socket.ready,
    get bufferedAmount() { return socket.bufferedAmount; },
    subscribe: (handlers) => socket.subscribe(handlers),
    send(data) {
      if (data === '{"type":"ping"}') heartbeat = beginPerformanceSpan("heartbeat");
      else if (!acknowledged && !subscription && typeof data === "string" && data.startsWith('{"type":"subscribe",')) {
        subscription = beginPerformanceSpan("subscription");
      }
      return socket.send(data);
    },
    close(code, reason) {
      retire("aborted");
      return socket.close(code, reason);
    },
  };
}
