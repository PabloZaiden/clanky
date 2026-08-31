import type { Chat, SshServer, SshServerSession } from "@/shared";
import {
  formatStatusLabel,
  getChatStatusBadgeVariant,
  getTerminalSessionStatusBadgeVariant,
  getTerminalSessionStatusLabel,
  StatusBadge,
} from "../common";
import { EmptyState, Panel, type WebAppRoute } from "@pablozaiden/webapp/web";
import { getPrivateContainerClassName, isEffectivelyPrivate, shouldObscurePrivateItem } from "../../lib/private-items";
import { ClankyListRow } from "./clanky-list-row";

function SummaryCard({
  label,
  value,
  meta,
  className = "",
}: {
  label: string;
  value: string | number;
  meta: string;
  className?: string;
}) {
  return (
    <Panel padding="compact" className={`min-w-0 ${className}`.trim()}>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-2 overflow-hidden break-words text-2xl font-semibold text-gray-950 [overflow-wrap:anywhere] sm:text-3xl dark:text-gray-100">{value}</p>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{meta}</p>
    </Panel>
  );
}

export function SshServerView({
  server,
  sessions,
  chats,
  onNavigate,
  showPrivateItems = false,
}: {
  server: SshServer;
  sessions: SshServerSession[];
  chats: Chat[];
  onNavigate: (route: WebAppRoute) => void;
  showPrivateItems?: boolean;
}) {
  const serverPrivateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(server.config), showPrivateItems);
  const activeChats = chats.filter((chat) => chat.state.status !== "done");
  const historyChats = chats.filter((chat) => chat.state.status === "done");

  function renderChatRow(chat: Chat) {
    const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(chat.config, [server.config]), showPrivateItems);
    return (
      <ClankyListRow
        key={chat.config.id}
        title={chat.config.name}
        description="Chat"
        badge={<StatusBadge variant={getChatStatusBadgeVariant(chat.state.status)}>{formatStatusLabel(chat.state.status)}</StatusBadge>}
        onClick={!privateHidden ? () => onNavigate({ view: "chat", chatId: chat.config.id }) : undefined}
        privateHidden={privateHidden}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-3">
        <SummaryCard label="Address" value={server.config.address} meta="Stored without credentials on the server." className={getPrivateContainerClassName(serverPrivateHidden)} />
        <SummaryCard label="Username" value={server.config.username} meta="Used for standalone SSH sessions." className={getPrivateContainerClassName(serverPrivateHidden)} />
        <SummaryCard label="Saved sessions" value={sessions.length} meta="Standalone terminals attached to this host." className={getPrivateContainerClassName(serverPrivateHidden)} />
        {server.config.repositoriesBasePath ? (
          <SummaryCard label="Repositories base path" value={server.config.repositoriesBasePath} meta="Default base path for automatic provisioning." className={getPrivateContainerClassName(serverPrivateHidden)} />
        ) : null}
      </div>

      <Panel title="Chats">
        <div>
          {activeChats.length === 0 ? (
            <EmptyState title="No active chats" description="Create a chat to connect to this SSH server." />
          ) : (
            <div className="space-y-2">{activeChats.map(renderChatRow)}</div>
          )}
        </div>
      </Panel>

      {historyChats.length > 0 ? (
        <Panel title="History" description="Chats marked as done.">
          <div className="space-y-2">{historyChats.map(renderChatRow)}</div>
        </Panel>
      ) : null}

      <Panel title="Standalone sessions">
        <div>
          {sessions.length === 0 ? (
            <EmptyState title="No standalone sessions yet" description="Create one to connect to this SSH server." />
          ) : (
            <div className="space-y-2">{sessions.map((session) => {
              const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(session.config, [server.config]), showPrivateItems);
              return (
                <ClankyListRow
                  key={session.config.id}
                  title={session.config.name}
                  description={session.config.connectionMode === "direct" ? "Direct SSH" : "Persistent SSH"}
                  badge={(
                    <StatusBadge variant={getTerminalSessionStatusBadgeVariant(session.state.status)}>
                      {getTerminalSessionStatusLabel(session.state.status)}
                    </StatusBadge>
                  )}
                  onClick={!privateHidden ? () => onNavigate({ view: "ssh", sshServerSessionId: session.config.id }) : undefined}
                  privateHidden={privateHidden}
                />
              );
            })}</div>
          )}
        </div>
      </Panel>
    </div>
  );
}
