/**
 * Central session/run state store for the ACP backend.
 *
 * This is the single owner of per-session mutable state: the session cache and
 * directory map, live/replay subscriber sets, prompt sequencing/activity flags,
 * assistant message normalization state, reasoning-part tracking, and tool-call
 * name tracking. Collaborators mutate this state only through the explicit
 * operations declared here so that cleanup stays deterministic and no raw
 * mutable map is shared across services.
 */

import type { AgentEvent, AgentSession, SessionReplayEvent } from "../types";
import type { SessionEventSink } from "./contracts";
import type { SessionSubscriber } from "./types";

export type ReplaySubscriber = (event: SessionReplayEvent) => void;

export class SessionStateStore implements SessionEventSink {
  /** Default connection directory used when a session has no tracked directory. */
  private defaultDirectory = "";

  /** Live event subscriber callbacks by session. */
  private readonly sessionSubscribers = new Map<string, Set<SessionSubscriber>>();

  /** Replay subscribers capture raw session/load history without normalization. */
  private readonly replaySubscribers = new Map<string, Set<ReplaySubscriber>>();

  /** Whether message.start has been emitted for the active prompt per session. */
  private readonly sessionMessageStarted = new Map<string, boolean>();

  /** Accumulated assistant text per active prompt to normalize delta/snapshot updates. */
  private readonly sessionMessageContent = new Map<string, string>();

  /** Monotonic per-session prompt sequence to ignore stale async completions. */
  private readonly sessionPromptSequences = new Map<string, number>();

  /** Whether the active async prompt has produced meaningful activity. */
  private readonly sessionPromptHasActivity = new Map<string, boolean>();

  /** Ignore status-only completion signals until fresh activity arrives after an abort. */
  private readonly sessionIgnoreStatusUntilActivity = new Set<string>();

  /** Track reasoning part identity per session to separate distinct reasoning parts. */
  private readonly sessionReasoningPartKeys = new Map<string, string>();

  /** Track the last emitted reasoning chunk signature per session to suppress duplicates. */
  private readonly sessionLastReasoningChunkSignature = new Map<string, string>();

  /** Cache sessions and their directories. */
  private readonly sessionCache = new Map<string, AgentSession>();
  private readonly sessionDirectories = new Map<string, string>();

  /** Track tool call names by session and toolCallId to resolve later updates. */
  private readonly toolCallNames = new Map<string, Map<string, string>>();

  setDefaultDirectory(directory: string): void {
    this.defaultDirectory = directory;
  }

  getSessionDirectory(sessionId: string): string {
    return this.sessionDirectories.get(sessionId) ?? this.defaultDirectory;
  }

  setSessionDirectory(sessionId: string, directory: string): void {
    this.sessionDirectories.set(sessionId, directory);
  }

  // ---- Session cache ----

  getCachedSession(sessionId: string): AgentSession | undefined {
    return this.sessionCache.get(sessionId);
  }

  setCachedSession(sessionId: string, session: AgentSession): void {
    this.sessionCache.set(sessionId, session);
  }

  // ---- Live subscribers ----

  addSessionSubscriber(sessionId: string, subscriber: SessionSubscriber): void {
    const existing = this.sessionSubscribers.get(sessionId) ?? new Set<SessionSubscriber>();
    existing.add(subscriber);
    this.sessionSubscribers.set(sessionId, existing);
  }

  removeSessionSubscriber(sessionId: string, subscriber: SessionSubscriber): void {
    const existing = this.sessionSubscribers.get(sessionId);
    if (!existing) {
      return;
    }
    existing.delete(subscriber);
    if (existing.size === 0) {
      this.sessionSubscribers.delete(sessionId);
    }
  }

  emitSessionEvent(sessionId: string, event: AgentEvent): void {
    const subscribers = this.sessionSubscribers.get(sessionId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }
    for (const subscriber of subscribers) {
      subscriber(event);
    }
  }

  emitActivePromptError(error: { message: string; code?: string }): void {
    for (const sessionId of [...this.sessionPromptSequences.keys()]) {
      this.emitSessionEvent(sessionId, {
        type: "error",
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
      });
    }
  }

  // ---- Replay subscribers ----

  addReplaySubscriber(sessionId: string, subscriber: ReplaySubscriber): void {
    const existing = this.replaySubscribers.get(sessionId) ?? new Set<ReplaySubscriber>();
    existing.add(subscriber);
    this.replaySubscribers.set(sessionId, existing);
  }

  removeReplaySubscriber(sessionId: string, subscriber: ReplaySubscriber): void {
    const existing = this.replaySubscribers.get(sessionId);
    if (!existing) {
      return;
    }
    existing.delete(subscriber);
    if (existing.size === 0) {
      this.replaySubscribers.delete(sessionId);
    }
  }

  hasReplaySubscribers(sessionId: string): boolean {
    const subscribers = this.replaySubscribers.get(sessionId);
    return !!subscribers && subscribers.size > 0;
  }

  deliverReplayEvent(sessionId: string, event: SessionReplayEvent): void {
    const subscribers = this.replaySubscribers.get(sessionId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }
    for (const subscriber of subscribers) {
      subscriber(event);
    }
  }

  // ---- Prompt / run state ----

  hasActivePrompt(sessionId: string): boolean {
    return this.sessionPromptSequences.has(sessionId);
  }

  getPromptSequence(sessionId: string): number | undefined {
    return this.sessionPromptSequences.get(sessionId);
  }

  /** Begin a new async prompt run; returns the new monotonic sequence. */
  beginPrompt(sessionId: string): number {
    this.sessionMessageStarted.set(sessionId, false);
    this.sessionMessageContent.set(sessionId, "");
    const sequence = (this.sessionPromptSequences.get(sessionId) ?? 0) + 1;
    this.sessionPromptSequences.set(sessionId, sequence);
    this.sessionPromptHasActivity.set(sessionId, false);
    this.sessionReasoningPartKeys.delete(sessionId);
    this.sessionLastReasoningChunkSignature.delete(sessionId);
    return sequence;
  }

  /** Prepare a synchronous prompt run (no sequence tracking). */
  beginSyncPrompt(sessionId: string): void {
    this.sessionMessageStarted.set(sessionId, false);
  }

  /** Mark that the active prompt produced meaningful activity (guarded by an active prompt). */
  markPromptActivity(sessionId: string): void {
    if (this.sessionPromptSequences.has(sessionId)) {
      this.sessionPromptHasActivity.set(sessionId, true);
    }
  }

  hasPromptActivity(sessionId: string): boolean {
    return this.sessionPromptHasActivity.get(sessionId) ?? false;
  }

  isIgnoringStatusUntilActivity(sessionId: string): boolean {
    return this.sessionIgnoreStatusUntilActivity.has(sessionId);
  }

  clearIgnoreStatusUntilActivity(sessionId: string): void {
    this.sessionIgnoreStatusUntilActivity.delete(sessionId);
  }

  // ---- Assistant message normalization ----

  isMessageStarted(sessionId: string): boolean {
    return this.sessionMessageStarted.get(sessionId) ?? false;
  }

  startMessage(sessionId: string): void {
    this.sessionMessageStarted.set(sessionId, true);
    this.sessionMessageContent.set(sessionId, "");
  }

  /**
   * Normalize an assistant message chunk into a delta relative to previously
   * accumulated content, updating the accumulator.
   */
  normalizeMessageChunk(sessionId: string, text: string): string {
    if (text.length === 0) {
      return "";
    }

    const previousContent = this.sessionMessageContent.get(sessionId) ?? "";
    if (previousContent.length === 0) {
      this.sessionMessageContent.set(sessionId, text);
      return text;
    }

    if (text.length > previousContent.length && text.startsWith(previousContent)) {
      this.sessionMessageContent.set(sessionId, text);
      return text.slice(previousContent.length);
    }

    const nextContent = previousContent + text;
    this.sessionMessageContent.set(sessionId, nextContent);
    return text;
  }

  // ---- Reasoning normalization ----

  /**
   * Compute the reasoning delta to emit for a chunk, suppressing exact
   * duplicates and inserting a separator when the reasoning part changes.
   * Returns null when the chunk is a duplicate and should be skipped.
   */
  computeReasoningDelta(sessionId: string, partKey: string | undefined, text: string): string | null {
    const chunkSignature = `${partKey ?? "unknown"}\u0000${text}`;
    if (this.sessionLastReasoningChunkSignature.get(sessionId) === chunkSignature) {
      return null;
    }
    let reasoningText = text;
    if (partKey) {
      const previousPartKey = this.sessionReasoningPartKeys.get(sessionId);
      if (previousPartKey && previousPartKey !== partKey && !text.startsWith("\n")) {
        reasoningText = `\n${text}`;
      }
      this.sessionReasoningPartKeys.set(sessionId, partKey);
    }
    this.sessionLastReasoningChunkSignature.set(sessionId, chunkSignature);
    return reasoningText;
  }

  // ---- Tool-call name tracking ----

  setToolName(sessionId: string, toolCallId: string, toolName: string): void {
    const names = this.toolCallNames.get(sessionId) ?? new Map<string, string>();
    names.set(toolCallId, toolName);
    this.toolCallNames.set(sessionId, names);
  }

  getToolName(sessionId: string, toolCallId: string): string | undefined {
    return this.toolCallNames.get(sessionId)?.get(toolCallId);
  }

  deleteToolName(sessionId: string, toolCallId: string): void {
    const names = this.toolCallNames.get(sessionId);
    if (!names) {
      return;
    }
    names.delete(toolCallId);
    if (names.size === 0) {
      this.toolCallNames.delete(sessionId);
    }
  }

  private clearToolNames(sessionId: string): void {
    this.toolCallNames.delete(sessionId);
  }

  // ---- Explicit cleanup operations ----

  /** Clear per-prompt run state after completion, failure, or status-driven idle. */
  clearPromptState(sessionId: string): void {
    this.sessionMessageStarted.delete(sessionId);
    this.sessionMessageContent.delete(sessionId);
    this.sessionPromptSequences.delete(sessionId);
    this.sessionPromptHasActivity.delete(sessionId);
    this.sessionIgnoreStatusUntilActivity.delete(sessionId);
    this.sessionReasoningPartKeys.delete(sessionId);
    this.sessionLastReasoningChunkSignature.delete(sessionId);
    this.clearToolNames(sessionId);
  }

  /** Reset streaming/normalization state around an import replay. */
  clearImportState(sessionId: string): void {
    this.sessionMessageStarted.delete(sessionId);
    this.sessionMessageContent.delete(sessionId);
    this.sessionReasoningPartKeys.delete(sessionId);
    this.sessionLastReasoningChunkSignature.delete(sessionId);
    this.clearToolNames(sessionId);
  }

  /** Reset streaming/normalization state after a completed synchronous prompt. */
  clearSyncPromptState(sessionId: string): void {
    this.sessionMessageStarted.delete(sessionId);
    this.sessionMessageContent.delete(sessionId);
    this.clearToolNames(sessionId);
  }

  /** Record that a prompt was aborted so stale status signals are ignored. */
  markAborted(sessionId: string): void {
    if (!this.sessionPromptSequences.has(sessionId)) {
      return;
    }
    this.sessionPromptSequences.set(sessionId, (this.sessionPromptSequences.get(sessionId) ?? 0) + 1);
    this.sessionPromptHasActivity.set(sessionId, false);
    this.sessionMessageStarted.set(sessionId, false);
    this.sessionMessageContent.set(sessionId, "");
    this.sessionIgnoreStatusUntilActivity.add(sessionId);
    this.sessionReasoningPartKeys.delete(sessionId);
    this.sessionLastReasoningChunkSignature.delete(sessionId);
    this.clearToolNames(sessionId);
  }

  /** Clear all state associated with a deleted session. */
  clearSession(sessionId: string): void {
    this.sessionCache.delete(sessionId);
    this.sessionDirectories.delete(sessionId);
    this.sessionSubscribers.delete(sessionId);
    this.replaySubscribers.delete(sessionId);
    this.sessionMessageStarted.delete(sessionId);
    this.sessionMessageContent.delete(sessionId);
    this.sessionPromptSequences.delete(sessionId);
    this.sessionPromptHasActivity.delete(sessionId);
    this.sessionIgnoreStatusUntilActivity.delete(sessionId);
    this.sessionReasoningPartKeys.delete(sessionId);
    this.sessionLastReasoningChunkSignature.delete(sessionId);
    this.clearToolNames(sessionId);
  }

  /** Clear every session's state on disconnect. */
  clearAll(): void {
    this.sessionSubscribers.clear();
    this.replaySubscribers.clear();
    this.sessionMessageStarted.clear();
    this.sessionMessageContent.clear();
    this.sessionPromptSequences.clear();
    this.sessionPromptHasActivity.clear();
    this.sessionIgnoreStatusUntilActivity.clear();
    this.sessionReasoningPartKeys.clear();
    this.sessionLastReasoningChunkSignature.clear();
    this.sessionCache.clear();
    this.sessionDirectories.clear();
    this.toolCallNames.clear();
    this.defaultDirectory = "";
  }
}
