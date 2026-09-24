import { useCallback, useEffect, useRef, useState } from "react";
import { CodeValue, ConfirmModal, useToast } from "@pablozaiden/webapp/web";
import type { ControllerRelayPairingStatus } from "@/contracts/relay";
import { useRealtimeRefreshWithRecovery } from "../../hooks/useRealtimeStream";
import { apiRequest } from "../../lib/api-client";
import { Button } from "../common";
import { SettingsError, SettingsInput } from "./settings-row-controls";

export function RelaySettingsContent() {
  const toast = useToast();
  const [status, setStatus] = useState<ControllerRelayPairingStatus | null>(null);
  const [relayName, setRelayName] = useState("");
  const [relayUrl, setRelayUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState<string | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    setError(null);
    try {
      const next = await apiRequest<ControllerRelayPairingStatus>(
        "/api/mesh/relay",
        {
          signal: controller.signal,
          action: "Load Mesh relay status",
          fallbackMessage: "Failed to load Mesh relay status",
        },
      );
      if (controller.signal.aborted) {
        return;
      }
      setStatus(next);
    } catch (loadError) {
      if (
        controller.signal.aborted
        || loadError instanceof DOMException && loadError.name === "AbortError"
      ) {
        return;
      }
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (refreshAbortRef.current === controller) {
        refreshAbortRef.current = null;
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => refreshAbortRef.current?.abort();
  }, [refresh]);

  useRealtimeRefreshWithRecovery({
    resources: ["mesh"],
    filters: { resource: "mesh" },
    refresh,
    onReconnect: refresh,
  });

  async function pair(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
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
      setStatus(next);
      setRelayName("");
      setRelayUrl("");
      toast.success("Mesh relay paired.");
    } catch (pairError) {
      setError(pairError instanceof Error ? pairError.message : String(pairError));
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
      setStatus(next);
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
      setStatus(next);
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
      {error ? <SettingsError>{error}</SettingsError> : null}
      {status ? (
        <>
          <CodeValue value={status.bootstrapEnvironment} />
          {status.relays.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-300">No relays paired.</p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="sr-only">Primary Mesh relay</legend>
              {status.relays.map((relay) => (
                <div
                  key={relay.name}
                  className="space-y-2 rounded-md border border-gray-200 p-3 text-sm dark:border-gray-700"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex min-w-0 items-center gap-2 font-medium">
                      <input
                        type="radio"
                        name="primary-mesh-relay"
                        checked={relay.isPrimary}
                        onChange={() => void selectPrimary(relay.name)}
                        disabled={saving}
                      />
                      <span className="truncate">{relay.name}</span>
                      <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
                        {relay.isPrimary ? "Primary" : "Set as primary"}
                      </span>
                    </label>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={saving}
                        onClick={() => {
                          setRelayName(relay.name);
                          setRelayUrl(relay.relayUrl);
                        }}
                      >
                        Edit pairing
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        disabled={saving}
                        onClick={() => setConfirmUnpair(relay.name)}
                      >
                        Unpair
                      </Button>
                    </div>
                  </div>
                  <p className="break-all text-xs">{relay.relayUrl} · {relay.connected ? "Connected" : "Disconnected"}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Binary: {relay.relayBinaryVersion ?? "unknown"} · Protocol: v{
                      relay.relayNegotiatedProtocolVersion
                        ?? relay.relayPreferredProtocolVersion
                    } · Supported: {relay.relaySupportedProtocolVersions
                      .map((version) => `v${String(version)}`)
                      .join(", ")}
                  </p>
                  {relay.runtimeError ? (
                    <SettingsError>{relay.runtimeError.message}</SettingsError>
                  ) : null}
                </div>
              ))}
            </fieldset>
          )}
        </>
      ) : null}
      <form className="space-y-2" onSubmit={(event) => void pair(event)}>
        <label htmlFor="mesh-relay-name" className="block text-sm font-medium">
          Relay name
        </label>
        <SettingsInput
          id="mesh-relay-name"
          required
          maxLength={64}
          placeholder="relay-west"
          value={relayName}
          onChange={(event) => setRelayName(event.currentTarget.value)}
          disabled={loading || saving}
        />
        <label htmlFor="mesh-relay-url" className="block text-sm font-medium">
          Relay URL
        </label>
        <SettingsInput
          id="mesh-relay-url"
          type="url"
          required
          placeholder="https://relay.example.com"
          value={relayUrl}
          onChange={(event) => setRelayUrl(event.currentTarget.value)}
          disabled={loading || saving}
        />
        <Button type="submit" size="sm" loading={saving} disabled={loading}>
          {status?.relays.some((relay) => relay.name === relayName) ? "Re-pair" : "Pair"}
        </Button>
      </form>
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
