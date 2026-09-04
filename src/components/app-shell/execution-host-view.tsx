import { useState } from "react";
import {
  CodeValue,
  ErrorState,
  FormGroup,
  Panel,
  TextField,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import type {
  ExecutionHostDescriptor,
  VncSession,
} from "@/shared";
import { apiRequest } from "../../lib/api-client";
import { Button } from "../common";
import { VncViewer } from "./VncViewer";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";

interface ExecutionHostViewProps {
  host: ExecutionHostDescriptor;
  provisioning: UseProvisioningJobResult;
  onNavigate: (route: WebAppRoute) => void;
}

function hostApiPath(host: ExecutionHostDescriptor): string {
  const id = host.ref.kind === "ssh" ? host.ref.serverId : host.ref.nodeId;
  return `/api/execution-hosts/${host.ref.kind}/${encodeURIComponent(id)}`;
}

export function ExecutionHostView({ host, provisioning, onNavigate }: ExecutionHostViewProps) {
  const [directory, setDirectory] = useState("/");
  const [vncPort, setVncPort] = useState("5900");
  const [vncUsername, setVncUsername] = useState("");
  const [vncPassword, setVncPassword] = useState("");
  const [vncSession, setVncSession] = useState<VncSession | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const available = host.availability === "local" || host.availability === "online";

  async function runAction<T>(name: string, action: () => Promise<T>): Promise<T | null> {
    setPendingAction(name);
    setError(null);
    try {
      return await action();
    } catch (actionError) {
      setError(String(actionError));
      return null;
    } finally {
      setPendingAction(null);
    }
  }

  async function createVncSession() {
    const remotePort = Number.parseInt(vncPort, 10);
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
      setError("VNC port must be between 1 and 65535.");
      return;
    }

    const session = await runAction("vnc", () => apiRequest<VncSession>(
      `${hostApiPath(host)}/vnc-sessions`,
      {
        method: "POST",
        body: JSON.stringify({ remotePort, credentialToken: null }),
        headers: { "Content-Type": "application/json" },
        action: "Start VNC session",
        fallbackMessage: "Failed to start VNC session",
      },
    ));
    if (session) {
      setVncSession(session);
    }
  }

  async function runArise() {
    const snapshot = await provisioning.startJob({
      name: host.name,
      executionHost: host.ref,
      repoUrl: "",
      basePath: host.repositoriesBasePath ?? "/workspaces",
      devcontainerSubpath: null,
      devboxTemplate: null,
      provider: "copilot",
      mode: "arise",
      targetDirectory: null,
      workspaceId: null,
    });
    if (snapshot) {
      onNavigate({
        view: "provisioning-job",
        provisioningJobId: snapshot.job.config.id,
        returnView: "execution-host",
        returnId: host.ref.kind === "ssh" ? host.ref.serverId : host.ref.nodeId,
      });
    }
  }

  return (
    <div className="space-y-6">
      {error ? <ErrorState description={error} /> : null}
      <Panel className="divide-y divide-gray-200 p-0 dark:divide-gray-800">
        <div className="grid gap-2 p-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
          <span className="text-sm font-medium">Transport</span>
          <span className="text-sm sm:text-right">{host.ref.kind.toUpperCase()}</span>
        </div>
        <div className="grid gap-2 p-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
          <span className="text-sm font-medium">Status</span>
          <span className="text-sm capitalize sm:text-right">{host.availability}</span>
        </div>
        <div className="grid gap-2 p-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
          <span className="text-sm font-medium">Target</span>
          <div className="min-w-0 overflow-x-auto sm:text-right">
            <CodeValue value={host.targetKey} />
          </div>
        </div>
      </Panel>

      <Panel>
        <TextField
          id="execution-host-directory"
          label="Target directory"
          value={directory}
          onChange={(event) => setDirectory(event.target.value)}
        />
      </Panel>

      <FormGroup title="Arise">
        <div>
          <Button
            variant="secondary"
            onClick={() => void runArise()}
            loading={provisioning.starting}
            disabled={!available || !host.capabilities.devboxLifecycle}
          >
            Run Arise
          </Button>
        </div>
      </FormGroup>

      <FormGroup title="VNC">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField
              id="execution-host-vnc-port"
              label="Remote port"
              inputMode="numeric"
              value={vncPort}
              onChange={(event) => setVncPort(event.target.value)}
            />
            <TextField
              id="execution-host-vnc-username"
              label="VNC username"
              value={vncUsername}
              onChange={(event) => setVncUsername(event.target.value)}
            />
            <TextField
              id="execution-host-vnc-password"
              label="VNC password"
              type="password"
              value={vncPassword}
              onChange={(event) => setVncPassword(event.target.value)}
            />
          </div>
          <Button
            variant="secondary"
            onClick={() => void createVncSession()}
            loading={pendingAction === "vnc"}
            disabled={!available || !host.capabilities.tcpTunnel}
          >
            {vncSession ? "Reconnect" : "Connect"}
          </Button>
          {vncSession ? (
            <Panel className="h-[min(65vh,48rem)] min-h-96 overflow-hidden p-0">
              <VncViewer
                session={vncSession}
                username={vncUsername || undefined}
                password={vncPassword || undefined}
                onDisconnect={() => setVncSession(null)}
                onError={setError}
              />
            </Panel>
          ) : null}
        </div>
      </FormGroup>
    </div>
  );
}
