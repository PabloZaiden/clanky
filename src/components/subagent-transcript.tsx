import { ErrorState, LoadingState, Panel } from "@pablozaiden/webapp/web";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import type { Subagent, SubagentSnapshot } from "@/shared/subagent";
import { useTranscriptResource } from "../hooks/useTranscriptResource";
import { useVoicePlayback } from "../hooks/useVoicePlayback";
import { useVoiceSettings } from "../hooks/useVoiceSettings";
import { getClankyClientCapabilities } from "../client-sdk/capabilities";
import { useLiveVoiceBusy } from "../lib/voice-audio-ownership";
import { ConversationTranscript } from "./conversation-transcript";
import { StateText } from "./common";
import { VoicePlaybackOverlay } from "./chat-details/voice-playback-overlay";
import type { TranscriptFileLinkContext } from "./log-viewer";

export function SubagentTranscript({
  kind, entityId, initialSubagent, binding, fileLinkContext, onBack,
}: {
  kind: "chat" | "task";
  entityId: string;
  initialSubagent: Subagent;
  binding?: HarnessConversationBinding | null;
  fileLinkContext?: TranscriptFileLinkContext;
  onBack: () => void;
}) {
  const resource = useTranscriptResource<Subagent, SubagentSnapshot>({
    stream: "subagent", resourceId: initialSubagent.id, resourceLabel: "Subagent conversation",
    baseUrl: `/api/${kind}s/${encodeURIComponent(entityId)}/subagents/${encodeURIComponent(initialSubagent.id)}`,
    initialResource: initialSubagent,
    decodeSnapshot: (snapshot) => ({ resource: snapshot.subagent, transcript: snapshot.transcript }),
  });
  const voice = useVoiceSettings({ enabled: getClankyClientCapabilities().voice });
  const playback = useVoicePlayback();
  const liveVoiceBusy = useLiveVoiceBusy();
  const subagent = resource.resource ?? initialSubagent;
  const connected = subagent.observation === "connected" && resource.realtimeStatus === "open";
  const active = connected && ["queued", "running", "stopping"].includes(subagent.activity.status);
  const matchingHost = subagent.binding.directory === binding?.directory
    && JSON.stringify(subagent.binding.executionHost) === JSON.stringify(binding?.executionHost);
  const speechAvailable = voice.settings.piper.available && voice.settings.capabilities.text.validated && !liveVoiceBusy;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <Panel
        title={subagent.activity.description}
        className="shrink-0"
        actions={<button type="button" className="py-1 text-xs text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
          onClick={() => { playback.stop(); onBack(); }}>Back to activity</button>}
      >
        <p className="text-xs text-gray-500 dark:text-gray-400">
          <StateText>{subagent.activity.status}</StateText>
          {" / "}{subagent.activity.effectiveModel ?? subagent.activity.requestedModel ?? "Model not reported"}
        </p>
        {(subagent.coverage === "partial" || !connected) && <p role="status" className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          {subagent.coverage === "partial" ? "Partial history. Only content exposed and retained by the native provider is available. " : ""}
          {!connected ? subagent.observation === "unsupported"
            ? "This runtime cannot recover older subagent history. Saved content is still available."
            : "Live observation is unavailable. Showing saved content." : ""}
        </p>}
        {subagent.error && <p className="mt-2 text-xs text-red-700 dark:text-red-300">{subagent.error}</p>}
        {!matchingHost && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">File links are unavailable for this previous execution context.</p>}
      </Panel>
      {resource.error && <ErrorState title="Conversation could not be loaded" description={resource.error} />}
      {resource.loading && !resource.transcript.revision ? <LoadingState title="Loading conversation" /> : resource.notFound ? (
        <ErrorState title="Subagent conversation is unavailable" description="The parent conversation may have been removed or access changed." />
      ) : <ConversationTranscript
        id={`subagent-transcript-${subagent.id}`}
        transcript={resource.transcript}
        isActive={active}
        toolPathDisplayRoot={subagent.binding.directory}
        fileLinkContext={matchingHost ? fileLinkContext : undefined}
        onLoadToolDetails={resource.loadToolDetails}
        onLoadMoreTranscript={resource.loadMoreTranscript}
        onLoadFullTranscript={resource.loadFullTranscript}
        loadingTranscript={resource.loadingTranscript}
        onReadAloud={speechAvailable ? (messageId) => void playback.play({
          kind, parentId: entityId, subagentId: subagent.id,
        }, messageId) : undefined}
        playingReadAloudKey={playback.playingKey}
        readAloudStatus={playback.status === "idle" ? null : playback.status}
      />}
      <VoicePlaybackOverlay recovery={playback.playbackRecovery} onPlay={playback.retryPlayback} onCancel={playback.stop} />
    </div>
  );
}
