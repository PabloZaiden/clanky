import { useEffect, useState, type ReactNode } from "react";
import { ConfirmModal, useToast } from "@pablozaiden/webapp/web";
import type { UseMeshResult } from "../../hooks";
import { Badge, Button } from "../common";
import { SettingsError, SettingsInput } from "./settings-row-controls";

const WORKER_KILL_COUNTDOWN_SECONDS = 15;

interface MeshSettingsContentProps {
  mesh: UseMeshResult;
}

function MeshFormField({
  id,
  label,
  description,
  children,
}: {
  id: string;
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
      </label>
      <p id={`${id}-description`} className="text-xs text-gray-600 dark:text-gray-300">
        {description}
      </p>
      {children}
    </div>
  );
}

export function MeshSettingsContent({ mesh }: MeshSettingsContentProps) {
  const toast = useToast();
  const [instanceName, setInstanceName] = useState("");
  const [meshEndpoint, setMeshEndpoint] = useState("");
  const [tokenName, setTokenName] = useState("Mesh worker");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [revokeWorkerNodeId, setRevokeWorkerNodeId] = useState<string | null>(null);
  const [removeWorkerNodeId, setRemoveWorkerNodeId] = useState<string | null>(null);
  const [killWorkerNodeId, setKillWorkerNodeId] = useState<string | null>(null);
  const [killingWorkerNodeId, setKillingWorkerNodeId] = useState<string | null>(null);
  const [killCountdown, setKillCountdown] = useState<number | null>(null);

  useEffect(() => {
    if (mesh.mutationError) toast.error(mesh.mutationError);
  }, [mesh.mutationError, toast]);

  useEffect(() => {
    if (!killingWorkerNodeId) {
      setKillCountdown(null);
      return;
    }
    setKillCountdown(WORKER_KILL_COUNTDOWN_SECONDS);
    const interval = window.setInterval(() => {
      setKillCountdown((current) => current === null ? null : Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [killingWorkerNodeId]);

  useEffect(() => {
    if (!killingWorkerNodeId || killCountdown !== 0) return;
    setKillingWorkerNodeId(null);
    setKillCountdown(null);
    void mesh.refresh({ showLoading: false });
  }, [killCountdown, killingWorkerNodeId, mesh.refresh]);

  useEffect(() => {
    setInstanceName(mesh.status?.node.instanceName ?? "");
    setMeshEndpoint(mesh.status?.node.meshEndpoint ?? "");
  }, [mesh.status?.node.instanceName, mesh.status?.node.meshEndpoint]);

  async function saveIdentity(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const named = await mesh.updateInstanceName(instanceName);
    if (!named) return;
    const endpoint = await mesh.updateMeshEndpoint(meshEndpoint);
    if (endpoint) toast.success("Mesh controller identity saved.");
  }

  async function createToken(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const created = await mesh.createEnrollmentToken(tokenName);
    if (!created) return;
    setCreatedToken(created.token);
    toast.success("Worker enrollment token created.");
  }

  return (
    <div className="space-y-4">
      {mesh.error && mesh.error !== mesh.mutationError ? <SettingsError>{mesh.error}</SettingsError> : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-medium">Workers</h4>
          <Button type="button" size="sm" variant="ghost" onClick={() => void mesh.checkHealth()}>
            Probe workers
          </Button>
        </div>
        {mesh.status?.workers.length ? mesh.status.workers.map((worker) => (
          <div
            key={worker.workerNodeId}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-gray-200 p-3 dark:border-gray-700"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate font-medium">
                  {worker.workerInstanceName ?? worker.workerNodeId}
                </p>
                <Badge
                  variant={worker.grantStatus === "active" ? "success" : "disabled"}
                  appearance="text"
                >
                  {worker.grantStatus}
                </Badge>
                {worker.registrationScope === "workspace" ? (
                  <Badge variant="info" appearance="text">Dedicated</Badge>
                ) : null}
              </div>
              <p className="break-all text-xs text-gray-500 dark:text-gray-400">
                {worker.workerEndpoint}
                {worker.workerDirectory ? ` · ${worker.workerDirectory}` : ""}
              </p>
              {worker.lastSeenAt ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Last successful probe: {new Date(worker.lastSeenAt).toLocaleString()}
                </p>
              ) : null}
            </div>
            {worker.grantStatus === "active" && worker.registrationScope !== "workspace" ? (
              <div className="flex items-center gap-2">
                {killingWorkerNodeId === worker.workerNodeId ? (
                  <div className="wapp-shutdown-countdown min-w-56" aria-live="polite">
                    <div className="wapp-shutdown-message">
                      Worker is shutting down... refreshing status in {killCountdown ?? 0}s
                    </div>
                    <div className="wapp-shutdown-progress" aria-hidden="true">
                      <div
                        className="wapp-shutdown-progress-bar"
                        style={{
                          width: `${((killCountdown ?? 0) / WORKER_KILL_COUNTDOWN_SECONDS) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={mesh.saving || killingWorkerNodeId !== null}
                      onClick={() => setKillWorkerNodeId(worker.workerNodeId)}
                    >
                      Kill
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={mesh.saving || killingWorkerNodeId !== null}
                      onClick={() => setRevokeWorkerNodeId(worker.workerNodeId)}
                    >
                      Revoke
                    </Button>
                  </>
                )}
              </div>
            ) : worker.registrationScope === "workspace" ? (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                Removed with its workspace
              </span>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="danger"
                onClick={() => setRemoveWorkerNodeId(worker.workerNodeId)}
              >
                Delete
              </Button>
            )}
          </div>
        )) : (
          <p className="text-sm text-gray-600 dark:text-gray-300">No workers enrolled.</p>
        )}
      </div>

      <form className="space-y-3" onSubmit={(event) => void createToken(event)}>
        <MeshFormField
          id="mesh-enrollment-name"
          label="Enrollment token"
          description="Create a single-use token, then run mesh enroll on the worker."
        >
          <SettingsInput
            id="mesh-enrollment-name"
            required
            maxLength={120}
            value={tokenName}
            onChange={(event) => setTokenName(event.currentTarget.value)}
            disabled={mesh.saving}
          />
        </MeshFormField>
        <Button type="submit" size="sm" loading={mesh.saving}>Create token</Button>
        {createdToken ? (
          <div className="rounded-md bg-gray-50 p-3 text-sm dark:bg-neutral-800">
            <p className="font-medium">Copy this token now</p>
            <code className="mt-1 block break-all text-xs">{createdToken}</code>
          </div>
        ) : null}
      </form>

      <details>
        <summary className="cursor-pointer text-sm font-medium">Controller identity</summary>
        <form className="mt-3 space-y-3" onSubmit={(event) => void saveIdentity(event)}>
          <MeshFormField
            id="mesh-instance-name"
            label="Controller name"
            description="Name shown by this controller in enrollment responses."
          >
            <SettingsInput
              id="mesh-instance-name"
              required
              maxLength={64}
              value={instanceName}
              onChange={(event) => setInstanceName(event.currentTarget.value)}
              disabled={mesh.saving}
            />
          </MeshFormField>
          <MeshFormField
            id="mesh-endpoint"
            label="Controller endpoint"
            description="HTTP(S) origin workers use during enrollment."
          >
            <SettingsInput
              id="mesh-endpoint"
              type="url"
              required
              value={meshEndpoint}
              onChange={(event) => setMeshEndpoint(event.currentTarget.value)}
              disabled={mesh.saving}
            />
          </MeshFormField>
          <Button type="submit" size="sm" loading={mesh.saving}>Save identity</Button>
          <p className="break-all text-xs text-gray-500 dark:text-gray-400">
            Fingerprint: {mesh.status?.node.fingerprint ?? "Loading..."}
          </p>
        </form>
      </details>

      <ConfirmModal
        isOpen={killWorkerNodeId !== null}
        onClose={() => setKillWorkerNodeId(null)}
        onConfirm={async () => {
          if (!killWorkerNodeId) return;
          const result = await mesh.killWorker(killWorkerNodeId);
          if (result) {
            toast.success("Worker kill command sent.");
            setKillWorkerNodeId(null);
            setKillingWorkerNodeId(killWorkerNodeId);
          }
        }}
        title="Kill worker"
        message="The worker process will exit after acknowledging this command. Its service supervisor should restart it."
        confirmLabel="Kill worker"
        loading={mesh.saving}
        variant="danger"
      />
      <ConfirmModal
        isOpen={revokeWorkerNodeId !== null}
        onClose={() => setRevokeWorkerNodeId(null)}
        onConfirm={async () => {
          if (!revokeWorkerNodeId) return;
          const result = await mesh.revokeWorker(revokeWorkerNodeId);
          if (result) {
            toast.success("Worker grant revoked.");
            setRevokeWorkerNodeId(null);
          }
        }}
        title="Revoke worker"
        message="This controller will stop trusting the worker. Other controllers are unaffected."
        confirmLabel="Revoke worker"
        loading={mesh.saving}
        variant="danger"
      />
      <ConfirmModal
        isOpen={removeWorkerNodeId !== null}
        onClose={() => setRemoveWorkerNodeId(null)}
        onConfirm={async () => {
          if (!removeWorkerNodeId) return;
          const result = await mesh.removeRevokedWorker(removeWorkerNodeId);
          if (result) {
            toast.success("Worker registration deleted.");
            setRemoveWorkerNodeId(null);
          }
        }}
        title="Delete worker registration"
        message="This removes the local revoked registration. It does not affect other controllers."
        confirmLabel="Delete registration"
        loading={mesh.saving}
        variant="danger"
      />
    </div>
  );
}
