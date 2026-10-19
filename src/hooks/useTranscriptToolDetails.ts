import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import {
  isToolCallDetailsStale,
  isToolCallSummary,
  mergeToolCallDisplayData,
  type ChatTranscript,
  type ToolCallData,
} from "@/shared";
import { readApiResponse, requestApiResponse } from "../lib/api-client";

export function useTranscriptToolDetails({
  resourceId,
  resourceLabel,
  baseUrl,
  getTranscript,
  setTranscript,
}: {
  resourceId: string;
  resourceLabel: string;
  baseUrl: string;
  getTranscript: () => ChatTranscript;
  setTranscript: Dispatch<SetStateAction<ChatTranscript>>;
}) {
  const cache = useRef(new Map<string, ToolCallData>());
  const controllers = useRef(new Map<string, AbortController>());
  const identity = useRef(resourceId);
  identity.current = resourceId;

  useEffect(() => {
    cache.current.clear();
    return () => {
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
      cache.current.clear();
    };
  }, [resourceId]);

  const withToolDetails = useCallback((transcript: ChatTranscript): ChatTranscript => ({
    ...transcript,
    toolCalls: transcript.toolCalls.map((tool) => {
      const details = cache.current.get(tool.id);
      if (!details) return tool;
      if (isToolCallSummary(tool) && isToolCallDetailsStale(tool, details)) {
        cache.current.delete(tool.id);
        return tool;
      }
      return mergeToolCallDisplayData(details, tool);
    }),
  }), []);

  const loadToolDetails = useCallback(async (
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<ToolCallData | null> => {
    const current = getTranscript().toolCalls.find((tool) => tool.id === toolCallId);
    if (current && !isToolCallSummary(current)) return current;
    const cached = cache.current.get(toolCallId);
    if (cached && (!current || !isToolCallDetailsStale(current, cached))) return cached;
    cache.current.delete(toolCallId);
    controllers.current.get(toolCallId)?.abort();
    const controller = new AbortController();
    controllers.current.set(toolCallId, controller);
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const response = await requestApiResponse(`${baseUrl}/tool-calls/${encodeURIComponent(toolCallId)}`, {
        signal: requestSignal,
        action: `Fetch ${resourceLabel} tool-call details`,
        fallbackMessage: `Failed to load ${resourceLabel} tool call`,
        acceptedStatuses: [404],
      });
      if (response.status === 404) return null;
      const details = await readApiResponse<ToolCallData>(response);
      if (requestSignal.aborted || identity.current !== resourceId) return null;
      const latest = getTranscript().toolCalls.find((tool) => tool.id === toolCallId);
      if (latest && isToolCallSummary(latest) && isToolCallDetailsStale(latest, details)) {
        throw new Error("Tool details changed while loading. Open the tool again to refresh.");
      }
      cache.current.set(toolCallId, details);
      if (cache.current.size > 100) cache.current.delete(cache.current.keys().next().value!);
      setTranscript((transcript) => withToolDetails(transcript));
      return details;
    } finally {
      if (controllers.current.get(toolCallId) === controller) controllers.current.delete(toolCallId);
    }
  }, [baseUrl, getTranscript, resourceId, resourceLabel, setTranscript, withToolDetails]);

  return { loadToolDetails, withToolDetails };
}
