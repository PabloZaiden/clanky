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
  type MessageData,
  type ToolCallData,
  type TranscriptSnapshotOptions,
  type TranscriptStreamEvent,
} from "@/shared";
import { readApiResponse, requestApiResponse } from "../lib/api-client";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
import { isAbortError } from "../lib/request-lifecycle";
import { useDocumentVisibility } from "./useDocumentVisibility";
import { markStreamingText } from "../lib/streaming-text";

export interface TranscriptResourceSnapshot<TResource> {
  resource: TResource;
  transcript: ChatTranscript;
}

export interface TranscriptResourceRefreshOptions {
  showLoading?: boolean;
  afterCurrent?: boolean;
}

interface PendingTranscriptRefresh {
  resourceId: string;
  showLoading?: boolean;
  afterCurrent?: boolean;
  waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>;
  timer?: ReturnType<typeof setTimeout>;
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
  isResourcePresentationEqual?: (
    current: TResource | null,
    next: TResource | null,
  ) => boolean;
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
  refreshCoalesced: (options?: TranscriptResourceRefreshOptions) => Promise<void>;
  loadMoreTranscript: () => Promise<void>;
  loadFullTranscript: () => Promise<void>;
  loadToolDetails: (toolCallId: string) => Promise<ToolCallData | null>;
  applyTranscriptEvent: (event: TranscriptStreamEvent) => void;
  flushTranscript: () => void;
  clearResource: (error?: string) => void;
}

// Outlast the reconciliation queue's 250 ms request cadence so realtime invalidations share its batch refresh.
const TRANSCRIPT_REFRESH_COALESCE_WINDOW_MS = 500;
const TRANSCRIPT_STREAM_PUBLISH_INTERVAL_MS = 200;

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

function replaceResource<TResource>(
  _current: TResource | null,
  incoming: TResource,
): TResource {
  return incoming;
}

function reuseUnchangedMessages(
  current: MessageData[],
  incoming: MessageData[],
): MessageData[] {
  const currentById = new Map(current.map((message) => [message.id, message]));
  return incoming.map((message) => {
    const previous = currentById.get(message.id);
    if (!previous || previous === message) {
      return message;
    }
    if (
      previous.role !== message.role
      || previous.content !== message.content
      || previous.timestamp !== message.timestamp
    ) {
      return message;
    }
    const attachments = message.attachments;
    const sameAttachments = previous.attachments === attachments || (
      previous.attachments !== undefined
      && attachments !== undefined
      && previous.attachments.length === attachments.length
      && previous.attachments.every((attachment, index) => {
        const incomingAttachment = attachments[index];
        return incomingAttachment !== undefined
          && attachment.id === incomingAttachment.id
          && attachment.filename === incomingAttachment.filename
          && attachment.mimeType === incomingAttachment.mimeType
          && attachment.data === incomingAttachment.data
          && attachment.size === incomingAttachment.size;
      })
    );
    return sameAttachments
      && (previous.question === message.question
        || JSON.stringify(previous.question) === JSON.stringify(message.question))
      ? previous
      : message;
  });
}

export function useTranscriptResource<TResource, TSnapshot>({
  resourceId,
  resourceLabel,
  baseUrl,
  initialResource = null,
  decodeSnapshot,
  mergeResource = replaceResource,
  isResourcePresentationEqual,
}: UseTranscriptResourceOptions<TResource, TSnapshot>): UseTranscriptResourceResult<TResource> {
  const isVisible = useDocumentVisibility();
  const [resource, setResourceState] = useState<TResource | null>(initialResource);
  const [transcript, setTranscriptState] = useState<ChatTranscript>(createEmptyTranscript);
  const [loading, setLoading] = useState(true);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resourceRef = useRef<TResource | null>(initialResource);
  const presentationEqualityRef = useRef(isResourcePresentationEqual);
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
  const coalescedRefreshRef = useRef<PendingTranscriptRefresh | null>(null);
  const snapshotEtagRef = useRef<string | null>(null);
  const refreshWindowRef = useRef<TranscriptSnapshotOptions>({});
  const toolDetailsCacheRef = useRef(new Map<string, ToolCallData>());
  const streamVersionRef = useRef(0);
  const publicationTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  resourceIdRef.current = resourceId;
  initialResourceRef.current = initialResource;
  presentationEqualityRef.current = isResourcePresentationEqual;

  const cancelTranscriptPublication = useCallback((): void => {
    if (publicationTimerRef.current !== undefined) clearTimeout(publicationTimerRef.current);
    publicationTimerRef.current = undefined;
  }, []);

  const flushTranscript = useCallback((): void => {
    if (publicationTimerRef.current === undefined) return;
    cancelTranscriptPublication();
    if (mountedRef.current) setTranscriptState(transcriptRef.current);
  }, [cancelTranscriptPublication]);

  useEffect(() => {
    if (isVisible) flushTranscript();
  }, [flushTranscript, isVisible]);

  // Resolve updates before React renders so bursts of realtime events share the latest state.
  const setResource = useCallback<Dispatch<SetStateAction<TResource | null>>>((next) => {
    const current = resourceRef.current;
    const resolved = typeof next === "function"
      ? (next as (value: TResource | null) => TResource | null)(current)
      : next;
    // Freshness/recovery reads stay authoritative even when only nonvisual activity changes.
    resourceRef.current = resolved;
    if (!presentationEqualityRef.current?.(current, resolved)) {
      if (resolved !== current) flushTranscript();
      setResourceState(resolved);
    }
  }, [flushTranscript]);

  const setTranscript = useCallback<Dispatch<SetStateAction<ChatTranscript>>>((next) => {
    const resolved = typeof next === "function"
      ? (next as (value: ChatTranscript) => ChatTranscript)(transcriptRef.current)
      : next;
    transcriptRef.current = resolved;
    cancelTranscriptPublication();
    setTranscriptState(resolved);
  }, [cancelTranscriptPublication]);

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
    const method = options.afterCurrent ? "runAfterCurrent" : "run";
    return refreshCoordinatorRef.current[method](async () => {
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
          {
            ...decoded.transcript,
            messages: reuseUnchangedMessages(current.messages, decoded.transcript.messages),
          },
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
        flushTranscript();
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
    flushTranscript,
    mergeResource,
    resourceId,
    resourceLabel,
    setResource,
    setTranscript,
  ]);

  const cancelCoalescedRefresh = useCallback((): void => {
    const pending = coalescedRefreshRef.current;
    if (!pending) return;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    coalescedRefreshRef.current = null;
    for (const waiter of pending.waiters) waiter.resolve();
  }, []);

  const refreshCoalesced = useCallback((
    options: TranscriptResourceRefreshOptions = {},
  ): Promise<void> => new Promise((resolve, reject) => {
    let pending = coalescedRefreshRef.current;
    if (pending && pending.resourceId !== resourceId) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      coalescedRefreshRef.current = null;
      for (const waiter of pending.waiters) waiter.resolve();
      pending = null;
    }

    if (!pending) {
      pending = {
        resourceId,
        showLoading: options.showLoading,
        afterCurrent: options.afterCurrent,
        waiters: [],
      };
      coalescedRefreshRef.current = pending;
    } else if (options.showLoading === true) {
      pending.showLoading = true;
    } else if (pending.showLoading === undefined && options.showLoading === false) {
      pending.showLoading = false;
    }
    if (options.afterCurrent) pending.afterCurrent = true;

    const batch = pending;
    batch.waiters.push({ resolve, reject });
    if (batch.timer !== undefined) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      if (coalescedRefreshRef.current !== batch) return;
      coalescedRefreshRef.current = null;
      batch.timer = undefined;
      if (!mountedRef.current || resourceIdRef.current !== batch.resourceId) {
        for (const waiter of batch.waiters) waiter.resolve();
        return;
      }

      void refresh({ showLoading: batch.showLoading, afterCurrent: batch.afterCurrent }).then(
        () => {
          for (const waiter of batch.waiters) waiter.resolve();
        },
        (refreshError) => {
          for (const waiter of batch.waiters) waiter.reject(refreshError);
        },
      );
    }, TRANSCRIPT_REFRESH_COALESCE_WINDOW_MS);
  }), [refresh, resourceId]);

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
        {
          ...decoded.transcript,
          messages: reuseUnchangedMessages(current.messages, decoded.transcript.messages),
        },
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
      flushTranscript();
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
    flushTranscript,
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
    if (!mountedRef.current || resourceIdRef.current !== resourceId) return;
    streamVersionRef.current += 1;
    const update = applyTranscriptStreamEvent(transcriptRef.current, event);
    if (update.transcript !== transcriptRef.current) {
      if (event.type === "transcript.message.delta") {
        const message = update.transcript.messages.find((entry) => entry.id === event.messageId);
        if (message) {
          markStreamingText(
            message,
            transcriptRef.current.messages.find((entry) => entry.id === event.messageId),
            event.baseLength,
          );
        }
      }
      if (
        event.type === "transcript.message.delta"
        || event.type === "transcript.log.delta"
        || event.type === "transcript.tool.extra"
      ) {
        transcriptRef.current = update.transcript;
        if (publicationTimerRef.current === undefined) {
          publicationTimerRef.current = setTimeout(() => {
            publicationTimerRef.current = undefined;
            if (mountedRef.current && resourceIdRef.current === resourceId) {
              setTranscriptState(transcriptRef.current);
            }
          }, TRANSCRIPT_STREAM_PUBLISH_INTERVAL_MS);
        }
      } else {
        setTranscript(update.transcript);
      }
    }
    if (update.gapDetected) {
      flushTranscript();
      refreshControllerRef.current?.abort();
      refreshCoordinatorRef.current.reset();
      snapshotEtagRef.current = null;
      void refresh({ showLoading: false });
    }
  }, [flushTranscript, refresh, resourceId, setTranscript]);

  useEffect(() => {
    mountedRef.current = true;
    cancelTranscriptPublication();
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
    cancelCoalescedRefresh();
    toolDetailsCacheRef.current.clear();
    streamVersionRef.current = 0;

    return () => {
      mountedRef.current = false;
      cancelTranscriptPublication();
      cancelCoalescedRefresh();
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
  }, [cancelCoalescedRefresh, cancelTranscriptPublication, resourceId]);

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
    refreshCoalesced,
    loadMoreTranscript,
    loadFullTranscript,
    loadToolDetails,
    applyTranscriptEvent,
    flushTranscript,
    clearResource,
  };
}
