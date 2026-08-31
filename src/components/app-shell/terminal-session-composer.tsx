import { useEffect, useId, useState, type FormEvent } from "react";
import type { Workspace, WorkspaceTerminalSession, TerminalConnectionMode } from "@/shared";
import type { CreateTerminalSessionRequest } from "@/contracts";
import { WorkspaceSelector } from "../WorkspaceSelector";
import { Button } from "../common";
import { Panel, useToast, type WebAppRoute } from "@pablozaiden/webapp/web";
import { useShellHeaderActions } from "./shell-header-actions";

const TERMINAL_USE_TMUX_STORAGE_KEY = "clanky.terminalSession.useTmux";

function readStoredUseTmuxPreference(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem(TERMINAL_USE_TMUX_STORAGE_KEY) === "true";
}

function storeUseTmuxPreference(useTmux: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(TERMINAL_USE_TMUX_STORAGE_KEY, String(useTmux));
}

export function TerminalSessionComposer({
  workspaces,
  initialWorkspaceId,
  onCancel,
  onNavigate,
  onCreateTerminalSession,
}: {
  workspaces: Workspace[];
  initialWorkspaceId?: string;
  onCancel: () => void;
  onNavigate: (route: WebAppRoute) => void;
  onCreateTerminalSession: (request: CreateTerminalSessionRequest) => Promise<WorkspaceTerminalSession>;
}) {
  const toast = useToast();
  const formId = useId();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>(initialWorkspaceId ?? workspaces[0]?.id);
  const [name, setName] = useState("");
  const [connectionMode, setConnectionMode] = useState<TerminalConnectionMode>("dtach");
  const [useTmux, setUseTmux] = useState(readStoredUseTmuxPreference);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    storeUseTmuxPreference(useTmux);
  }, [useTmux]);

  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId);

  useShellHeaderActions(
    <>
      <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      <Button variant="primary" size="sm" type="submit" form={formId} disabled={submitting || !selectedWorkspace}>
        {submitting ? "Creating…" : "Create terminal"}
      </Button>
    </>,
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedWorkspace || submitting) {
      return;
    }

    setSubmitting(true);
    try {
      const sessionName = name.trim() || `${selectedWorkspace.name} terminal`;
      const session = await onCreateTerminalSession({
        workspaceId: selectedWorkspace.id,
        name: sessionName,
        connectionMode,
        useTmux: connectionMode === "dtach" ? useTmux : undefined,
      });
      onNavigate({ view: "terminal", terminalSessionId: session.config.id });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Panel title="New terminal session">
      <form id={formId} onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Workspace</label>
          <WorkspaceSelector
            workspaces={workspaces}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelect={(id) => setSelectedWorkspaceId(id ?? undefined)}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Name (optional)</label>
          <input
            type="text"
            className="w-full rounded border px-3 py-2 text-sm bg-inherit"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={selectedWorkspace ? `${selectedWorkspace.name} terminal` : "Terminal session"}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Session type</label>
          <select
            className="w-full rounded border px-3 py-2 text-sm bg-inherit"
            value={connectionMode}
            onChange={(e) => setConnectionMode(e.target.value as TerminalConnectionMode)}
          >
            <option value="dtach">Persistent (dtach)</option>
            <option value="direct">Direct</option>
          </select>
        </div>

        {connectionMode === "dtach" && (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="terminal-use-tmux"
              checked={useTmux}
              onChange={(e) => setUseTmux(e.target.checked)}
            />
            <label htmlFor="terminal-use-tmux" className="text-sm">
              Use tmux inside session
            </label>
          </div>
        )}
      </form>
    </Panel>
  );
}
