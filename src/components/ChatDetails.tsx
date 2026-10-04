import { useCallback, useMemo, useState } from "react";
import { type TranscriptFileLinkTarget } from "./log-viewer";
import { getChatWorkspaceId, getExecutionHostSourceId } from "@/shared";
import { appAbsoluteUrl } from "../lib/public-path";
import { replaceWebAppRoute, routeToHash, useHeaderActions, useToast, type WebAppRoute } from "@pablozaiden/webapp/web";
import { useChatLifecycle } from "./chat-details/chat-lifecycle";
import {
  ConversationComposer,
  useConversationVoice,
} from "./conversation-composer";
import { useChatComposerAdapter } from "./chat-details/chat-composer-adapter";
import {
  ChatPermissionPanel,
  ChatQueuedMessagesPanel,
} from "./chat-details/chat-support-panels";
import { ChatTranscript } from "./chat-details/chat-transcript";
import { HarnessEntityView } from "./harness-activity";
import { harnessActivityActions } from "./app-shell/harness-actions";
import type { ChatSendMessageHandler } from "./chat-details/types";
import { VoicePlaybackOverlay } from "./chat-details/voice-playback-overlay";
import {
  useVoicePlayback,
} from "../hooks";

export function ChatDetails({
  chatId,
  embeddedTaskId,
  embedded = false,
  isExternallyBusy = false,
  onSendMessage,
  showActivity = false,
  onCloseActivity,
  onOpenActivity,
  isVisible = true,
}: {
  chatId: string;
  embeddedTaskId?: string;
  embedded?: boolean;
  isExternallyBusy?: boolean;
  onSendMessage?: ChatSendMessageHandler;
  showActivity?: boolean;
  onCloseActivity?: () => void;
  onOpenActivity?: () => void;
  isVisible?: boolean;
}) {
  const toast = useToast();
  const isEmbedded = embedded || (typeof embeddedTaskId === "string" && embeddedTaskId.length > 0);
  const [embeddedActivity, setEmbeddedActivity] = useState(false);
  const {
    chat,
    transcript,
    loading,
    loadingTranscript,
    error,
    isActive,
    needsSshCredentials,
    refreshChat,
    loadMoreTranscript,
    loadFullTranscript,
    loadToolCallDetails,
    applyChatSnapshot,
    markChatStarting,
    handleReconnect,
  } = useChatLifecycle(chatId);
  const openActivity = useCallback(() => {
    if (isEmbedded) setEmbeddedActivity(true);
    else onOpenActivity?.();
  }, [isEmbedded, onOpenActivity]);
  const embeddedActions = useMemo(() => isEmbedded && isVisible ? harnessActivityActions({
    route: { view: "chat", chatId },
    capabilities: chat?.state.harness?.capabilities,
    onOpenActivity: openActivity,
    embeddedChat: true,
  }) : [], [isEmbedded, isVisible, chatId, chat?.state.harness?.capabilities, openActivity]);
  // The embedded chat is not the active sidebar entity; expose its distinct scope through the framework header.
  useHeaderActions({ overflow: embeddedActions });
  const voice = useConversationVoice();
  const refreshInput = useCallback(() => refreshChat({ showLoading: false }), [refreshChat]);
  const voicePlayback = useVoicePlayback();
  const handleReadAloud = useCallback((
    message: { id: string; content: string },
    mode: "full" | "summary",
  ): void => {
    const capability = mode === "summary"
      ?       voice.capabilities.text
      : voice.capabilities.speech;
    if (!capability.validated) {
      toast.error("This voice capability is not configured and validated.");
      return;
    }
    void voicePlayback.play(`${message.id}:${mode}`, message.content, mode);
  }, [
    toast,
    voicePlayback,
    voice.capabilities.speech,
    voice.capabilities.text,
  ]);
  const composerProps = useChatComposerAdapter({
    chat,
    chatId,
    isEmbedded,
    isActive,
    isExternallyBusy,
    needsSshCredentials,
    onChatSnapshot: applyChatSnapshot,
    markChatStarting,
    refreshChat,
    handleReconnect,
    onSendMessage,
    voice: voice.composer,
  });
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
    <HarnessEntityView
      kind="chat"
      entityId={chatId}
      showActivity={showActivity || (isEmbedded && embeddedActivity)}
      snapshot={chat.state.harness?.activity}
      capabilities={chat.state.harness?.capabilities}
      inputs={chat.state.harness?.inputs}
      onInputUpdated={refreshInput}
      onBack={() => {
        setEmbeddedActivity(false);
        onCloseActivity?.();
      }}
      onOpenActivity={isEmbedded || onOpenActivity ? openActivity : undefined}
    >
      <ChatTranscript
        chat={chat}
        transcript={transcript}
        lifecycleError={error}
        isActive={isActive}
        toolPathDisplayRoot={chatWorkingDirectory}
        fileLinkContext={fileLinkContext}
        onLoadToolDetails={loadToolCallDetails}
        onLoadMoreTranscript={loadMoreTranscript}
        onLoadFullTranscript={loadFullTranscript}
        loadingTranscript={loadingTranscript}
        voiceInput={{
          available: voice.composer.available,
          status: voice.composer.status,
          elapsedMs: voice.composer.elapsedMs,
          error: voice.composer.error,
        }}
        onStartVoice={voice.composer.start}
        onStopVoice={voice.composer.stop}
        onCancelVoice={voice.composer.cancel}
        onDismissVoiceError={voice.composer.dismissError}
        onReadAloud={handleReadAloud}
        readAloudAvailable={voice.capabilities.speech.validated}
        readAloudSummaryAvailable={
          voice.capabilities.speech.validated
          && voice.capabilities.text.validated
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
        harness={chat.state.harness}
        canSteer={chat.state.status === "streaming"}
        onRefresh={refreshInput}
        onChatSnapshot={applyChatSnapshot}
      />
      {composerProps && <ConversationComposer {...composerProps} />}
      <VoicePlaybackOverlay
        recovery={voicePlayback.playbackRecovery}
        onPlay={voicePlayback.retryPlayback}
        onCancel={voicePlayback.stop}
      />
    </HarnessEntityView>
  );
}
