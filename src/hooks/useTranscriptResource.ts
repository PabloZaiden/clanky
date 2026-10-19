import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  createVersionedSyncController,
  RealtimeResyncRequiredError,
  useRealtime,
  type ResourceRealtimeEvent,
} from "@pablozaiden/webapp/web";
import {
  applyTranscriptStreamEvent,
  mergeTranscriptSnapshot,
  type AgentEvent,
  type ChatEvent,
  type ChatTranscript,
  type TaskEvent,
  type ToolCallData,
  type TranscriptSnapshotOptions,
} from "@/shared";
import { readApiResponse, requestApiResponse } from "../lib/api-client";
import { isAbortError, SNAPSHOT_REQUEST_TIMEOUT_MS } from "../lib/request-lifecycle";
import { markStreamingText } from "../lib/streaming-text";
import { toTranscriptStreamEvent } from "./transcript-event-adapter";
import { useTranscriptToolDetails } from "./useTranscriptToolDetails";

export interface TranscriptResourceSnapshot<TResource> {
  resource: TResource;
  transcript: ChatTranscript;
}

interface TranscriptSyncSnapshot<TResource> extends TranscriptResourceSnapshot<TResource> {
  replacesHistory: boolean;
  expandedWindow: boolean;
}

export interface TranscriptResourceState<TResource> {
  resource: TResource | null;
  getResource: () => TResource | null;
  setResource: Dispatch<SetStateAction<TResource | null>>;
}

export interface UseTranscriptResourceOptions<TResource, TSnapshot> {
  resourceId: string;
  resourceLabel: string;
  stream: "task" | "chat" | "agent.run";
  baseUrl: string;
  initialResource?: TResource | null;
  resourceState?: TranscriptResourceState<TResource>;
  decodeSnapshot: (snapshot: TSnapshot) => TranscriptResourceSnapshot<TResource>;
  mergeResource?: (current: TResource | null, incoming: TResource) => TResource;
  isResourcePresentationEqual?: (current: TResource | null, next: TResource | null) => boolean;
}

export interface UseTranscriptResourceResult<TResource> {
  resource: TResource | null;
  getResource: () => TResource | null;
  setResource: Dispatch<SetStateAction<TResource | null>>;
  transcript: ChatTranscript;
  loading: boolean;
  loadingTranscript: boolean;
  error: string | null;
  notFound: boolean;
  setError: Dispatch<SetStateAction<string | null>>;
  refresh: () => Promise<void>;
  loadMoreTranscript: () => Promise<void>;
  loadFullTranscript: () => Promise<void>;
  loadToolDetails: (toolCallId: string, signal?: AbortSignal) => Promise<ToolCallData | null>;
  clearResource: (error?: string) => void;
  realtimeStatus: "connecting" | "open" | "closed";
}

type ContentEvent = TaskEvent | ChatEvent | AgentEvent;

const STREAMS = {
  task: { resource: "tasks", target: "taskId" },
  chat: { resource: "chats", target: "chatId" },
  "agent.run": { resource: "agent-runs", target: "agentRunId" },
} as const;
const CONTENT_SUFFIXES = ["message", "message.delta", "log", "log.delta", "tool_call", "tool_call.extra"];

export function createEmptyTranscript(): ChatTranscript {
  return {
    messages: [], logs: [], toolCalls: [],
    revision: "",
    position: { epoch: "", revision: 0 },
    totalEntries: 0, isPartial: false, loadedResponses: 0,
    totalResponses: 0, hasOlder: false,
  };
}

function buildSnapshotUrl(baseUrl: string, options: TranscriptSnapshotOptions = {}): string {
  const params = new URLSearchParams();
  if (options.full) params.set("full", "1");
  else if (options.before) params.set("before", options.before);
  else if (options.since) params.set("since", options.since);
  return `${baseUrl}/snapshot${params.size ? `?${params}` : ""}`;
}

function reduceContent<T>(
  snapshot: TranscriptSyncSnapshot<T> | null,
  event: ContentEvent,
): TranscriptSyncSnapshot<T> | null {
  if (!snapshot) throw new RealtimeResyncRequiredError("Transcript content arrived without a resource baseline");
  const adapted = toTranscriptStreamEvent(event);
  const update = adapted ? applyTranscriptStreamEvent(snapshot.transcript, adapted) : null;
  if (update?.gapDetected) throw new RealtimeResyncRequiredError("Transcript content does not match its versioned predecessor");
  const transcript = update?.transcript ?? snapshot.transcript;
  if (adapted?.type === "transcript.message.delta") {
    const message = transcript.messages.find((entry) => entry.id === adapted.messageId);
    if (message) markStreamingText(
      message,
      snapshot.transcript.messages.find((entry) => entry.id === adapted.messageId),
      adapted.baseLength,
    );
  }
  if (!snapshot.expandedWindow && (transcript.messages.length > 2000 || transcript.logs.length > 5000 || transcript.toolCalls.length > 5000)) {
    throw new RealtimeResyncRequiredError("Transcript window reached its retained collection limit");
  }
  return {
    ...snapshot,
    replacesHistory: false,
    transcript: {
      ...transcript,
      position: event.streamPosition!,
    },
  };
}

export function useTranscriptResource<TResource, TSnapshot>(
  options: UseTranscriptResourceOptions<TResource, TSnapshot>,
): UseTranscriptResourceResult<TResource> {
  const { resourceId, resourceLabel, baseUrl, stream, initialResource = null, resourceState } = options;
  const settings = useRef(options);
  settings.current = options;
  const [localResource, setLocalResource] = useState<TResource | null>(initialResource);
  const [transcript, setTranscriptState] = useState(createEmptyTranscript);
  const [loading, setLoading] = useState(true);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const resourceRef = useRef<TResource | null>(initialResource);
  const transcriptRef = useRef(transcript);
  const windowRef = useRef<TranscriptSnapshotOptions>({});
  const historyRef = useRef<ChatTranscript | null>(null);
  const historyController = useRef<AbortController | null>(null);
  const sync = useRef<ReturnType<typeof createVersionedSyncController<
    TranscriptSyncSnapshot<TResource> | null, ContentEvent
  >> | null>(null);

  const getResource = useCallback(() => {
    const external = settings.current.resourceState;
    return external ? external.getResource() : resourceRef.current;
  }, []);
  const setResource = useCallback<Dispatch<SetStateAction<TResource | null>>>((next) => {
    const current = getResource();
    const resolved = typeof next === "function"
      ? (next as (value: TResource | null) => TResource | null)(current)
      : next;
    resourceRef.current = resolved;
    if (resolved !== null) setNotFound(false);
    const external = settings.current.resourceState;
    if (external) external.setResource(resolved);
    else if (!settings.current.isResourcePresentationEqual?.(current, resolved)) setLocalResource(resolved);
  }, [getResource]);
  const setTranscript = useCallback<Dispatch<SetStateAction<ChatTranscript>>>((next) => {
    const resolved = typeof next === "function" ? next(transcriptRef.current) : next;
    transcriptRef.current = resolved;
    setTranscriptState(resolved);
  }, []);
  const getTranscript = useCallback(() => transcriptRef.current, []);
  const { loadToolDetails, withToolDetails } = useTranscriptToolDetails({
    resourceId, resourceLabel, baseUrl, getTranscript, setTranscript,
  });
  const clearResource = useCallback((message?: string) => {
    setResource(null);
    setTranscript(createEmptyTranscript());
    setNotFound(true);
    setLoading(false);
    setError(message ?? null);
  }, [setResource, setTranscript]);

  useEffect(() => {
    windowRef.current = {};
    historyRef.current = null;
    resourceRef.current = settings.current.initialResource ?? null;
    setLocalResource(resourceRef.current);
    setTranscript(createEmptyTranscript());
    setLoading(true);
    setLoadingTranscript(false);
    setNotFound(false);
    setError(null);
    let committedResource: TResource | null | undefined;
    let committedTranscript: ChatTranscript | undefined;
    const owner = createVersionedSyncController<TranscriptSyncSnapshot<TResource> | null, ContentEvent>({
      load: async ({ signal }) => {
        const window: TranscriptSnapshotOptions = windowRef.current.full ? { full: true } : historyRef.current
          ? historyRef.current.nextCursor ? { since: historyRef.current.nextCursor } : { full: true }
          : {};
        const response = await requestApiResponse(buildSnapshotUrl(baseUrl, window), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(SNAPSHOT_REQUEST_TIMEOUT_MS)]),
          action: `Fetch ${resourceLabel} snapshot`,
          fallbackMessage: `Failed to fetch ${resourceLabel}`,
          acceptedStatuses: [404],
        });
        if (response.status === 404) return { epoch: `deleted:${resourceId}`, revision: 0, data: null };
        const decoded = settings.current.decodeSnapshot(await readApiResponse<TSnapshot>(response));
        return {
          ...decoded.transcript.position,
          data: {
            ...decoded,
            replacesHistory: Boolean(window.full || window.since),
            expandedWindow: Boolean(window.full || window.since),
          },
        };
      },
      version: (event) => event.streamPosition!,
      reduce: reduceContent,
      onChange: (state) => {
        if (state.error) {
          setError(String(state.error));
          setLoading(false);
          return;
        }
        if (state.data === undefined) return;
        if (state.data === null) {
          clearResource(`${resourceLabel} not found`);
          return;
        }
        const snapshot = state.data;
        setLoading(false);
        setError(null);
        if (committedResource !== snapshot.resource) {
          committedResource = snapshot.resource;
          setResource((current) => settings.current.mergeResource?.(current, snapshot.resource) ?? snapshot.resource);
        }
        if (committedTranscript !== snapshot.transcript) {
          committedTranscript = snapshot.transcript;
          const latest = snapshot.transcript;
          if (snapshot.replacesHistory) historyRef.current = latest;
          setTranscript(withToolDetails(historyRef.current && !snapshot.replacesHistory
            ? mergeTranscriptSnapshot(latest, historyRef.current, { direction: "older" })
            : latest));
        }
      },
    });
    sync.current = owner;
    return () => {
      owner.dispose();
      if (sync.current === owner) sync.current = null;
      historyController.current?.abort();
      historyController.current = null;
    };
  }, [baseUrl, clearResource, resourceId, resourceLabel, setResource, setTranscript, withToolDetails]);

  const { status: realtimeStatus } = useRealtime<ContentEvent>({
    targets: { [STREAMS[stream].target]: resourceId },
    types: CONTENT_SUFFIXES.map((suffix) => `${stream}.${suffix}`),
    trackLastEvent: false,
    onSubscribed: (activation) => sync.current?.activate(activation),
    onStatus: (status) => { if (status !== "open") sync.current?.deactivate(); },
    onEvent: (event) => {
      if (event.streamPosition) sync.current?.receive(event);
      else void sync.current?.refresh();
    },
    onError: (failure) => { setLoading(false); setError(String(failure)); },
  });
  useRealtime<ResourceRealtimeEvent>({
    resources: [STREAMS[stream].resource],
    ids: [resourceId],
    trackLastEvent: false,
    onEvent: () => { void sync.current?.refresh(); },
  });

  const refresh = useCallback(async () => {
    await sync.current?.refresh();
  }, []);
  const loadFullTranscript = useCallback(async () => {
    const owner = sync.current;
    windowRef.current = { full: true };
    setLoadingTranscript(true);
    try { await owner?.refresh(); }
    finally {
      if (sync.current === owner) {
        windowRef.current = {};
        setLoadingTranscript(false);
      }
    }
  }, []);
  const loadMoreTranscript = useCallback(async () => {
    const cursor = transcriptRef.current.nextCursor;
    if (!cursor || historyController.current) return;
    const controller = new AbortController();
    historyController.current = controller;
    historyRef.current = transcriptRef.current;
    setLoadingTranscript(true);
    try {
      const response = await requestApiResponse(buildSnapshotUrl(baseUrl, { before: cursor }), {
        signal: controller.signal,
        action: `Load older ${resourceLabel} transcript`,
        fallbackMessage: `Failed to load older ${resourceLabel} transcript`,
      });
      const decoded = settings.current.decodeSnapshot(await readApiResponse<TSnapshot>(response));
      if (controller.signal.aborted) return;
      historyRef.current = historyRef.current
        ? mergeTranscriptSnapshot(historyRef.current, decoded.transcript, { direction: "older" })
        : decoded.transcript;
      setTranscript((current) => withToolDetails(mergeTranscriptSnapshot(current, decoded.transcript, { direction: "older" })));
    } catch (failure) {
      if (!controller.signal.aborted && !isAbortError(failure)) setError(String(failure));
    } finally {
      if (historyController.current === controller) {
        historyController.current = null;
        setLoadingTranscript(false);
      }
    }
  }, [baseUrl, resourceLabel, setTranscript, withToolDetails]);

  return {
    resource: resourceState ? resourceState.resource : localResource,
    getResource, setResource, transcript, loading, loadingTranscript, error, notFound,
    setError, refresh, loadMoreTranscript, loadFullTranscript, loadToolDetails, clearResource, realtimeStatus,
  };
}
