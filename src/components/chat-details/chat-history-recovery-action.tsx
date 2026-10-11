import { useState } from "react";
import type { Chat } from "@/shared";
import { ConfirmModal } from "@pablozaiden/webapp/web";
import { Button } from "../common";

export function ChatHistoryRecoveryAction({
  chat,
  isPending,
  onContinue,
}: {
  chat: Chat;
  isPending: boolean;
  onContinue: () => Promise<boolean>;
}) {
  const [isOpen, setIsOpen] = useState(false);

  if (chat.state.status !== "failed") {
    return null;
  }

  const confirmContinue = async (): Promise<void> => {
    if (await onContinue()) {
      setIsOpen(false);
    }
  };

  return (
    <>
      <div className="mx-4 mt-3 flex flex-col gap-2 rounded-md border border-gray-200 p-3 sm:flex-row sm:items-center sm:justify-between dark:border-gray-700">
        <span className="text-sm text-gray-700 dark:text-gray-300">
          Start a new agent session using this chat&apos;s saved history.
        </span>
        <Button
          size="sm"
          loading={isPending}
          onClick={() => setIsOpen(true)}
        >
          Continue from history
        </Button>
      </div>
      <ConfirmModal
        isOpen={isOpen}
        onClose={() => {
          if (!isPending) {
            setIsOpen(false);
          }
        }}
        onConfirm={() => void confirmContinue()}
        title="Continue from history?"
        message="This creates a new provider session from the saved transcript. The old session may still exist; earlier messages, queued inputs, and tool actions will not be replayed."
        confirmLabel="Continue from history"
        loading={isPending}
      />
    </>
  );
}
