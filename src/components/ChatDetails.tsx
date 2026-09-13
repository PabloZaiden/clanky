import { useCallback, useMemo, useRef } from "react";
import { type TranscriptFileLinkTarget } from "./LogViewer";
import { getChatWorkspaceId, getExecutionHostSourceId } from "@/shared";
import { appAbsoluteUrl } from "../lib/public-path";
import { replaceWebAppRoute, routeToHash, useToast, type WebAppRoute } from "@pablozaiden/webapp/web";
import { useChatLifecycle } from "./chat-details/chat-lifecycle";
import { ChatComposer } from "./chat-details/chat-composer";
import {
  ChatPermissionPanel,
  ChatQueuedMessagesPanel,
} from "./chat-details/chat-support-panels";
import { ChatTranscript } from "./chat-details/chat-transcript";
import type { ChatComposerProps } from "./chat-details/types";
import { VoiceListeningOverlay } from "./chat-details/voice-listening-overlay";
import { VoicePlaybackOverlay } from "./chat-details/voice-playback-overlay";
import {
  useVoicePlayback,
  useVoiceRecorder,
  useVoiceSettings,
} from "../hooks";

export function ChatDetails({
  chatId,
  embeddedTaskId,
  embedded = false,
  isExternallyBusy = false,
  onSendMessage,
}: {
  chatId: string;
  embeddedTaskId?: string;
  embedded?: boolean;
  isExternallyBusy?: boolean;
  onSendMessage?: ChatComposerProps["onSendMessage"];
}) {
  const toast = useToast();
  const isEmbedded = embedded || (typeof embeddedTaskId === "string" && embeddedTaskId.length > 0);
  const {
    chat,
    transcript,
    loading,
    error,
    isActive,
    needsSshCredentials,
    refreshChat,
    loadToolCallDetails,
    applyChatSnapshot,
    markChatStarting,
    handleReconnect,
  } = useChatLifecycle(chatId);
  const voiceSettings = useVoiceSettings();
  const voiceDraftSetterRef = useRef<((text: string) => void) | null>(null);
  const voiceDraftGetterRef = useRef<(() => string) | null>(null);
  const voiceDraftSubmitterRef = useRef<((text: string) => Promise<void>) | null>(null);
  const registerVoiceDraft = useCallback((
    setDraft: (text: string) => void,
    getDraft: () => string,
    submitDraft: (text: string) => Promise<void>,
  ): (() => void) => {
    voiceDraftSetterRef.current = setDraft;
    voiceDraftGetterRef.current = getDraft;
    voiceDraftSubmitterRef.current = submitDraft;
    return () => {
      if (voiceDraftSetterRef.current === setDraft) {
        voiceDraftSetterRef.current = null;
        voiceDraftGetterRef.current = null;
        voiceDraftSubmitterRef.current = null;
      }
    };
  }, []);
  const handleVoiceTranscript = useCallback((text: string): void => {
    const currentDraft = voiceDraftGetterRef.current?.().trim() ?? "";
    const nextDraft = currentDraft ? `${currentDraft}\n\n${text}` : text;
    voiceDraftSetterRef.current?.(nextDraft);
    void voiceDraftSubmitterRef.current?.(nextDraft);
  }, []);
  const voiceRecorder = useVoiceRecorder({
    enabled: voiceSettings.settings.capabilities.transcription.validated,
    canStart: () => voiceDraftGetterRef.current?.().trim() === "",
    onTranscript: handleVoiceTranscript,
  });
  const voicePlayback = useVoicePlayback();
  const handleReadAloud = useCallback((
    message: { id: string; content: string },
    mode: "full" | "summary",
  ): void => {
    const capability = mode === "summary"
      ? voiceSettings.settings.capabilities.text
      : voiceSettings.settings.capabilities.speech;
    if (!capability.validated) {
      toast.error("This voice capability is not configured and validated.");
      return;
    }
    void voicePlayback.play(`${message.id}:${mode}`, message.content, mode);
  }, [
    toast,
    voicePlayback,
    voiceSettings.settings.capabilities.speech,
    voiceSettings.settings.capabilities.text,
  ]);
  const chatWorkingDirectory = chat?.state.worktree?.worktreePath ?? chat?.config.directory ?? "";
  const fileLinkContext = useMemo(() => {
    if (!chat || !chatWorkingDirectory) {
      return undefined;
    }

    const getCodeExplorerRoute = ({
      path,
      startDirectory,
      kind,
    }: TranscriptFileLinkTarget): WebAppRoute => (
      embeddedTaskId
        ? {
            view: "code-explorer",
            contentType: "task",
            taskId: embeddedTaskId,
            startDirectory,
            filePath: kind === "directory" ? undefined : path,
          }
        : {
            view: "code-explorer",
            contentType: "chat",
            chatId: chat.config.id,
            startDirectory,
            filePath: kind === "directory" ? undefined : path,
          }
    );
    const source = chat.config.source;
    const fileExplorerTarget = source?.kind === "execution_host"
      ? {
          type: "executionHost" as const,
          id: getExecutionHostSourceId(source.executionHost.host),
          kind: source.executionHost.host.kind,
          startDirectory: chatWorkingDirectory,
        }
      : {
            type: "workspace" as const,
            id: getChatWorkspaceId(chat),
            startDirectory: chatWorkingDirectory,
          };

    return {
      fileExplorerTarget,
      rootDirectory: chatWorkingDirectory,
      getFileHref: (target: TranscriptFileLinkTarget) => (
        appAbsoluteUrl(routeToHash(getCodeExplorerRoute(target)))
      ),
      openFile: (target: TranscriptFileLinkTarget) => {
        replaceWebAppRoute(getCodeExplorerRoute(target));
      },
      onFileOpenError: (message: string) => {
        toast.error(message);
      },
    };
  }, [chat, chatWorkingDirectory, embeddedTaskId, toast]);

  if (loading && !chat) {
    return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading chat…</div>;
  }

  if (!chat) {
    if (isEmbedded) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
            {error ?? "Chat not found"}
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="p-6">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">Not found</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">{error ?? "Chat not found"}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <ChatTranscript
        chat={chat}
        transcript={transcript}
        lifecycleError={error}
        isActive={isActive}
        toolPathDisplayRoot={chatWorkingDirectory}
        fileLinkContext={fileLinkContext}
        onLoadToolDetails={loadToolCallDetails}
        voiceInput={{
          available: voiceSettings.settings.capabilities.transcription.validated,
          status: voiceRecorder.status,
          elapsedMs: voiceRecorder.elapsedMs,
          error: voiceRecorder.error,
        }}
        onStartVoice={voiceRecorder.start}
        onStopVoice={voiceRecorder.stop}
        onCancelVoice={voiceRecorder.cancel}
        onDismissVoiceError={voiceRecorder.dismissError}
        onReadAloud={handleReadAloud}
        readAloudAvailable={voiceSettings.settings.capabilities.speech.validated}
        readAloudSummaryAvailable={
          voiceSettings.settings.capabilities.speech.validated
          && voiceSettings.settings.capabilities.text.validated
        }
        playingReadAloudKey={voicePlayback.playingKey}
        readAloudStatus={voicePlayback.status === "idle" ? null : voicePlayback.status}
      />
      <ChatPermissionPanel
        chatId={chatId}
        requests={chat.state.pendingPermissionRequests ?? []}
        onChatSnapshot={applyChatSnapshot}
      />
      <ChatQueuedMessagesPanel
        chatId={chatId}
        messages={chat.state.queuedMessages ?? []}
        onChatSnapshot={applyChatSnapshot}
      />
      <ChatComposer
        chat={chat}
        chatId={chatId}
        isEmbedded={isEmbedded}
        isActive={isActive}
        needsSshCredentials={needsSshCredentials}
        isExternallyBusy={isExternallyBusy}
        onChatSnapshot={applyChatSnapshot}
        markChatStarting={markChatStarting}
        refreshChat={refreshChat}
        handleReconnect={handleReconnect}
        onSendMessage={onSendMessage}
        voiceInput={{
          available: voiceSettings.settings.capabilities.transcription.validated,
          status: voiceRecorder.status,
        }}
        onStartVoice={voiceRecorder.start}
        registerVoiceDraft={registerVoiceDraft}
      />
      <VoiceListeningOverlay
        status={voiceRecorder.status}
        elapsedMs={voiceRecorder.elapsedMs}
        error={voiceRecorder.error}
        onStop={voiceRecorder.stop}
        onCancel={voiceRecorder.cancel}
        onRetry={voiceRecorder.start}
        onDismissError={voiceRecorder.dismissError}
      />
      <VoicePlaybackOverlay
        recovery={voicePlayback.playbackRecovery}
        onPlay={voicePlayback.retryPlayback}
        onCancel={voicePlayback.stop}
      />
    </div>
  );
}
