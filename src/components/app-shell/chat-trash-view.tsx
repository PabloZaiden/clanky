import { useState } from "react";
import { DataList, DataListRow, EmptyState, ErrorState, LoadingState, useHeaderActions } from "@pablozaiden/webapp/web";
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
  useHeaderActions({ overflow: actions.emptyActions });

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
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button size="sm" disabled={actions.pending} onClick={() => void actions.restore(chat)}>Restore</Button>
                  <Button size="sm" variant="danger" disabled={actions.pending} onClick={() => actions.requestDelete(chat)}>Delete permanently</Button>
                </div>
              }
            />
          )) : undefined}
        </DataList>
      )}
      <div className="flex flex-wrap justify-between gap-2">
        <div className="flex gap-2">
          {cursor ? <Button variant="secondary" onClick={() => setCursor(undefined)}>Newest</Button> : null}
          {trash.nextCursor ? <Button variant="secondary" onClick={() => setCursor(trash.nextCursor!)}>Older chats</Button> : null}
        </div>
        <Button variant="danger" disabled={actions.pending} onClick={actions.requestEmpty}>Empty Trash</Button>
      </div>
    </div>
  );
}
