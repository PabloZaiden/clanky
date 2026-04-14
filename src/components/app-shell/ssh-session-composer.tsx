import { useEffect, useId, useState, type FormEvent } from "react";
import type { SshConnectionMode, SshServer, Workspace } from "../../types";
import { useSshServers, useSshSessions, useToast } from "../../hooks";
import { WorkspaceSelector } from "../WorkspaceSelector";
import { Button } from "../common";
import type { ShellRoute } from "./shell-types";
import { ShellPanel } from "./shell-panel";

export function SshSessionComposer({
  workspaces,
  servers,
  initialWorkspaceId,
  initialServerId,
  headerOffsetClassName,
  onCancel,
  onNavigate,
  onCreateWorkspaceSession,
  onCreateStandaloneSession,
}: {
  workspaces: Workspace[];
  servers: SshServer[];
  initialWorkspaceId?: string;
  initialServerId?: string;
  headerOffsetClassName?: string;
  onCancel: () => void;
  onNavigate: (route: ShellRoute) => void;
  onCreateWorkspaceSession: ReturnType<typeof useSshSessions>["createSession"];
  onCreateStandaloneSession: ReturnType<typeof useSshServers>["createSession"];
}) {
  const toast = useToast();
  const formId = useId();
  const [targetType, setTargetType] = useState<"workspace" | "server">(
    initialWorkspaceId ? "workspace" : initialServerId ? "server" : (workspaces.length > 0 ? "workspace" : "server"),
  );
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>(initialWorkspaceId ?? workspaces[0]?.id);
  const [selectedServerId, setSelectedServerId] = useState(initialServerId ?? servers[0]?.config.id ?? "");
  const [connectionMode, setConnectionMode] = useState<SshConnectionMode>("dtach");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!selectedWorkspaceId && (initialWorkspaceId || workspaces[0])) {
      setSelectedWorkspaceId(initialWorkspaceId ?? workspaces[0]?.id);
    }
  }, [initialWorkspaceId, selectedWorkspaceId, workspaces]);

  useEffect(() => {
    if (!selectedServerId && servers[0]) {
      setSelectedServerId(servers[0].config.id);
    }
  }, [selectedServerId, servers]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      if (targetType === "workspace") {
        if (!selectedWorkspaceId) {
          toast.error("Select an SSH workspace first.");
          return;
        }
        const session = await onCreateWorkspaceSession({
          workspaceId: selectedWorkspaceId,
          name: "SSH session",
          connectionMode,
        });
        onNavigate({ view: "ssh", sshSessionId: session.config.id });
        return;
      }

      if (!selectedServerId) {
        toast.error("Select a server first.");
        return;
      }

      const session = await onCreateStandaloneSession(selectedServerId, {
        name: "SSH session",
        connectionMode,
      });
      onNavigate({ view: "ssh", sshSessionId: session.config.id });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ShellPanel
      eyebrow="SSH session"
      title="Create an SSH session"
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
      actions={(
        <>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form={formId} size="sm" loading={submitting}>
            Create SSH Session
          </Button>
        </>
      )}
    >
      <form id={formId} className="space-y-6" onSubmit={(event) => void handleSubmit(event)}>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-neutral-950/50">
            <label htmlFor="ssh-target-type" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Target type
            </label>
            <select
              id="ssh-target-type"
              value={targetType}
              onChange={(event) => setTargetType(event.target.value as "workspace" | "server")}
              className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 shadow-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100 dark:focus:border-gray-500 dark:focus:ring-gray-700"
            >
              <option value="workspace">Workspace</option>
              <option value="server">Standalone SSH server</option>
            </select>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-neutral-950/50">
            <label htmlFor="ssh-connection-mode" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Connection mode
            </label>
            <select
              id="ssh-connection-mode"
              value={connectionMode}
              onChange={(event) => setConnectionMode(event.target.value as SshConnectionMode)}
              className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 shadow-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100 dark:focus:border-gray-500 dark:focus:ring-gray-700"
            >
              <option value="dtach">Persistent SSH</option>
              <option value="direct">Direct SSH</option>
            </select>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Persistent SSH survives reconnects; direct SSH is better for one-off debugging sessions.
            </p>
          </div>
        </div>

        {targetType === "workspace" ? (
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-neutral-950/50">
            <WorkspaceSelector
              workspaces={workspaces}
              selectedWorkspaceId={selectedWorkspaceId}
              onSelect={(workspaceId) => setSelectedWorkspaceId(workspaceId ?? undefined)}
              registeredSshServers={servers}
            />
          </div>
        ) : (
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-neutral-950/50">
            <label htmlFor="ssh-server" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Server
            </label>
            <select
              id="ssh-server"
              value={selectedServerId}
              onChange={(event) => setSelectedServerId(event.target.value)}
              className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 shadow-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100 dark:focus:border-gray-500 dark:focus:ring-gray-700"
            >
              <option value="">Select a server…</option>
              {servers.map((server) => (
                <option key={server.config.id} value={server.config.id}>
                  {server.config.name} — {server.config.username}@{server.config.address}
                </option>
              ))}
            </select>
            {servers.length === 0 && (
              <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">
                Register a standalone SSH server first.
              </p>
            )}
          </div>
        )}

      </form>
    </ShellPanel>
  );
}
