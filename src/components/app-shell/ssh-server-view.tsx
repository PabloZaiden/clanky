import { useState } from "react";
import type { SshServer, SshServerSession } from "../../types";
import { Badge, Button, ConfirmModal } from "../common";
import type { ShellRoute } from "./shell-types";
import { ShellPanel, SummaryCard } from "./shell-panel";
import { EmptySection } from "./shell-sidebar";

export function SshServerView({
  server,
  sessions,
  headerOffsetClassName,
  onNavigate,
  onEditServer,
  onDeleteServer,
}: {
  server: SshServer;
  sessions: SshServerSession[];
  headerOffsetClassName?: string;
  onNavigate: (route: ShellRoute) => void;
  onEditServer: () => void;
  onDeleteServer: () => Promise<boolean>;
}) {
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  async function handleDeleteServer() {
    try {
      setDeleteSubmitting(true);
      const deleted = await onDeleteServer();
      if (deleted) {
        setDeleteConfirmOpen(false);
      }
    } finally {
      setDeleteSubmitting(false);
    }
  }

  const deleteMessage = sessions.length === 0
    ? `Delete "${server.config.name}"? This removes the saved SSH server metadata from Ralpher and any saved browser credential for this server.`
    : `Delete "${server.config.name}" and its ${sessions.length} standalone session${sessions.length === 1 ? "" : "s"}? This removes the saved SSH server metadata from Ralpher, any saved browser credential for this server, and cannot be undone.`;

  return (
    <ShellPanel
      eyebrow="SSH server"
      title={server.config.name}
      description={`${server.config.username}@${server.config.address}`}
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
      badges={(
        <Badge variant="default" size="sm">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </Badge>
      )}
      actions={(
        <>
          {server.config.repositoriesBasePath && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onNavigate({ view: "server-arise", serverId: server.config.id })}
              disabled={deleteSubmitting}
            >
              Arise
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={onEditServer}
            disabled={deleteSubmitting}
          >
            Edit Server
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => setDeleteConfirmOpen(true)}
            disabled={deleteSubmitting}
          >
            Delete Server
          </Button>
          <Button
            size="sm"
            onClick={() => onNavigate({ view: "compose", kind: "ssh-session", scopeId: server.config.id })}
            disabled={deleteSubmitting}
          >
            New Session
          </Button>
        </>
      )}
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <SummaryCard label="Address" value={server.config.address} meta="Stored without credentials on the server." />
        <SummaryCard label="Username" value={server.config.username} meta="Used for standalone SSH sessions." />
        <SummaryCard label="Saved sessions" value={sessions.length} meta="Standalone terminals attached to this host." />
        {server.config.repositoriesBasePath && (
          <SummaryCard label="Repositories base path" value={server.config.repositoriesBasePath} meta="Default base path for automatic provisioning." />
        )}
      </div>

      <div className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
        <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Standalone sessions</h2>
        <div className="space-y-2">
          {sessions.length === 0 ? (
            <EmptySection message="No standalone sessions yet for this SSH server." />
          ) : (
            sessions.map((session) => (
              <button
                key={session.config.id}
                type="button"
                onClick={() => onNavigate({ view: "ssh", sshSessionId: session.config.id })}
                className="flex w-full items-center justify-between rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300 hover:bg-gray-100 dark:border-gray-800 dark:bg-neutral-900 dark:hover:border-gray-700 dark:hover:bg-neutral-800"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {session.config.name}
                  </span>
                  <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                    {session.config.connectionMode === "direct" ? "Direct SSH" : "Persistent SSH"}
                  </span>
                </span>
                <Badge
                  variant={
                    session.state.status === "connected"
                      ? "success"
                      : session.state.status === "failed"
                        ? "error"
                        : "default"
                  }
                >
                  {session.state.status}
                </Badge>
              </button>
            ))
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={() => void handleDeleteServer()}
        title="Delete SSH Server"
        message={deleteMessage}
        confirmLabel="Delete Server"
        loading={deleteSubmitting}
        variant="danger"
      />
    </ShellPanel>
  );
}
