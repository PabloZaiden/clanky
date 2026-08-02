import { useEffect, useState } from "react";
import { ConfirmModal, useToast } from "@pablozaiden/webapp/web";
import type {
  MeshLinkMemberRecord,
  MeshPairingRequestRecord,
} from "@/shared/mesh";
import type { UseMeshResult } from "../../hooks";
import { Button } from "../common";
import { SettingsError, SettingsInput } from "./settings-row-controls";

interface MeshSettingsContentProps {
  mesh: UseMeshResult;
}

function formatPeerStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function PairingRequest({
  request,
  saving,
  onApprove,
  onComplete,
  onReject,
}: {
  request: MeshPairingRequestRecord;
  saving: boolean;
  onApprove: () => Promise<void>;
  onComplete: (fingerprint: string) => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [fingerprint, setFingerprint] = useState("");
  const approval = request.remoteApproval;
  const isIncoming = request.direction === "incoming";

  return (
    <div className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-700">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{isIncoming ? "Incoming request" : "Outgoing request"}</span>
        <span className="text-xs text-gray-500 dark:text-gray-400">{request.status}</span>
      </div>
      <p className="break-all text-xs text-gray-500 dark:text-gray-400">
        {request.endpoint} · fingerprint {request.fingerprint}
      </p>
      {isIncoming ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => void onApprove()} disabled={saving}>
            Approve
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => void onReject()} disabled={saving}>
            Reject
          </Button>
        </div>
      ) : approval?.status === "pending" ? (
        <div className="space-y-2">
          <p className="text-xs text-gray-600 dark:text-gray-300">
            The peer approved this request. Confirm its fingerprint before completing:
            {" "}
            <code>{approval.fingerprint}</code>
          </p>
          <div className="flex flex-wrap gap-2">
            <SettingsInput
              aria-label={`Fingerprint for ${request.endpoint}`}
              placeholder="Paste the verified fingerprint"
              value={fingerprint}
              onChange={(event) => setFingerprint(event.currentTarget.value)}
              disabled={saving}
            />
            <Button
              type="button"
              size="sm"
              onClick={() => void onComplete(fingerprint)}
              disabled={saving || fingerprint.trim().length === 0}
            >
              Confirm fingerprint
            </Button>
          </div>
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
  saving,
  onRevoke,
}: {
  member: MeshLinkMemberRecord;
  localNodeId: string;
  saving: boolean;
  onRevoke: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-gray-200 p-3 dark:border-gray-700">
      <div className="min-w-0">
        <p className="truncate font-medium">
          {member.nodeId === localNodeId ? "This instance" : member.nodeId}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {formatPeerStatus(member.status)}
          {member.endpoint ? ` · ${member.endpoint}` : ""}
        </p>
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
      <div className="rounded-md bg-gray-50 p-3 text-sm dark:bg-neutral-800">
        <p className="font-medium">
          {link ? (localIsActive ? "Active mesh instance" : "Passive mesh instance") : "Not linked to a mesh"}
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

      <form className="space-y-2" onSubmit={(event) => void startPairing(event)}>
        <SettingsInput
          type="url"
          required
          aria-label="Mesh instance endpoint"
          placeholder="https://other-clanky.example"
          value={endpoint}
          onChange={(event) => setEndpoint(event.currentTarget.value)}
          disabled={mesh.saving}
        />
        <SettingsInput
          aria-label="Target local user ID"
          placeholder="Target local user ID (optional)"
          value={targetLocalUserId}
          onChange={(event) => setTargetLocalUserId(event.currentTarget.value)}
          disabled={mesh.saving}
        />
        <Button type="submit" size="sm" loading={mesh.saving}>
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
            Take over as active
          </Button>
        </div>
        <p className="text-xs text-gray-600 dark:text-gray-300">
          Takeover is explicit. Tasks already running on another instance remain there and are not duplicated.
        </p>
        {mesh.preflight && mesh.preflight.activeTasks.length > 0 ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {mesh.preflight.activeTasks.length} active task{mesh.preflight.activeTasks.length === 1 ? "" : "s"} will remain on the original node.
          </p>
        ) : null}
      </div>

      {link ? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Mesh members</h4>
          {link.members.map((member) => (
            <MeshMemberRow
              key={member.nodeId}
              member={member}
              localNodeId={mesh.status?.node.nodeId ?? ""}
              saving={mesh.saving}
              onRevoke={() => setRevokeNodeId(member.nodeId)}
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
          <SettingsInput
            type="url"
            required
            aria-label="Rejoin target endpoint"
            placeholder="https://active-clanky.example"
            value={rejoinEndpoint}
            onChange={(event) => setRejoinEndpoint(event.currentTarget.value)}
            disabled={mesh.saving}
          />
          <SettingsInput
            aria-label="Rejoin target local user ID"
            placeholder="Target local user ID (optional)"
            value={rejoinTargetUserId}
            onChange={(event) => setRejoinTargetUserId(event.currentTarget.value)}
            disabled={mesh.saving}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => setShowRejoinConfirm(true)}
            disabled={mesh.saving || rejoinEndpoint.trim().length === 0}
          >
            Start rejoin
          </Button>
        </div>
      ) : null}

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
