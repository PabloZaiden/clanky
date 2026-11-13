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
import { ChatDiffView, ChatPlanView } from "./chat-details/chat-inspection";
import type { ChatSendMessageHandler } from "./chat-details/types";
import { VoicePlaybackOverlay } from "./chat-details/voice-playback-overlay";
import { useLiveVoiceBusy } from "../lib/voice-audio-ownership";
import { useWorkspaceReadOnly } from "../context/workspace-access-context";
import {
  useVoicePlayback,
} from "../hooks";

export function ChatDetails({
  chatId,
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
  const readOnly = useWorkspaceReadOnly();
  const isEmbedded = embedded;
  const [embeddedActivity, setEmbeddedActivity] = useState(false);
  const [contentView, setContentView] = useState<"conversation" | "plan" | "diff">("conversation");
  const [visitedViews, setVisitedViews] = useState({ plan: false, diff: false });
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
    refreshChat,
    loadMoreTranscript,
    loadFullTranscript,
    loadToolCallDetails,
    applyChatSnapshot,
    markChatStarting,
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
  const showInspection = useCallback((view: "conversation" | "plan" | "diff") => {
    setEmbeddedActivity(false);
    onCloseActivity?.();
    setContentView(view);
    if (view !== "conversation") setVisitedViews((current) => ({ ...current, [view]: true }));
  }, [onCloseActivity]);
  const inspectionActions = useMemo(() => isVisible ? [
    { id: "chat-plan", label: "Plan", onAction: () => showInspection("plan") },
    { id: "chat-diff", label: "Diff", onAction: () => showInspection("diff") },
    ...(isEmbedded ? harnessActivityActions({
      route: { view: "chat", chatId },
      capabilities: chat?.state.harness?.capabilities,
      onOpenActivity: openActivity,
      embeddedChat: true,
    }) : []),
  ] : [], [isVisible, isEmbedded, chatId, chat?.state.harness?.capabilities, openActivity, showInspection]);
  useHeaderActions({
    overflow: inspectionActions,
  });
  const voice = useConversationVoice();
  const liveVoiceBusy = useLiveVoiceBusy();
  const refreshInput = useCallback(
    () => refreshChat(),
    [refreshChat],
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
    onChatSnapshot: applyChatSnapshot,
    markChatStarting,
    refreshChat,
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
      {
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
  }, [linkedChatId, fileExplorerTargetId, executionHostKind, chatWorkingDirectory, notifyError]);

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
      binding={chat.state.session?.binding}
      fileLinkContext={fileLinkContext}
      onInputUpdated={refreshInput}
      onBack={() => {
        setEmbeddedActivity(false);
        onCloseActivity?.();
      }}
      onOpenActivity={isEmbedded || onOpenActivity ? openActivity : undefined}
      footer={<>
        <fieldset disabled={readOnly} className="min-w-0 shrink-0">
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
        </fieldset>
        {!readOnly && composerProps && (
          <ConversationComposer
            {...composerProps}
            questionAnswerInputFocused={contentView === "conversation" && !showActivity && !embeddedActivity && questionAnswerInputFocused}
          />
        )}
        <VoicePlaybackOverlay
          recovery={voicePlayback.playbackRecovery}
          onPlay={voicePlayback.retryPlayback}
          onCancel={voicePlayback.stop}
        />
      </>}
    >
      {chat.config.creator || contentView !== "conversation" ? (
        <div className="flex min-w-0 shrink-0 items-center gap-3 px-3 py-1 text-xs text-gray-500 dark:text-gray-400 sm:px-4">
          {chat.config.creator ? (
            <p className="min-w-0 truncate py-1" title={`Created by ${chat.config.creator.name}`}>
              Created by {chat.config.creator.name}
            </p>
          ) : null}
          {contentView !== "conversation" ? (
            <button type="button" className="shrink-0 py-1 underline decoration-dotted underline-offset-2 hover:text-gray-900 dark:hover:text-gray-100"
              onClick={() => showInspection("conversation")}>Back to chat</button>
          ) : null}
        </div>
      ) : null}
      {!readOnly && <ChatHistoryRecoveryAction
        chat={chat}
        isPending={isContinuingFromHistory}
        onContinue={handleContinueFromHistory}
      />}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className={`absolute inset-0 flex min-h-0 min-w-0 flex-col ${contentView !== "conversation" ? "invisible" : ""}`}
          inert={contentView !== "conversation" || undefined}
          aria-hidden={contentView !== "conversation" || undefined}
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
        </div>
        {visitedViews.plan ? (
          <div
            className={`dark-scrollbar absolute inset-0 min-w-0 overflow-x-hidden overflow-y-auto ${contentView !== "plan" ? "invisible" : ""}`}
            inert={contentView !== "plan" || undefined}
            aria-hidden={contentView !== "plan" || undefined}
            data-testid="chat-plan-view"
          >
            <ChatPlanView chatId={chatId} visible={isVisible && contentView === "plan" && !showActivity && !embeddedActivity} active={isActive} />
          </div>
        ) : null}
        {visitedViews.diff ? (
          <div
            className={`dark-scrollbar absolute inset-0 min-w-0 overflow-x-hidden overflow-y-auto ${contentView !== "diff" ? "invisible" : ""}`}
            inert={contentView !== "diff" || undefined}
            aria-hidden={contentView !== "diff" || undefined}
            data-testid="chat-diff-view"
          >
            <ChatDiffView chatId={chatId} visible={isVisible && contentView === "diff" && !showActivity && !embeddedActivity} active={isActive} />
          </div>
        ) : null}
      </div>
    </HarnessEntityView>
  );
}
