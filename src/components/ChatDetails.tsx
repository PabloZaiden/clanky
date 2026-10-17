import { useCallback, useEffect, useMemo, useState } from "react";
import { type TranscriptFileLinkContext, type TranscriptFileLinkTarget } from "./log-viewer";
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
import { ChatHistoryRecoveryAction } from "./chat-details/chat-history-recovery-action";
import { HarnessEntityView } from "./harness-activity";
import { harnessActivityActions } from "./app-shell/harness-actions";
import type { ChatSendMessageHandler } from "./chat-details/types";
import { VoicePlaybackOverlay } from "./chat-details/voice-playback-overlay";
import { useLiveVoiceBusy } from "../lib/voice-audio-ownership";
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
  onMissingEntity,
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
  onMissingEntity?: () => void;
  isVisible?: boolean;
}) {
  const { error: notifyError } = useToast();
  const isEmbedded = embedded || (typeof embeddedTaskId === "string" && embeddedTaskId.length > 0);
  const [embeddedActivity, setEmbeddedActivity] = useState(false);
  const [questionAnswerInputFocused, setQuestionAnswerInputFocused] = useState(false);
  useEffect(() => {
    setQuestionAnswerInputFocused(false);
  }, [chatId]);
  const {
    chat,
    transcript,
    loading,
    loadingTranscript,
    error,
    notFound,
    isActive,
    needsSshCredentials,
    refreshChat,
    refreshChatCoalesced,
    loadMoreTranscript,
    loadFullTranscript,
    loadToolCallDetails,
    applyChatSnapshot,
    markChatStarting,
    handleReconnect,
    handleContinueFromHistory,
    isContinuingFromHistory,
  } = useChatLifecycle(chatId);
  useEffect(() => {
    if (!isEmbedded && notFound) {
      onMissingEntity?.();
    }
  }, [isEmbedded, notFound, onMissingEntity]);
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
  const liveVoiceBusy = useLiveVoiceBusy();
  const refreshInput = useCallback(
    () => refreshChatCoalesced({ showLoading: false }),
    [refreshChatCoalesced],
  );
  const voicePlayback = useVoicePlayback();
  const playReadAloud = voicePlayback.play;
  const handleReadAloud = useCallback((messageId: string): void => {
    if (liveVoiceBusy) {
      notifyError("End Live voice before using read aloud.");
      return;
    }
    if (!voice.capabilities.text.validated) {
      notifyError("The text provider must be configured and validated for summaries.");
      return;
    }
    if (!voice.speechAvailable) {
      notifyError("Local Piper speech is not supported on this server.");
      return;
    }
    void playReadAloud(chatId, messageId);
  }, [
    chatId,
    notifyError,
    playReadAloud,
    voice.capabilities.text.validated,
    voice.speechAvailable,
    liveVoiceBusy,
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
  const linkedChatId = chat?.config.id;
  const executionHost = chat?.config.source?.kind === "execution_host"
    ? chat.config.source.executionHost.host
    : undefined;
  const executionHostKind = executionHost?.kind;
  const fileExplorerTargetId = chat
    ? executionHost
      ? getExecutionHostSourceId(executionHost)
      : getChatWorkspaceId(chat)
    : undefined;
  const fileLinkContext = useMemo<TranscriptFileLinkContext | undefined>(() => {
    if (!linkedChatId || !fileExplorerTargetId || !chatWorkingDirectory) {
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
            chatId: linkedChatId,
            startDirectory,
            filePath: kind === "directory" ? undefined : path,
          }
    );
    const fileExplorerTarget = executionHostKind
      ? {
          type: "executionHost" as const,
          id: fileExplorerTargetId,
          kind: executionHostKind,
          startDirectory: chatWorkingDirectory,
        }
      : {
            type: "workspace" as const,
            id: fileExplorerTargetId,
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
        notifyError(message);
      },
    };
  }, [linkedChatId, fileExplorerTargetId, executionHostKind, chatWorkingDirectory, embeddedTaskId, notifyError]);

  if (loading && (!chat || !transcript.revision)) {
    return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading chat…</div>;
  }

  if (!chat) {
    if (notFound && onMissingEntity && !isEmbedded) {
      return null;
    }
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
      <ChatHistoryRecoveryAction
        chat={chat}
        isPending={isContinuingFromHistory}
        onContinue={handleContinueFromHistory}
      />
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
        onChatSnapshot={applyChatSnapshot}
        onQuestionAnswerFocusChange={setQuestionAnswerInputFocused}
        onReadAloud={handleReadAloud}
        readAloudAvailable={
          voice.speechAvailable && !liveVoiceBusy
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
      {composerProps && (
        <ConversationComposer
          {...composerProps}
          questionAnswerInputFocused={questionAnswerInputFocused}
        />
      )}
      <VoicePlaybackOverlay
        recovery={voicePlayback.playbackRecovery}
        onPlay={voicePlayback.retryPlayback}
        onCancel={voicePlayback.stop}
      />
    </HarnessEntityView>
  );
}
