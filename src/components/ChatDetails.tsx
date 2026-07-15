import { useMemo } from "react";
import { type TranscriptFileLinkTarget } from "./LogViewer";
import { Button } from "./common";
import { appAbsoluteUrl } from "../lib/public-path";
import { replaceWebAppRoute, routeToHash, useToast, type WebAppRoute } from "@pablozaiden/webapp/web";
import { useChatLifecycle } from "./chat-details/chat-lifecycle";
import { ChatComposer } from "./chat-details/chat-composer";
import {
  ChatPermissionPanel,
  ChatQueuedMessagesPanel,
} from "./chat-details/chat-support-panels";
import { ChatTranscript } from "./chat-details/chat-transcript";

export function ChatDetails({
  chatId,
  onBack,
  showBackButton = true,
  embeddedTaskId,
}: {
  chatId: string;
  onBack?: () => void;
  showBackButton?: boolean;
  embeddedTaskId?: string;
}) {
  const toast = useToast();
  const isEmbedded = typeof embeddedTaskId === "string" && embeddedTaskId.length > 0;
  const {
    chat,
    loading,
    error,
    isActive,
    needsSshCredentials,
    refreshChat,
    applyChatSnapshot,
    markChatStarting,
    handleReconnect,
  } = useChatLifecycle(chatId);
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

    return {
      fileExplorerTarget: {
        type: "workspace" as const,
        id: chat.config.workspaceId,
        startDirectory: chatWorkingDirectory,
      },
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
          {showBackButton && onBack && (
            <Button type="button" variant="ghost" size="sm" onClick={onBack}>
              ← Back
            </Button>
          )}
          <div className="mt-4 min-w-0">
            <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">Not found</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">{error ?? "Chat not found"}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex h-full min-h-0 flex-col bg-white ${isEmbedded ? "dark:bg-neutral-800" : "dark:bg-neutral-900"}`}>
      <ChatTranscript
        chat={chat}
        lifecycleError={error}
        isActive={isActive}
        toolPathDisplayRoot={chatWorkingDirectory}
        fileLinkContext={fileLinkContext}
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
        onChatSnapshot={applyChatSnapshot}
        markChatStarting={markChatStarting}
        refreshChat={refreshChat}
        handleReconnect={handleReconnect}
      />
    </div>
  );
}
