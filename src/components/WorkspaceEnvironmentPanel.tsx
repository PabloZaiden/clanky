import { useState } from "react";
import { ConfirmDialog, ErrorState, LoadingState, Panel, useLiveQuery } from "@pablozaiden/webapp/web";
import { CLANKY_REALTIME_RESOURCES } from "@/shared/realtime";
import type { WorkspaceEnvironmentStatus } from "@/contracts";
import { apiRequest } from "../lib/api-client";
import { Button, StatusBadge } from "./common";

export function WorkspaceEnvironmentPanel({ workspaceId, name }: { workspaceId: string; name: string }) {
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/environment`;
  const query = useLiveQuery<WorkspaceEnvironmentStatus>({
    load: async (signal) => await apiRequest<WorkspaceEnvironmentStatus>(path, {
      signal, action: "Read workspace environment", fallbackMessage: "Cannot inspect the environment on its provisioning host.",
    }),
    realtime: { resources: [CLANKY_REALTIME_RESOURCES.workspaces, CLANKY_REALTIME_RESOURCES.provisioningJobs, CLANKY_REALTIME_RESOURCES.mesh] },
    deps: [workspaceId],
  });
  const [confirm, setConfirm] = useState<"stop" | "remove" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function mutate() {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(confirm === "stop" ? `${path}/stop` : path, {
        method: confirm === "stop" ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        ...(confirm === "remove" ? { body: JSON.stringify({ resetCredentials: false }) } : {}),
        action: confirm === "stop" ? "Stop workspace environment" : "Remove workspace container",
        fallbackMessage: "The environment operation could not be confirmed. Inspect the provisioning host before retrying.",
      });
      setConfirm(null);
      await query.refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  return (
    <Panel title="Environment" actions={<Button onClick={() => void query.refresh()} disabled={busy}>Refresh</Button>}>
      {!query.data && !query.error ? <LoadingState title="Reading environment" /> : null}
      {query.error || error ? <ErrorState title="Environment unavailable" description={error ?? String(query.error)} /> : null}
      {query.data ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge variant={query.data.running ? "completed" : "warning"}>{query.data.running ? "Running" : "Stopped"}</StatusBadge>
            {query.data.remoteUser ? <span className="text-sm">Tooling user: {query.data.remoteUser}</span> : null}
          </div>
          {query.data.updateWarning ? <p role="status" className="text-sm text-amber-700 dark:text-amber-300">{query.data.updateWarning}</p> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => setConfirm("stop")} disabled={busy || !query.data.running}>Stop</Button>
            <Button onClick={() => setConfirm("remove")} disabled={busy}>Remove container</Button>
          </div>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm !== null} loading={busy} title={confirm === "remove" ? `Remove ${name}'s container?` : `Stop ${name}'s environment?`}
        message={confirm === "remove"
          ? "Active agents and terminals will stop. Source and private credentials are preserved; restart or rebuild can recreate the container."
          : "Active agents and terminals in this environment will stop."}
        confirmLabel={confirm === "remove" ? "Remove container" : "Stop"}
        danger={confirm === "remove"} onCancel={() => setConfirm(null)} onConfirm={() => void mutate()}
      />
    </Panel>
  );
}
