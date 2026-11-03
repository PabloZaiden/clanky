import type { TranscriptMessage } from "@/shared";

interface StreamingTextArrival {
  from: number;
  receivedAt: number;
}

const arrivals = new WeakMap<TranscriptMessage, StreamingTextArrival>();

export function markStreamingText(
  message: TranscriptMessage,
  previous: TranscriptMessage | undefined,
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

export function getStreamingTextStart(message: TranscriptMessage): number | undefined {
  const arrival = arrivals.get(message);
  return arrival && performance.now() - arrival.receivedAt < 1_000
    ? arrival.from
    : undefined;
}
