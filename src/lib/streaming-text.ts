import type { MessageData } from "@/shared";

interface StreamingTextArrival {
  from: number;
  receivedAt: number;
}

const arrivals = new WeakMap<MessageData, StreamingTextArrival>();

export function markStreamingText(
  message: MessageData,
  previous: MessageData | undefined,
  baseLength: number,
): void {
  if (message.role !== "assistant" || document.visibilityState === "hidden") return;
  const receivedAt = performance.now();
  const prior = previous && arrivals.get(previous);
  arrivals.set(message, {
    from: prior && receivedAt - prior.receivedAt < 400 ? prior.from : baseLength,
    receivedAt,
  });
}

export function getStreamingTextStart(message: MessageData): number | undefined {
  const arrival = arrivals.get(message);
  return arrival && performance.now() - arrival.receivedAt < 1_000
    ? arrival.from
    : undefined;
}
