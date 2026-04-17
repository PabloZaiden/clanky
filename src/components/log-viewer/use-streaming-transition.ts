import { useEffect, useState } from "react";
import type { StreamingTransitionState } from "./types";

const STREAMING_TRANSITION_RESET_MS = 500;

export function getStreamingTransitionClassName(streamingTransition: StreamingTransitionState): string {
  switch (streamingTransition) {
    case "enter":
      return "animate-soft-stream-enter";
    case "update":
      return "animate-soft-stream-update";
    default:
      return "";
  }
}

export function useStreamingTransitionClass(
  streamingTransition: StreamingTransitionState,
  transitionToken: string | null,
): string {
  const [transitionClassName, setTransitionClassName] = useState("");

  useEffect(() => {
    if (!streamingTransition || !transitionToken) {
      setTransitionClassName("");
      return;
    }

    const nextClassName = getStreamingTransitionClassName(streamingTransition);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let firstFrameId = 0;
    let secondFrameId = 0;

    setTransitionClassName("");
    firstFrameId = requestAnimationFrame(() => {
      secondFrameId = requestAnimationFrame(() => {
        setTransitionClassName(nextClassName);
        timeoutId = setTimeout(() => {
          setTransitionClassName("");
        }, STREAMING_TRANSITION_RESET_MS);
      });
    });

    return () => {
      cancelAnimationFrame(firstFrameId);
      cancelAnimationFrame(secondFrameId);
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, [streamingTransition, transitionToken]);

  return transitionClassName;
}
