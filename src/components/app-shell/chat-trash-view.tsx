import { useState } from "react";
import { ActionMenu, DataList, DataListRow, EmptyState, ErrorState, LoadingState } from "@pablozaiden/webapp/web";
import { useChatTrash } from "../../hooks/useChatTrash";
import { Button } from "../common";
import type { ChatTrashActions } from "./use-chat-trash-actions";

export function ChatTrashView({
  showPrivateItems,
  selectedChatId,
  actions,
}: {
  showPrivateItems: boolean;
  selectedChatId?: string;
  actions: ChatTrashActions;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const trash = useChatTrash(showPrivateItems, cursor);

  return (
    <div className="space-y-4">
      {trash.error ? <ErrorState title="Could not load Trash" description={trash.error} action={<Button onClick={() => void trash.refresh()}>Retry</Button>} /> : null}
      {trash.loading ? <LoadingState title="Loading Trash..." /> : (
        <DataList empty={<EmptyState title="Trash is empty" />}>
          {trash.items.length ? trash.items.map((chat) => (
            <DataListRow
              key={chat.id}
              title={chat.name}
              description={chat.origin}
              className={selectedChatId === chat.id ? "ring-1 ring-gray-400" : ""}
              meta={`Deleted ${new Date(chat.deletedAt).toLocaleDateString()} · Expires ${new Date(chat.expiresAt).toLocaleDateString()}`}
              metaPlacement="footer"
              actions={
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" variant="secondary" disabled={actions.pending} onClick={() => void actions.restore(chat)}>Restore</Button>
                  <ActionMenu
                    ariaLabel={`Actions for ${chat.name}`}
                    triggerVariant="ghost"
                    triggerSize="compact"
                    disabled={actions.pending}
                    items={actions.items(chat).filter((item) => item.id !== "restore")}
                  />
                </div>
              }
            />
          )) : undefined}
        </DataList>
      )}
      <div className="flex flex-wrap gap-2">
        {cursor ? <Button variant="secondary" onClick={() => setCursor(undefined)}>Newest</Button> : null}
        {trash.nextCursor ? <Button variant="secondary" onClick={() => setCursor(trash.nextCursor!)}>Older chats</Button> : null}
      </div>
      <div className="flex justify-end border-t border-gray-200 pt-4 dark:border-gray-800">
        <Button
          variant="ghost"
          tone="danger"
          disabled={actions.pending}
          onClick={actions.requestEmpty}
        >
          Empty Trash
        </Button>
      </div>
    </div>
  );
}
