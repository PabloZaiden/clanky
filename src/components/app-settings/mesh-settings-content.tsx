import { useEffect, useMemo, useState } from "react";
import { ConfirmModal, DataList, DataListRow, DateTimeValue, EmptyState, Modal, SettingsFieldRow, useToast } from "@pablozaiden/webapp/web";
import type { UseMeshResult } from "../../hooks";
import { Badge, Button, StatusBadge } from "../common";
import { SettingsError } from "./settings-row-controls";

const WORKER_KILL_COUNTDOWN_SECONDS = 15;

interface MeshSettingsContentProps {
  mesh: UseMeshResult;
}

export function MeshSettingsContent({ mesh }: MeshSettingsContentProps) {
  const toast = useToast();
  const notifyError = toast.error;
  const workers = useMemo(() => {
    const currentWorkers = mesh.status?.workers ?? [];
    return [
      ...currentWorkers.filter((worker) => worker.registrationScope !== "workspace"),
      ...currentWorkers.filter((worker) => worker.registrationScope === "workspace"),
    ];
  }, [mesh.status?.workers]);
  const [detailsNodeId, setDetailsNodeId] = useState<string | null>(null);
  const details = workers.find((worker) => worker.workerNodeId === detailsNodeId);
  const [revokeWorkerNodeId, setRevokeWorkerNodeId] = useState<string | null>(null);
  const [removeWorkerNodeId, setRemoveWorkerNodeId] = useState<string | null>(null);
  const [killWorkerNodeId, setKillWorkerNodeId] = useState<string | null>(null);
  const [killingWorkerNodeId, setKillingWorkerNodeId] = useState<string | null>(null);
  const [killCountdown, setKillCountdown] = useState<number | null>(null);

  useEffect(() => {
    if (mesh.mutationError) notifyError(mesh.mutationError);
  }, [mesh.mutationError, notifyError]);

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
    void mesh.refresh();
  }, [killCountdown, killingWorkerNodeId, mesh.refresh]);

  return (
    <div className="space-y-4">
      {mesh.error && mesh.error !== mesh.mutationError ? <SettingsError>{mesh.error}</SettingsError> : null}

      <DataList>
        {workers.length ? workers.map((worker) => (
          <DataListRow
            key={worker.workerNodeId}
            title={worker.workerInstanceName || "Unnamed worker"}
            onClick={() => setDetailsNodeId(worker.workerNodeId)}
            meta={worker.lastSeenAt ? <span title="Last successful probe"><DateTimeValue value={worker.lastSeenAt} /></span> : undefined}
            metaPlacement="inline"
            badge={<div className="flex items-center gap-2">
              <StatusBadge variant={worker.grantStatus === "active" ? "success" : "disabled"}>
                {worker.grantStatus === "active" ? "Active" : "Revoked"}
              </StatusBadge>
              {worker.registrationScope === "workspace" ? <Badge variant="info" appearance="text">Dedicated</Badge> : null}
            </div>}
            actions={worker.grantStatus === "active" && worker.registrationScope !== "workspace" ? (
              <div className="flex flex-wrap items-center justify-end gap-1">
                {killingWorkerNodeId === worker.workerNodeId ? (
                  <div className="wapp-shutdown-countdown" aria-live="polite">
                    <div className="wapp-shutdown-message">
                      Stop requested · status check in {killCountdown ?? 0}s
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
                    <Button size="sm" disabled={mesh.saving || killingWorkerNodeId !== null} onClick={() => setKillWorkerNodeId(worker.workerNodeId)}>Stop</Button>
                    <Button size="sm" variant="danger" disabled={mesh.saving || killingWorkerNodeId !== null} onClick={() => setRevokeWorkerNodeId(worker.workerNodeId)}>Revoke</Button>
                  </>
                )}
              </div>
            ) : worker.registrationScope === "workspace" ? undefined : (
              <Button size="sm" variant="danger" disabled={mesh.saving} onClick={() => setRemoveWorkerNodeId(worker.workerNodeId)}>Delete</Button>
            )}
          />
        )) : (
          <EmptyState title="No workers" />
        )}
      </DataList>
      <Modal isOpen={Boolean(details)} onClose={() => setDetailsNodeId(null)} title={details?.workerInstanceName || "Worker"}
        footer={<Button onClick={() => setDetailsNodeId(null)}>Done</Button>}>
        {details ? <>
          <SettingsFieldRow title="Endpoint" content={details.workerEndpoint} />
          {details.route.kind === "relay" ? <SettingsFieldRow title="Relay" content={details.route.relayUrl} /> : null}
          <SettingsFieldRow title="Version" content={details.workerBinaryVersion ?? "Unknown"} />
          <SettingsFieldRow title="Protocol" content={`v${details.workerNegotiatedProtocolVersion ?? details.workerPreferredProtocolVersion ?? "Unknown"}`} />
          <SettingsFieldRow title="Supported" content={details.workerSupportedProtocolVersions?.map((version) => `v${version}`).join(", ") ?? "Unknown"} />
          {details.lastSeenAt ? <SettingsFieldRow title="Last successful probe" content={<DateTimeValue value={details.lastSeenAt} />} /> : null}
        </> : null}
      </Modal>

      <ConfirmModal
        isOpen={killWorkerNodeId !== null}
        onClose={() => setKillWorkerNodeId(null)}
        onConfirm={async () => {
          if (!killWorkerNodeId) return;
          const result = await mesh.killWorker(killWorkerNodeId);
          if (result) {
            toast.success("Worker stop requested.");
            setKillWorkerNodeId(null);
            setKillingWorkerNodeId(killWorkerNodeId);
          }
        }}
        title="Stop worker?"
        message="Worker connections will close. A service supervisor may restart it automatically."
        confirmLabel="Stop worker"
        loading={mesh.saving}
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
