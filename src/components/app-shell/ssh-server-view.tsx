import { useCallback, useEffect, useMemo, useState } from "react";
import type { SshServer, SshServerSession } from "../../types";
import type { VncSession } from "../../types";
import { ActionMenu, Badge, Button, GearIcon, insertPinActionItem } from "../common";
import { useToast } from "../../hooks";
import { closeVncSessionApi, createOrResumeVncSessionApi, listVncSessionsApi } from "../../hooks/sshServerActions";
import type { ShellRoute } from "./shell-types";
import type { SidebarPinningState } from "./sidebar-pins";
import { ShellPanel, SummaryCard } from "./shell-panel";
import { EmptySection } from "./shell-sidebar";
import { buildSshServerActionItems } from "./shell-action-items";
import { VncViewer } from "./VncViewer";

const DEFAULT_VNC_PORT = 5900;

function getVncPortStorageKey(serverId: string): string {
  return `clanky:vnc:${serverId}:remotePort`;
}

export function SshServerView({
  server,
  sessions,
  headerOffsetClassName,
  onNavigate,
  onOpenSettings,
  sidebarPinning,
}: {
  server: SshServer;
  sessions: SshServerSession[];
  headerOffsetClassName?: string;
  onNavigate: (route: ShellRoute) => void;
  onOpenSettings: () => void;
  sidebarPinning: SidebarPinningState;
}) {
  const toast = useToast();
  const [vncSessions, setVncSessions] = useState<VncSession[]>([]);
  const [activeVncSessionId, setActiveVncSessionId] = useState<string | null>(null);
  const [vncPassword, setVncPassword] = useState("");
  const [vncBusy, setVncBusy] = useState(false);

  const refreshVncSessions = useCallback(async () => {
    try {
      const nextSessions = await listVncSessionsApi(server.config.id);
      setVncSessions(nextSessions);
    } catch (error) {
      toast.error(String(error));
    }
  }, [server.config.id, toast]);

  useEffect(() => {
    void refreshVncSessions();
  }, [refreshVncSessions]);

  const connectedVncSession = useMemo(() => {
    return vncSessions.find((session) => session.state.status === "active") ?? null;
  }, [vncSessions]);
  const activeVncSession = vncSessions.find((session) => session.config.id === activeVncSessionId) ?? connectedVncSession;

  const startOrResumeVnc = useCallback(async () => {
    const storedPort = window.localStorage.getItem(getVncPortStorageKey(server.config.id));
    const rawPort = window.prompt("VNC port on the SSH server", storedPort ?? String(DEFAULT_VNC_PORT));
    if (rawPort === null) {
      return;
    }
    const remotePort = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      toast.error("Enter a valid VNC port.");
      return;
    }
    const password = window.prompt("SSH password for this server") ?? "";
    const viewerPassword = window.prompt("VNC password for this session (not saved)") ?? "";
    setVncBusy(true);
    try {
      window.localStorage.setItem(getVncPortStorageKey(server.config.id), String(remotePort));
      const session = await createOrResumeVncSessionApi({
        serverId: server.config.id,
        remotePort,
        password,
      });
      setVncPassword(viewerPassword);
      setActiveVncSessionId(session.config.id);
      await refreshVncSessions();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setVncBusy(false);
    }
  }, [refreshVncSessions, server.config.id, toast]);

  const closeVnc = useCallback(async () => {
    const session = connectedVncSession ?? activeVncSession;
    if (!session) {
      return;
    }
    setVncBusy(true);
    try {
      await closeVncSessionApi(session.config.id);
      setActiveVncSessionId(null);
      setVncPassword("");
      await refreshVncSessions();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setVncBusy(false);
    }
  }, [activeVncSession, connectedVncSession, refreshVncSessions, toast]);

  const serverPinnedItem = { kind: "ssh-server" as const, id: server.config.id };
  const vncItems = [
    {
      id: "start-resume-vnc",
      label: connectedVncSession ? "Reconnect to VNC" : "Start VNC Session",
      onClick: startOrResumeVnc,
      disabled: vncBusy,
    },
    ...(connectedVncSession
      ? [{
          id: "close-vnc",
          label: "Close VNC Connection",
          onClick: closeVnc,
          disabled: vncBusy,
          destructive: true,
        }]
      : []),
  ];
  const actionItems = insertPinActionItem([...vncItems, ...buildSshServerActionItems({ server, onNavigate })], {
      id: "toggle-sidebar-pin",
      label: sidebarPinning.isPinned(serverPinnedItem) ? "Unpin from sidebar" : "Pin to sidebar",
      onClick: () => sidebarPinning.togglePinned(serverPinnedItem),
  });

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
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSettings}
            title="SSH Server Settings"
            aria-label="Open SSH server settings"
            className="min-h-[44px] min-w-[44px] px-1.5 sm:min-h-0 sm:min-w-0"
            icon={<GearIcon size="h-5 w-5" />}
          >
            {null}
          </Button>
          <ActionMenu items={actionItems} ariaLabel={`SSH server actions for ${server.config.name}`} />
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

      {activeVncSession && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">VNC session</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Connected to 127.0.0.1:{activeVncSession.config.remotePort} on this SSH server.
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={closeVnc} disabled={vncBusy}>
              Close VNC Connection
            </Button>
          </div>
          {activeVncSession.state.status === "active" ? (
            <VncViewer
              session={activeVncSession}
              password={vncPassword}
              onDisconnect={() => void refreshVncSessions()}
            />
          ) : (
            <EmptySection message={`VNC session is ${activeVncSession.state.status}. Use the server menu to reconnect.`} />
          )}
        </div>
      )}

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
    </ShellPanel>
  );
}
