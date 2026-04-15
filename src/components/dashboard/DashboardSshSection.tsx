/**
 * SSH collapsible section shown on the dashboard, containing SSH server management
 * and workspace SSH session list.
 */

import { CollapsibleSection } from "../common";
import { SshServerSection } from "../SshServerSection";
import { SshSessionSection } from "../SshSessionSection";
import type { SshServer, SshServerSession, SshSession, Workspace } from "../../types";

export interface DashboardSshSectionProps {
  sshServers: SshServer[];
  sessionsByServerId: Record<string, SshServerSession[]>;
  workspaces: Workspace[];
  workspacesLoaded: boolean;
  sshServersLoading: boolean;
  sshServersError: string | null;
  hasStoredCredential: (serverId: string) => boolean;
  sessions: SshSession[];
  sshSessionsLoading: boolean;
  sshSessionsError: string | null;
  onOpenCreateServer: () => void;
  onDeleteServer: (serverId: string) => Promise<void>;
  onCreateSession: (server: SshServer) => void;
  onSelectSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string) => void;
}

export function DashboardSshSection({
  sshServers,
  sessionsByServerId,
  workspaces,
  workspacesLoaded,
  sshServersLoading,
  sshServersError,
  hasStoredCredential,
  sessions,
  sshSessionsLoading,
  sshSessionsError,
  onOpenCreateServer,
  onDeleteServer,
  onCreateSession,
  onSelectSession,
  onRenameSession,
}: DashboardSshSectionProps) {
  return (
    <section className="border-b border-gray-200 pb-6 dark:border-gray-800">
      <CollapsibleSection
        title="SSH"
        count={sshServers.length + sessions.length}
        defaultCollapsed={true}
        idPrefix="ssh"
      >
        <div className="space-y-6">
          <SshServerSection
            servers={sshServers}
            sessionsByServerId={sessionsByServerId}
            loading={sshServersLoading}
            error={sshServersError}
            hasStoredCredential={hasStoredCredential}
            onOpenCreateServer={onOpenCreateServer}
            onDeleteServer={async (serverId) => {
              await onDeleteServer(serverId);
            }}
            onCreateSession={(server) => {
              onCreateSession(server);
            }}
            onSelectSession={(sessionId) => onSelectSession(sessionId)}
          />

          <div className="space-y-3">
            <div className="px-1">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Workspace SSH Sessions</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Saved terminal sessions for SSH-configured workspaces. Use persistent SSH to keep shells alive across
                reconnects, or direct SSH for a fresh shell. Sessions whose workspace is missing stay listed here so
                they can still be deleted.
              </p>
            </div>
            <SshSessionSection
              sessions={sessions}
              workspaces={workspaces}
              workspacesLoaded={workspacesLoaded}
              loading={sshSessionsLoading}
              error={sshSessionsError}
              onSelect={(sessionId) => onSelectSession(sessionId)}
              onRename={(sessionId) => onRenameSession(sessionId)}
            />
          </div>
        </div>
      </CollapsibleSection>
    </section>
  );
}
