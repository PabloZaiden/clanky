import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  applyTranscriptStreamEvent,
  mergeTranscriptSnapshot,
  mergeToolCallDisplayData,
  isToolCallDetailsStale,
  isToolCallSummary,
  type ChatTranscript,
  type ToolCallData,
  type TranscriptSnapshotOptions,
  type TranscriptStreamEvent,
} from "@/shared";
import { readApiResponse, requestApiResponse } from "../lib/api-client";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
import { isAbortError } from "../lib/request-lifecycle";

export interface TranscriptResourceSnapshot<TResource> {
  resource: TResource;
  transcript: ChatTranscript;
}

export interface TranscriptResourceRefreshOptions {
  showLoading?: boolean;
}

export interface UseTranscriptResourceOptions<TResource, TSnapshot> {
  resourceId: string;
  resourceLabel: string;
  baseUrl: string;
  initialResource?: TResource | null;
  decodeSnapshot: (snapshot: TSnapshot) => TranscriptResourceSnapshot<TResource>;
  mergeResource?: (
    current: TResource | null,
    incoming: TResource,
  ) => TResource;
}

export interface UseTranscriptResourceResult<TResource> {
  resource: TResource | null;
  getResource: () => TResource | null;
  setResource: Dispatch<SetStateAction<TResource | null>>;
  transcript: ChatTranscript;
  getTranscript: () => ChatTranscript;
  setTranscript: Dispatch<SetStateAction<ChatTranscript>>;
  loading: boolean;
  loadingTranscript: boolean;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  refresh: (options?: TranscriptResourceRefreshOptions) => Promise<void>;
  loadMoreTranscript: () => Promise<void>;
  loadFullTranscript: () => Promise<void>;
  loadToolDetails: (toolCallId: string) => Promise<ToolCallData | null>;
  applyTranscriptEvent: (event: TranscriptStreamEvent) => void;
  clearResource: (error?: string) => void;
}

export function createEmptyTranscript(): ChatTranscript {
  return {
    messages: [],
    logs: [],
    toolCalls: [],
    revision: "",
    totalEntries: 0,
    isPartial: false,
    loadedResponses: 0,
    totalResponses: 0,
    hasOlder: false,
  };
}

function buildSnapshotUrl(
  baseUrl: string,
  options: TranscriptSnapshotOptions = {},
): string {
  const params = new URLSearchParams();
  if (options.full) {
    params.set("full", "1");
  } else if (options.before) {
    params.set("before", options.before);
  }
  const query = params.toString();
  return `${baseUrl}/snapshot${query ? `?${query}` : ""}`;
}

export function useTranscriptResource<TResource, TSnapshot>({
  resourceId,
  resourceLabel,
  baseUrl,
  initialResource = null,
  decodeSnapshot,
  mergeResource = (_current, incoming) => incoming,
}: UseTranscriptResourceOptions<TResource, TSnapshot>): UseTranscriptResourceResult<TResource> {
  const [resource, setResourceState] = useState<TResource | null>(initialResource);
  const [transcript, setTranscriptState] = useState<ChatTranscript>(createEmptyTranscript);
  const [loading, setLoading] = useState(true);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resourceRef = useRef<TResource | null>(initialResource);
  const transcriptRef = useRef<ChatTranscript>(createEmptyTranscript());
  const resourceIdRef = useRef(resourceId);
  const initialResourceRef = useRef(initialResource);
  const mountedRef = useRef(false);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const transcriptControllerRef = useRef<AbortController | null>(null);
  const detailControllersRef = useRef(new Map<string, AbortController>());
  const refreshRequestIdRef = useRef(0);
  const transcriptRequestIdRef = useRef(0);
  const refreshCoordinatorRef = useRef(createRefreshCoordinator<void>());
  const snapshotEtagRef = useRef<string | null>(null);
  const refreshWindowRef = useRef<TranscriptSnapshotOptions>({});
  const toolDetailsCacheRef = useRef(new Map<string, ToolCallData>());
  const streamVersionRef = useRef(0);

  resourceIdRef.current = resourceId;
  initialResourceRef.current = initialResource;

  const setResource = useCallback<Dispatch<SetStateAction<TResource | null>>>((next) => {
    setResourceState((current) => {
      const resolved = typeof next === "function"
        ? (next as (value: TResource | null) => TResource | null)(current)
        : next;
      resourceRef.current = resolved;
      return resolved;
    });
  }, []);

  const setTranscript = useCallback<Dispatch<SetStateAction<ChatTranscript>>>((next) => {
    setTranscriptState((current) => {
      const resolved = typeof next === "function"
        ? (next as (value: ChatTranscript) => ChatTranscript)(current)
        : next;
      transcriptRef.current = resolved;
      return resolved;
    });
  }, []);

  const clearResource = useCallback((nextError?: string): void => {
    setResource(null);
    setTranscript(createEmptyTranscript());
    setError(nextError ?? null);
  }, [setResource, setTranscript]);
  const getResource = useCallback(() => resourceRef.current, []);
  const getTranscript = useCallback(() => transcriptRef.current, []);

  const refresh = useCallback((
    options: TranscriptResourceRefreshOptions = {},
  ): Promise<void> => {
    return refreshCoordinatorRef.current.run(async () => {
      const requestResourceId = resourceId;
      const requestId = refreshRequestIdRef.current + 1;
      refreshRequestIdRef.current = requestId;
      const showLoading = options.showLoading ?? resourceRef.current === null;
      const controller = new AbortController();
      refreshControllerRef.current = controller;
      const refreshWindow = refreshWindowRef.current;
      const streamVersion = streamVersionRef.current;

      try {
        if (showLoading && mountedRef.current) {
          setLoading(true);
        }
        if (mountedRef.current) {
          setError(null);
        }
        const headers = new Headers();
        if (snapshotEtagRef.current) {
          headers.set("If-None-Match", snapshotEtagRef.current);
        }
        const response = await requestApiResponse(
          buildSnapshotUrl(baseUrl, refreshWindow),
          {
            signal: controller.signal,
            headers,
            action: `Fetch ${resourceLabel} snapshot`,
            fallbackMessage: `Failed to fetch ${resourceLabel}`,
            acceptedStatuses: [304, 404],
          },
        );
        if (
          controller.signal.aborted
          || !mountedRef.current
          || resourceIdRef.current !== requestResourceId
          || refreshRequestIdRef.current !== requestId
        ) {
          return;
        }
        if (response.status === 304) {
          return;
        }
        if (response.status === 404) {
          clearResource(`${resourceLabel[0]?.toUpperCase() ?? ""}${resourceLabel.slice(1)} not found`);
          return;
        }
        const decoded = decodeSnapshot(await readApiResponse<TSnapshot>(response));
        if (
          controller.signal.aborted
          || !mountedRef.current
          || resourceIdRef.current !== requestResourceId
          || refreshRequestIdRef.current !== requestId
        ) {
          return;
        }
        if (refreshWindow.full === refreshWindowRef.current.full) {
          snapshotEtagRef.current = response.headers.get("ETag");
        }
        setResource((current) => mergeResource(current, decoded.resource));
        setTranscript((current) => mergeTranscriptSnapshot(
          current,
          decoded.transcript,
          {
            direction: refreshWindow.full ? "full" : "refresh",
            preferIncoming: streamVersionRef.current === streamVersion,
          },
        ));
      } catch (refreshError) {
        if (
          controller.signal.aborted
          || isAbortError(refreshError)
          || !mountedRef.current
          || resourceIdRef.current !== requestResourceId
          || refreshRequestIdRef.current !== requestId
        ) {
          return;
        }
        setError(String(refreshError));
      } finally {
        if (
          showLoading
          && mountedRef.current
          && resourceIdRef.current === requestResourceId
          && refreshRequestIdRef.current === requestId
        ) {
          setLoading(false);
        }
        if (refreshControllerRef.current === controller) {
          refreshControllerRef.current = null;
        }
      }
    });
  }, [
    baseUrl,
    clearResource,
    decodeSnapshot,
    mergeResource,
    resourceId,
    resourceLabel,
    setResource,
    setTranscript,
  ]);

  const loadTranscriptWindow = useCallback(async (
    options: TranscriptSnapshotOptions,
  ): Promise<void> => {
    if (
      transcriptControllerRef.current
      || (!options.full && !options.before)
      || resourceIdRef.current !== resourceId
    ) {
      return;
    }

    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    const requestId = transcriptRequestIdRef.current + 1;
    const streamVersion = streamVersionRef.current;
    transcriptRequestIdRef.current = requestId;
    transcriptControllerRef.current = controller;
    setLoadingTranscript(true);

    try {
      const response = await requestApiResponse(
        buildSnapshotUrl(baseUrl, options),
        {
          signal: controller.signal,
          action: options.full
            ? `Load complete ${resourceLabel} transcript`
            : `Load older ${resourceLabel} transcript`,
          fallbackMessage: options.full
            ? `Failed to load complete ${resourceLabel} transcript`
            : `Failed to load older ${resourceLabel} transcript`,
          acceptedStatuses: [404],
        },
      );
      if (
        controller.signal.aborted
        || !mountedRef.current
        || resourceIdRef.current !== resourceId
        || transcriptRequestIdRef.current !== requestId
      ) {
        return;
      }
      if (response.status === 404) {
        clearResource(`${resourceLabel[0]?.toUpperCase() ?? ""}${resourceLabel.slice(1)} not found`);
        return;
      }
      const decoded = decodeSnapshot(await readApiResponse<TSnapshot>(response));
      if (
        controller.signal.aborted
        || !mountedRef.current
        || resourceIdRef.current !== resourceId
        || transcriptRequestIdRef.current !== requestId
      ) {
        return;
      }
      setResource((current) => mergeResource(current, decoded.resource));
      setTranscript((current) => mergeTranscriptSnapshot(
        current,
        decoded.transcript,
        {
          direction: options.full ? "full" : "older",
          preferIncoming: streamVersionRef.current === streamVersion,
        },
      ));
      if (options.full) {
        refreshWindowRef.current = { full: true };
        snapshotEtagRef.current = response.headers.get("ETag");
      }
      setError(null);
    } catch (transcriptError) {
      if (
        controller.signal.aborted
        || isAbortError(transcriptError)
        || !mountedRef.current
        || resourceIdRef.current !== resourceId
        || transcriptRequestIdRef.current !== requestId
      ) {
        return;
      }
      setError(String(transcriptError));
    } finally {
      if (transcriptControllerRef.current === controller) {
        transcriptControllerRef.current = null;
      }
      if (
        mountedRef.current
        && resourceIdRef.current === resourceId
        && transcriptRequestIdRef.current === requestId
      ) {
        setLoadingTranscript(false);
      }
    }
  }, [
    baseUrl,
    clearResource,
    decodeSnapshot,
    mergeResource,
    resourceId,
    resourceLabel,
    setResource,
    setTranscript,
  ]);

  const loadMoreTranscript = useCallback(
    () => {
      const cursor = transcriptRef.current.nextCursor;
      return cursor
        ? loadTranscriptWindow({ before: cursor })
        : Promise.resolve();
    },
    [loadTranscriptWindow],
  );

  const loadFullTranscript = useCallback(
    () => loadTranscriptWindow({ full: true }),
    [loadTranscriptWindow],
  );

  const loadToolDetails = useCallback(async (
    toolCallId: string,
  ): Promise<ToolCallData | null> => {
    const requestResourceId = resourceId;
    const currentTool = transcriptRef.current.toolCalls.find(
      (toolCall) => toolCall.id === toolCallId,
    );
    const cached = toolDetailsCacheRef.current.get(toolCallId);
    if (
      cached
      && (!currentTool || !isToolCallSummary(currentTool) || !isToolCallDetailsStale(currentTool, cached))
    ) {
      return cached;
    }
    if (cached) {
      toolDetailsCacheRef.current.delete(toolCallId);
    }
    if (currentTool && !isToolCallSummary(currentTool)) {
      toolDetailsCacheRef.current.set(toolCallId, currentTool);
      return currentTool;
    }

    detailControllersRef.current.get(toolCallId)?.abort();
    const controller = new AbortController();
    detailControllersRef.current.set(toolCallId, controller);
    try {
      const response = await requestApiResponse(
        `${baseUrl}/tool-calls/${encodeURIComponent(toolCallId)}`,
        {
          signal: controller.signal,
          action: `Fetch ${resourceLabel} tool-call details`,
          fallbackMessage: `Failed to load ${resourceLabel} tool call`,
          acceptedStatuses: [404],
        },
      );
      if (response.status === 404) {
        return null;
      }
      const tool = await readApiResponse<ToolCallData>(response);
      if (
        controller.signal.aborted
        || !mountedRef.current
        || resourceIdRef.current !== requestResourceId
      ) {
        return null;
      }
      toolDetailsCacheRef.current.set(toolCallId, tool);
      setTranscript((current) => ({
        ...current,
        toolCalls: current.toolCalls.map((entry) => (
          entry.id === toolCallId
            ? mergeToolCallDisplayData(entry, tool)
            : entry
        )),
      }));
      return tool;
    } finally {
      if (detailControllersRef.current.get(toolCallId) === controller) {
        detailControllersRef.current.delete(toolCallId);
      }
    }
  }, [baseUrl, resourceId, resourceLabel, setTranscript]);

  const applyTranscriptEvent = useCallback((event: TranscriptStreamEvent): void => {
    streamVersionRef.current += 1;
    const update = applyTranscriptStreamEvent(transcriptRef.current, event);
    if (update.transcript !== transcriptRef.current) {
      setTranscript(update.transcript);
    }
    if (update.gapDetected) {
      refreshControllerRef.current?.abort();
      refreshCoordinatorRef.current.reset();
      snapshotEtagRef.current = null;
      void refresh({ showLoading: false });
    }
  }, [refresh, setTranscript]);

  useEffect(() => {
    mountedRef.current = true;
    resourceIdRef.current = resourceId;
    resourceRef.current = initialResourceRef.current;
    transcriptRef.current = createEmptyTranscript();
    setResourceState(initialResourceRef.current);
    setTranscriptState(transcriptRef.current);
    setLoading(true);
    setLoadingTranscript(false);
    setError(null);
    snapshotEtagRef.current = null;
    refreshWindowRef.current = {};
    refreshRequestIdRef.current += 1;
    transcriptRequestIdRef.current += 1;
    refreshControllerRef.current?.abort();
    transcriptControllerRef.current?.abort();
    refreshCoordinatorRef.current.reset();
    toolDetailsCacheRef.current.clear();
    streamVersionRef.current = 0;

    return () => {
      mountedRef.current = false;
      refreshRequestIdRef.current += 1;
      transcriptRequestIdRef.current += 1;
      refreshControllerRef.current?.abort();
      transcriptControllerRef.current?.abort();
      refreshCoordinatorRef.current.reset();
      for (const controller of detailControllersRef.current.values()) {
        controller.abort();
      }
      detailControllersRef.current.clear();
      refreshControllerRef.current = null;
      transcriptControllerRef.current = null;
    };
  }, [resourceId]);

  return {
    resource,
    getResource,
    setResource,
    transcript,
    getTranscript,
    setTranscript,
    loading,
    loadingTranscript,
    error,
    setError,
    refresh,
    loadMoreTranscript,
    loadFullTranscript,
    loadToolDetails,
    applyTranscriptEvent,
    clearResource,
  };
}
