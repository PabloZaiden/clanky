import { useEffect, useState, type ReactNode } from "react";
import { ConfirmModal, useToast } from "@pablozaiden/webapp/web";
import type {
  MeshLinkMemberRecord,
  MeshPairingRequestRecord,
} from "@/shared/mesh";
import type { UseMeshResult } from "../../hooks";
import { Badge, Button } from "../common";
import { SettingsError, SettingsInput } from "./settings-row-controls";

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

function formatPeerStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function PairingRequest({
  request,
  saving,
  instanceNameConfigured,
  onApprove,
  onComplete,
  onReject,
}: {
  request: MeshPairingRequestRecord;
  saving: boolean;
  instanceNameConfigured: boolean;
  onApprove: () => Promise<void>;
  onComplete: (fingerprint: string) => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const approval = request.remoteApproval;
  const isIncoming = request.direction === "incoming";
  const peerName = isIncoming
    ? request.requestedInstanceName
    : approval?.approvedByInstanceName ?? request.requestedInstanceName;

  return (
    <div className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-700">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{isIncoming ? "Incoming request" : "Outgoing request"}</span>
        <span className="text-xs text-gray-500 dark:text-gray-400">{request.status}</span>
      </div>
      <p className="break-all text-xs text-gray-500 dark:text-gray-400">
        {peerName ?? "Unnamed instance"} · {request.endpoint} · fingerprint {request.fingerprint}
      </p>
      {isIncoming ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => void onApprove()}
            disabled={saving || !instanceNameConfigured}
          >
            Approve
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => void onReject()} disabled={saving}>
            Reject
          </Button>
          {!instanceNameConfigured ? (
            <p className="basis-full text-xs text-amber-700 dark:text-amber-300">
              Save this instance name before approving a pairing request.
            </p>
          ) : null}
        </div>
      ) : approval?.status === "pending" ? (
        <div className="space-y-2">
          <p className="text-xs text-gray-600 dark:text-gray-300">
            The peer approved this request. Confirm its fingerprint to complete the pairing:
            {" "}
            <code>{approval.fingerprint}</code>
          </p>
          <Button
            type="button"
            size="sm"
            onClick={() => void onComplete(approval.fingerprint)}
            disabled={saving}
          >
            Confirm pairing
          </Button>
        </div>
      ) : (
        <p className="text-xs text-gray-600 dark:text-gray-300">
          Waiting for the peer to approve this request.
        </p>
      )}
      {!isIncoming ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => void onReject()} disabled={saving}>
          Cancel request
        </Button>
      ) : null}
    </div>
  );
}

function MeshMemberRow({
  member,
  localNodeId,
  activeNodeId,
  saving,
  onRevoke,
}: {
  member: MeshLinkMemberRecord;
  localNodeId: string;
  activeNodeId: string | null;
  saving: boolean;
  onRevoke: () => void;
}) {
  const isLocalInstance = member.nodeId === localNodeId;
  const isAuthority = member.nodeId === activeNodeId;
  const memberDetails = [
    member.status === "active" ? null : formatPeerStatus(member.status),
    member.endpoint,
  ]
    .filter((value): value is string => value !== null && value.length > 0)
    .join(" · ");

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-gray-200 p-3 dark:border-gray-700">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-medium">
            {member.instanceName ?? (isLocalInstance ? "This instance" : "Unnamed instance")}
          </p>
          {isLocalInstance ? (
            <Badge variant="info" appearance="text">
              This instance
            </Badge>
          ) : null}
          {isAuthority ? (
            <Badge variant="success" appearance="text">
              Authority
            </Badge>
          ) : null}
        </div>
        {memberDetails ? <p className="text-xs text-gray-500 dark:text-gray-400">{memberDetails}</p> : null}
      </div>
      {member.nodeId !== localNodeId && member.status !== "revoked" ? (
        <Button type="button" size="sm" variant="danger" onClick={onRevoke} disabled={saving}>
          Revoke
        </Button>
      ) : null}
    </div>
  );
}

export function MeshSettingsContent({ mesh }: MeshSettingsContentProps) {
  const toast = useToast();
  const [endpoint, setEndpoint] = useState("");
  const [targetLocalUserId, setTargetLocalUserId] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const [rejoinEndpoint, setRejoinEndpoint] = useState("");
  const [rejoinTargetUserId, setRejoinTargetUserId] = useState("");
  const [revokeNodeId, setRevokeNodeId] = useState<string | null>(null);
  const [showTakeoverConfirm, setShowTakeoverConfirm] = useState(false);
  const [showRejoinConfirm, setShowRejoinConfirm] = useState(false);

  useEffect(() => {
    void mesh.loadPreflight();
    void mesh.loadConflicts();
  }, [mesh.loadConflicts, mesh.loadPreflight]);

  const link = mesh.status?.links[0] ?? null;
  const localIsActive = link?.activeNodeId === mesh.status?.node.nodeId;
  const localMember = link?.members.find((member) => member.nodeId === mesh.status?.node.nodeId);
  const canRejoin = link?.status === "revoked" || localMember?.status === "revoked";
  const pendingRequests = mesh.status?.pendingPairingRequests ?? [];
  const hasInstanceName = Boolean(mesh.status?.node.instanceName);

  useEffect(() => {
    if (mesh.status?.node.instanceName !== undefined) {
      setInstanceName(mesh.status.node.instanceName ?? "");
    }
  }, [mesh.status?.node.instanceName]);

  async function saveInstanceName(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const result = await mesh.updateInstanceName(instanceName);
    if (result) {
      toast.success("Mesh instance name saved.");
    }
  }

  async function startPairing(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const result = await mesh.startPairing(endpoint, targetLocalUserId || undefined);
    if (result) {
      toast.success("Mesh pairing request sent.");
      setEndpoint("");
      setTargetLocalUserId("");
    }
  }

  async function handleRejoin(): Promise<void> {
    const result = await mesh.rejoin(rejoinEndpoint, rejoinTargetUserId || undefined);
    if (result) {
      toast.success("Mesh rejoin request sent with a new node identity.");
      setShowRejoinConfirm(false);
      setRejoinEndpoint("");
      setRejoinTargetUserId("");
    }
  }

  return (
    <div className="space-y-4">
      {mesh.error ? <SettingsError>{mesh.error}</SettingsError> : null}
      {link ? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Mesh members</h4>
          {link.members.map((member) => (
            <MeshMemberRow
              key={member.nodeId}
              member={member}
              localNodeId={mesh.status?.node.nodeId ?? ""}
              activeNodeId={link.activeNodeId}
              saving={mesh.saving}
              onRevoke={() => setRevokeNodeId(member.nodeId)}
            />
          ))}
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-medium">Authority</h4>
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={() => {
              void mesh.loadPreflight().then((result) => {
                if (result) {
                  setShowTakeoverConfirm(true);
                }
              });
            }}
            disabled={!link || localIsActive || mesh.saving}
          >
            Take over
          </Button>
        </div>
        {mesh.preflight && mesh.preflight.activeTasks.length > 0 ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {mesh.preflight.activeTasks.length} active task{mesh.preflight.activeTasks.length === 1 ? "" : "s"} will remain on the original node.
          </p>
        ) : null}
      </div>

      <details className="space-y-4">
        <summary className="cursor-pointer text-sm font-medium">Mesh configuration</summary>
        <div className="space-y-4 pt-2">
          <form className="space-y-3" onSubmit={(event) => void saveInstanceName(event)}>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-full min-w-0 sm:min-w-72 sm:max-w-xl sm:flex-1">
                <MeshFormField
                  id="mesh-instance-name"
                  label="Instance name"
                  description="A human-readable name for this Clanky instance. It is shown to other mesh members and is required before joining."
                >
                  <SettingsInput
                    id="mesh-instance-name"
                    required
                    maxLength={64}
                    aria-describedby="mesh-instance-name-description"
                    placeholder="e.g. Office Clanky"
                    value={instanceName}
                    onChange={(event) => setInstanceName(event.currentTarget.value)}
                    disabled={mesh.saving}
                  />
                </MeshFormField>
              </div>
              <Button type="submit" size="sm" className="shrink-0" loading={mesh.saving}>
                Save instance name
              </Button>
            </div>
          </form>
          <div className="rounded-md bg-gray-50 p-3 text-sm dark:bg-neutral-800">
            <p className="font-medium">
              {link ? (localIsActive ? "Active mesh instance" : "Passive mesh instance") : "Not linked to a mesh"}
            </p>
            <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
              Instance name: <strong>{mesh.status?.node.instanceName ?? "Not configured"}</strong>
            </p>
            <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
              Node fingerprint: <code className="break-all">{mesh.status?.node.fingerprint ?? "Loading..."}</code>
            </p>
            {link ? (
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                {link.members.length} member{link.members.length === 1 ? "" : "s"} · generation {link.takeoverGeneration}
              </p>
            ) : null}
          </div>

          <form className="space-y-3" onSubmit={(event) => void startPairing(event)}>
            <MeshFormField
              id="mesh-target-endpoint"
              label="Other instance URL"
              description="The URL of the Clanky instance you want to add to this mesh."
            >
              <SettingsInput
                id="mesh-target-endpoint"
                type="url"
                required
                aria-describedby="mesh-target-endpoint-description"
                placeholder="https://other-clanky.example"
                value={endpoint}
                onChange={(event) => setEndpoint(event.currentTarget.value)}
                disabled={mesh.saving}
              />
            </MeshFormField>
            <MeshFormField
              id="mesh-target-user-id"
              label="Target user ID (optional)"
              description="Use this when the other instance has multiple users and the request should go to a specific one. Leave blank otherwise."
            >
              <SettingsInput
                id="mesh-target-user-id"
                aria-describedby="mesh-target-user-id-description"
                placeholder="Target local user ID (optional)"
                value={targetLocalUserId}
                onChange={(event) => setTargetLocalUserId(event.currentTarget.value)}
                disabled={mesh.saving}
              />
            </MeshFormField>
            <Button type="submit" size="sm" loading={mesh.saving} disabled={!hasInstanceName}>
              Add instance to mesh
            </Button>
          </form>

          {pendingRequests.length > 0 ? (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Pending pairing requests</h4>
              {pendingRequests.map((request) => (
                <PairingRequest
                  key={request.id}
                  request={request}
                  saving={mesh.saving}
                  instanceNameConfigured={hasInstanceName}
                  onApprove={async () => {
                    const result = await mesh.approvePairing(request.id);
                    if (result) toast.success("Pairing approved.");
                  }}
                  onComplete={async (fingerprint) => {
                    const result = await mesh.completePairing(request.id, fingerprint.trim());
                    if (result) toast.success("Mesh pairing completed.");
                  }}
                  onReject={async () => {
                    const result = await mesh.rejectPairing(request.id);
                    if (result) toast.success("Pairing request rejected.");
                  }}
                />
              ))}
            </div>
          ) : null}

          {mesh.conflicts.length > 0 ? (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Conflicts requiring a decision</h4>
              {mesh.conflicts.map((conflict) => (
                <div key={conflict.conflictId} className="space-y-2 rounded-md border border-amber-300 p-3 dark:border-amber-700">
                  <p className="text-xs">
                    {conflict.aggregateType} / {conflict.aggregateId}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(["local", "remote", "dismiss"] as const).map((resolution) => (
                      <Button
                        key={resolution}
                        type="button"
                        size="sm"
                        variant={resolution === "dismiss" ? "ghost" : "secondary"}
                        onClick={() => {
                          void mesh.resolveConflict(conflict.conflictId, resolution).then((result) => {
                            if (result) toast.success("Mesh conflict resolved.");
                          });
                        }}
                        disabled={mesh.saving}
                      >
                        Keep {resolution}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {canRejoin ? (
            <div className="space-y-2 border-t border-gray-200 pt-4 dark:border-gray-700">
              <h4 className="text-sm font-medium">Rejoin mesh</h4>
              <p className="text-xs text-gray-600 dark:text-gray-300">
                Rejoin rotates this node identity. Use an active mesh instance as the target.
              </p>
              <MeshFormField
                id="mesh-rejoin-endpoint"
                label="Active instance URL"
                description="The URL of the active mesh instance that should receive this rejoin request."
              >
                <SettingsInput
                  id="mesh-rejoin-endpoint"
                  type="url"
                  required
                  aria-describedby="mesh-rejoin-endpoint-description"
                  placeholder="https://active-clanky.example"
                  value={rejoinEndpoint}
                  onChange={(event) => setRejoinEndpoint(event.currentTarget.value)}
                  disabled={mesh.saving}
                />
              </MeshFormField>
              <MeshFormField
                id="mesh-rejoin-user-id"
                label="Target user ID (optional)"
                description="Use this when the active instance has multiple users and the request should go to a specific one. Leave blank otherwise."
              >
                <SettingsInput
                  id="mesh-rejoin-user-id"
                  aria-describedby="mesh-rejoin-user-id-description"
                  placeholder="Target local user ID (optional)"
                  value={rejoinTargetUserId}
                  onChange={(event) => setRejoinTargetUserId(event.currentTarget.value)}
                  disabled={mesh.saving}
                />
              </MeshFormField>
              <Button
                type="button"
                size="sm"
                onClick={() => setShowRejoinConfirm(true)}
                disabled={mesh.saving || !hasInstanceName || rejoinEndpoint.trim().length === 0}
              >
                Start rejoin
              </Button>
            </div>
          ) : null}
        </div>
      </details>

      <ConfirmModal
        isOpen={revokeNodeId !== null}
        onClose={() => setRevokeNodeId(null)}
        onConfirm={async () => {
          if (!revokeNodeId) return;
          const result = await mesh.revokeMember(revokeNodeId);
          if (result) {
            toast.success("Mesh member revoked.");
            setRevokeNodeId(null);
          }
        }}
        title="Revoke mesh member"
        message="This member will stop receiving new synchronized data. Rejoining requires a new pairing."
        confirmLabel="Revoke member"
        loading={mesh.saving}
        variant="danger"
      />
      <ConfirmModal
        isOpen={showTakeoverConfirm}
        onClose={() => setShowTakeoverConfirm(false)}
        onConfirm={async () => {
          const result = await mesh.takeover(mesh.preflight?.takeoverGeneration ?? undefined);
          if (result) {
            toast.success("This instance is now the active mesh node.");
            setShowTakeoverConfirm(false);
          }
        }}
        title="Take over mesh authority"
        message={mesh.preflight?.activeTasks.length
          ? `${mesh.preflight.activeTasks.length} active task(s) will continue on the original instance. Continue?`
          : "Only this instance will execute active mesh work after takeover. Continue?"}
        confirmLabel="Take over"
        loading={mesh.saving}
      />
      <ConfirmModal
        isOpen={showRejoinConfirm}
        onClose={() => setShowRejoinConfirm(false)}
        onConfirm={() => void handleRejoin()}
        title="Rejoin mesh"
        message="This rotates the local node identity and starts a new pairing request. Continue?"
        confirmLabel="Rejoin"
        loading={mesh.saving}
      />
    </div>
  );
}
