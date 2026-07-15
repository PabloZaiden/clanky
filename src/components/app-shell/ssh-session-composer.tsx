import { useEffect, useId, useState, type FormEvent } from "react";
import type { SshConnectionMode, SshServer, Workspace } from "@/shared";
import { useSshServers, useSshSessions } from "../../hooks";
import { WorkspaceSelector } from "../WorkspaceSelector";
import { Button } from "../common";
import { Panel, useToast, type WebAppRoute } from "@pablozaiden/webapp/web";
import { useShellHeaderActions } from "./shell-header-actions";

const SSH_SESSION_USE_TMUX_STORAGE_KEY = "clanky.sshSession.useTmux";

function readStoredUseTmuxPreference(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(SSH_SESSION_USE_TMUX_STORAGE_KEY) === "true";
}

function storeUseTmuxPreference(useTmux: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(SSH_SESSION_USE_TMUX_STORAGE_KEY, String(useTmux));
}

export function SshSessionComposer({
  workspaces,
  servers,
  initialWorkspaceId,
  initialServerId,
  onCancel,
  onNavigate,
  onCreateWorkspaceSession,
  onCreateStandaloneSession,
}: {
  workspaces: Workspace[];
  servers: SshServer[];
  initialWorkspaceId?: string;
  initialServerId?: string;
  onCancel: () => void;
  onNavigate: (route: WebAppRoute) => void;
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
  const [useTmux, setUseTmux] = useState(readStoredUseTmuxPreference);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!initialWorkspaceId) {
      return;
    }
    setTargetType("workspace");
    setSelectedWorkspaceId(initialWorkspaceId);
  }, [initialWorkspaceId]);

  useEffect(() => {
    if (!initialServerId) {
      return;
    }
    setTargetType("server");
    setSelectedServerId(initialServerId);
  }, [initialServerId]);

  function handleUseTmuxChange(nextUseTmux: boolean): void {
    setUseTmux(nextUseTmux);
    storeUseTmuxPreference(nextUseTmux);
  }

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
          useTmux,
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
        useTmux,
      });
      onNavigate({ view: "ssh", sshSessionId: session.config.id });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSubmitting(false);
    }
  }

  useShellHeaderActions(
    <>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
        Cancel
      </Button>
      <Button type="submit" form={formId} size="sm" loading={submitting}>
        Create SSH Session
      </Button>
    </>,
  );

  return (
    <form id={formId} className="space-y-6 pt-1 sm:pt-0" onSubmit={(event) => void handleSubmit(event)}>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel padding="compact">
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
        </Panel>
        <Panel padding="compact">
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
        </Panel>
      </div>

      <Panel padding="compact">
        <label className="flex items-start gap-3" htmlFor="ssh-use-tmux">
          <input
            id="ssh-use-tmux"
            type="checkbox"
            checked={useTmux}
            onChange={(event) => handleUseTmuxChange(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-400 dark:border-gray-700 dark:bg-neutral-900 dark:text-gray-100 dark:focus:ring-gray-600"
          />
          <span>
            <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Start in tmux when available
            </span>
            <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
              Disable this if you want the session to open a normal interactive shell without trying tmux first.
            </span>
          </span>
        </label>
      </Panel>

      {targetType === "workspace" ? (
        <Panel padding="compact">
          <WorkspaceSelector
            workspaces={workspaces}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelect={(workspaceId) => setSelectedWorkspaceId(workspaceId ?? undefined)}
            registeredSshServers={servers}
          />
        </Panel>
      ) : (
        <Panel padding="compact">
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
        </Panel>
      )}
    </form>
  );
}
