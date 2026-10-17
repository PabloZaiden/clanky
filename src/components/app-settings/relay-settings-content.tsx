import { useCallback, useEffect, useRef, useState } from "react";
import { CodeValue, ConfirmModal, DataList, DataListRow, EmptyState, FormActions, LoadingState, Modal, SettingsFieldRow, TextField, useToast, useUnsavedChanges } from "@pablozaiden/webapp/web";
import type { ControllerRelayPairingStatus } from "@/contracts/relay";
import { useRealtimeRefreshWithRecovery } from "../../hooks/useRealtimeStream";
import { apiRequest } from "../../lib/api-client";
import { createRefreshCoordinator } from "../../lib/refresh-coordinator";
import { isAbortError } from "../../lib/request-lifecycle";
import { Button, StatusBadge } from "../common";
import { SettingsError } from "./settings-row-controls";

export function RelaySettingsContent() {
  const toast = useToast();
  const [status, setStatus] = useState<ControllerRelayPairingStatus | null>(null);
  const [relayName, setRelayName] = useState("");
  const [relayUrl, setRelayUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState<string | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const selectedRelay = status?.relays.find((relay) => relay.name === relayName);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const refreshCoordinatorRef = useRef(createRefreshCoordinator<void>());
  const refreshVersionRef = useRef(0);
  function resetPairing(): void {
    setRelayName("");
    setRelayUrl("");
    setPairingError(null);
    setPairingOpen(false);
  }
  useUnsavedChanges(Boolean(relayName || relayUrl), resetPairing);

  const refresh = useCallback((): Promise<void> => {
    const controller = refreshAbortRef.current ?? new AbortController();
    refreshAbortRef.current = controller;
    refreshVersionRef.current++;
    return refreshCoordinatorRef.current.run(async () => {
      if (controller.signal.aborted) return;
      setError(null);
      try {
        let version: number;
        do {
          version = refreshVersionRef.current;
          try {
            const next = await apiRequest<ControllerRelayPairingStatus>(
              "/api/mesh/relay",
              {
                signal: controller.signal,
                action: "Load Mesh relay status",
                fallbackMessage: "Failed to load Mesh relay status",
              },
            );
            if (controller.signal.aborted) return;
            if (version === refreshVersionRef.current) setStatus(next);
          } catch (loadError) {
            if (controller.signal.aborted || isAbortError(loadError)) return;
            if (version === refreshVersionRef.current) {
              setError(loadError instanceof Error ? loadError.message : String(loadError));
            }
          }
        } while (version !== refreshVersionRef.current);
      } finally {
        if (refreshAbortRef.current === controller) {
          refreshAbortRef.current = null;
        }
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    });
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = null;
      refreshCoordinatorRef.current.reset();
    };
  }, [refresh]);

  useRealtimeRefreshWithRecovery({
    resources: ["mesh"],
    filters: { resource: "mesh" },
    refresh,
    onReconnect: refresh,
  });

  function updateStatus(next: ControllerRelayPairingStatus): void {
    refreshVersionRef.current++;
    setStatus(next);
    setError(null);
    setPairingError(null);
  }

  async function pair(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setPairingError(null);
    try {
      const next = await apiRequest<ControllerRelayPairingStatus>(
        "/api/mesh/relay",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: relayName, relayUrl }),
          action: "Pair Mesh relay",
          fallbackMessage: "Failed to pair Mesh relay",
        },
      );
      updateStatus(next);
      setRelayName("");
      setRelayUrl("");
      setPairingOpen(false);
      toast.success("Mesh relay paired.");
    } catch (pairError) {
      setPairingError(pairError instanceof Error ? pairError.message : String(pairError));
    } finally {
      setSaving(false);
    }
  }

  async function selectPrimary(name: string): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const next = await apiRequest<ControllerRelayPairingStatus>(
        "/api/mesh/relay/primary",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
          action: "Select primary Mesh relay",
          fallbackMessage: "Failed to select primary Mesh relay",
        },
      );
      updateStatus(next);
      toast.success("Primary Mesh relay updated.");
    } catch (selectionError) {
      setError(selectionError instanceof Error
        ? selectionError.message
        : String(selectionError));
    } finally {
      setSaving(false);
    }
  }

  async function unpair(): Promise<void> {
    if (!confirmUnpair) return;
    setSaving(true);
    setError(null);
    try {
      const next = await apiRequest<ControllerRelayPairingStatus>(
        `/api/mesh/relay/${encodeURIComponent(confirmUnpair)}`,
        {
          method: "DELETE",
          action: "Unpair Mesh relay",
          fallbackMessage: "Failed to unpair Mesh relay",
        },
      );
      updateStatus(next);
      setConfirmUnpair(null);
      toast.success("Mesh relay unpaired.");
    } catch (unpairError) {
      setError(unpairError instanceof Error
        ? unpairError.message
        : String(unpairError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <FormActions><Button variant="primary" disabled={loading || saving} onClick={() => setPairingOpen(true)}>Pair relay</Button></FormActions>
      {error ? <SettingsError>{error}</SettingsError> : null}
      {loading && !status ? <LoadingState title="Loading relays" /> : null}
      {status ? (
        <>
          {status.relays.length === 0 ? (
            <EmptyState title="No relays" />
          ) : (
            <fieldset className="space-y-2">
              <legend className="sr-only">Primary Mesh relay</legend>
              <DataList>
              {status.relays.map((relay) => (
                <DataListRow
                  key={relay.name}
                  title={<label className="flex min-w-0 items-center gap-2 font-medium">
                      <input
                        type="radio"
                        name="primary-mesh-relay"
                        checked={relay.isPrimary}
                        onChange={() => void selectPrimary(relay.name)}
                        disabled={saving}
                      />
                      <span className="truncate">{relay.name}</span>
                    </label>}
                  meta={relay.isPrimary ? "Primary" : undefined}
                  metaPlacement="inline"
                  badge={<StatusBadge variant={relay.connected ? "success" : "warning"}>{relay.connected ? "Connected" : "Disconnected"}</StatusBadge>}
                  description={relay.runtimeError?.message ?? relay.relayUrl}
                  descriptionClassName={relay.runtimeError ? "text-red-600 dark:text-red-400" : "truncate"}
                  actions={<div className="flex flex-wrap justify-end gap-1">
                      <Button
                        type="button"
                        size="sm"
                        disabled={saving}
                        onClick={() => {
                          setRelayName(relay.name);
                          setRelayUrl(relay.relayUrl);
                          setPairingOpen(true);
                        }}
                      >
                        Edit pairing
                      </Button>
                      <Button size="sm" variant="danger" disabled={saving} onClick={() => setConfirmUnpair(relay.name)}>Unpair</Button>
                    </div>}
                />
              ))}
              </DataList>
            </fieldset>
          )}
        </>
      ) : null}
      <Modal isOpen={pairingOpen} onClose={() => { if (!saving) resetPairing(); }} title={selectedRelay ? "Edit pairing" : "Pair relay"}>
      <form className="grid gap-3" onSubmit={(event) => void pair(event)}>
        <TextField
          label="Relay name"
          id="mesh-relay-name"
          required
          maxLength={64}
          placeholder="relay-west"
          value={relayName}
          onChange={(event) => setRelayName(event.currentTarget.value)}
          disabled={loading || saving}
        />
        <TextField
          label="Relay URL"
          fieldWidth="full"
          id="mesh-relay-url"
          type="url"
          required
          placeholder="https://relay.example.com"
          value={relayUrl}
          onChange={(event) => setRelayUrl(event.currentTarget.value)}
          disabled={loading || saving}
        />
        {pairingError ? <SettingsError>{pairingError}</SettingsError> : null}
        {status ? <CodeValue label="Relay bootstrap configuration" value={status.bootstrapEnvironment} /> : null}
        {selectedRelay ? <>
          <SettingsFieldRow title="Version" content={selectedRelay.relayBinaryVersion ?? "Unknown"} />
          <SettingsFieldRow title="Protocol" content={`v${selectedRelay.relayNegotiatedProtocolVersion ?? selectedRelay.relayPreferredProtocolVersion}`} />
          <SettingsFieldRow title="Supported" content={selectedRelay.relaySupportedProtocolVersions.map((version) => `v${version}`).join(", ")} />
        </> : null}
        <FormActions>
        <Button disabled={saving} onClick={resetPairing}>Cancel</Button>
        <Button type="submit" size="sm" variant="primary" loading={saving} disabled={loading || !relayName || !relayUrl}>
          {status?.relays.some((relay) => relay.name === relayName) ? "Re-pair" : "Pair"}
        </Button>
        </FormActions>
      </form>
      </Modal>
      <ConfirmModal
        isOpen={confirmUnpair !== null}
        onClose={() => setConfirmUnpair(null)}
        onConfirm={unpair}
        title={`Unpair ${confirmUnpair ?? "Mesh relay"}`}
        message="Workers using this relay remain enrolled but lose their connection to this controller. Relay-side trust remains until it is reset on the relay host."
        confirmLabel="Unpair"
        loading={saving}
        variant="danger"
      />
    </div>
  );
}
