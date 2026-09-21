import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActionMenu, ConfirmModal, useToast } from "@pablozaiden/webapp/web";
import type { UseMeshResult } from "../../hooks";
import { Badge, Button } from "../common";
import {
  SettingsError,
  SettingsInput,
  SettingsSelect,
} from "./settings-row-controls";
import type { MeshEnrollmentRoute } from "@/contracts/schemas/mesh";

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
  const workers = useMemo(() => {
    const currentWorkers = mesh.status?.workers ?? [];
    return [
      ...currentWorkers.filter((worker) => worker.registrationScope !== "workspace"),
      ...currentWorkers.filter((worker) => worker.registrationScope === "workspace"),
    ];
  }, [mesh.status?.workers]);
  const [instanceName, setInstanceName] = useState("");
  const [meshEndpoint, setMeshEndpoint] = useState("");
  const [tokenName, setTokenName] = useState("Mesh worker");
  const [tokenRoute, setTokenRoute] = useState<MeshEnrollmentRoute>("direct");
  const [createdEnrollment, setCreatedEnrollment] = useState<{
    token: string;
    workerJoinCommand: string;
  } | null>(null);
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
    const created = await mesh.createEnrollmentToken(tokenName, 900, tokenRoute);
    if (!created) return;
    setCreatedEnrollment(created);
    toast.success("Worker enrollment token created.");
  }

  return (
    <div className="space-y-4">
      {mesh.error && mesh.error !== mesh.mutationError ? <SettingsError>{mesh.error}</SettingsError> : null}

      {mesh.status ? (
        <div className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-700">
          <p className="font-medium">Controller runtime</p>
          <p className="text-xs text-gray-600 dark:text-gray-300">
            Binary: {mesh.status.protocol.binaryVersion ?? "unknown"} ·
            {" "}Protocol: v{mesh.status.protocol.negotiatedProtocolVersion
              ?? mesh.status.protocol.preferredProtocolVersion}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Supported: {mesh.status.protocol.supportedProtocolVersions
              .map((version) => `v${String(version)}`)
              .join(", ")}
          </p>
        </div>
      ) : null}

      <div className="space-y-2">
        {workers.length ? workers.map((worker) => (
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
                {worker.route.kind === "relay"
                  ? `Relay via ${worker.route.relayUrl}`
                  : worker.workerEndpoint}
                {worker.workerDirectory ? ` · ${worker.workerDirectory}` : ""}
              </p>
              {worker.lastSeenAt ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Last successful probe: {new Date(worker.lastSeenAt).toLocaleString()}
                </p>
              ) : null}
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Binary: {worker.workerBinaryVersion ?? "unknown"} · Protocol: v{
                  worker.workerNegotiatedProtocolVersion
                    ?? worker.workerPreferredProtocolVersion
                    ?? "unknown"
                } · Supports: {worker.workerSupportedProtocolVersions?.map(
                  (version) => `v${String(version)}`,
                ).join(", ") ?? "unknown"}
              </p>
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
                  <ActionMenu
                    ariaLabel="Worker actions"
                    triggerVariant="ghost"
                    triggerSize="compact"
                    disabled={mesh.saving || killingWorkerNodeId !== null}
                    items={[
                      {
                        id: "kill",
                        label: "Kill",
                        destructive: true,
                        disabled: mesh.saving || killingWorkerNodeId !== null,
                        onAction: () => setKillWorkerNodeId(worker.workerNodeId),
                      },
                      {
                        id: "revoke",
                        label: "Revoke",
                        destructive: true,
                        disabled: mesh.saving || killingWorkerNodeId !== null,
                        onAction: () => setRevokeWorkerNodeId(worker.workerNodeId),
                      },
                    ]}
                  />
                )}
              </div>
            ) : worker.registrationScope === "workspace" ? (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                Removed with its workspace
              </span>
            ) : (
              <ActionMenu
                ariaLabel="Worker actions"
                triggerVariant="ghost"
                triggerSize="compact"
                disabled={mesh.saving}
                items={[{
                  id: "delete",
                  label: "Delete",
                  destructive: true,
                  disabled: mesh.saving,
                  onAction: () => setRemoveWorkerNodeId(worker.workerNodeId),
                }]}
              />
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
        <MeshFormField
          id="mesh-enrollment-route"
          label="Route"
          description="Direct uses this controller endpoint. Relay requires an active controller relay pairing."
        >
          <SettingsSelect
            id="mesh-enrollment-route"
            value={tokenRoute}
            onChange={(event) => setTokenRoute(
              event.currentTarget.value as MeshEnrollmentRoute,
            )}
            disabled={mesh.saving}
          >
            <option value="direct">Direct</option>
            <option value="relay">Relay</option>
          </SettingsSelect>
        </MeshFormField>
        <Button type="submit" size="sm" loading={mesh.saving}>Create</Button>
        {createdEnrollment ? (
          <div className="rounded-md bg-gray-50 p-3 text-sm dark:bg-neutral-800">
            <p className="font-medium">Run this command on the worker</p>
            <code className="mt-1 block break-all text-xs">
              {createdEnrollment.workerJoinCommand}
            </code>
          </div>
        ) : null}
      </form>

      <form className="space-y-3" onSubmit={(event) => void saveIdentity(event)}>
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
        <Button type="submit" size="sm" loading={mesh.saving}>Save</Button>
      </form>

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
