import { pollUntil } from "./polling";
import type { RealtimeInterest } from "@pablozaiden/webapp/contracts";

export async function subscribeRealtime(
  socket: WebSocket,
  interest: RealtimeInterest,
): Promise<void> {
  const subscriptionId = crypto.randomUUID();
  let activated = false;
  let lastFrame: unknown;
  const receive = (message: MessageEvent): void => {
    const frame = JSON.parse(String(message.data));
    lastFrame = frame;
    if (frame.type === "subscribed" && frame.subscriptionId === subscriptionId && frame.generation === 1) {
      activated = true;
    }
  };
  socket.addEventListener("message", receive);
  try {
    socket.send(JSON.stringify({ type: "subscribe", subscriptionId, generation: 1, interest }));
    await pollUntil(() => ({ activated, readyState: socket.readyState, lastFrame }),
      (state) => state.activated, {
        description: "the authenticated realtime interest to activate",
        timeoutMs: 5000,
        formatLastObserved: (state) => JSON.stringify(state),
      });
  } finally {
    socket.removeEventListener("message", receive);
  }
}
