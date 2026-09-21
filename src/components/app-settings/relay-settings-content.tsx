import { useCallback, useEffect, useState } from "react";
import { CodeValue, ConfirmModal, useToast } from "@pablozaiden/webapp/web";
import type { ControllerRelayPairingStatus } from "@/contracts/relay";
import { apiRequest } from "../../lib/api-client";
import { Button } from "../common";
import { SettingsError, SettingsInput } from "./settings-row-controls";

export function RelaySettingsContent() {
  const toast = useToast();
  const [status, setStatus] = useState<ControllerRelayPairingStatus | null>(null);
  const [relayUrl, setRelayUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setError(null);
    try {
      const next = await apiRequest<ControllerRelayPairingStatus>(
        "/api/mesh/relay",
        {
          signal,
          action: "Load Mesh relay status",
          fallbackMessage: "Failed to load Mesh relay status",
        },
      );
      if (signal?.aborted) {
        return;
      }
      setStatus(next);
      if (next.relayUrl) {
        setRelayUrl(next.relayUrl);
      }
    } catch (loadError) {
      if (
        signal?.aborted
        || loadError instanceof DOMException && loadError.name === "AbortError"
      ) {
        return;
      }
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

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
          body: JSON.stringify({ relayUrl }),
          action: "Pair Mesh relay",
          fallbackMessage: "Failed to pair Mesh relay",
        },
      );
      setStatus(next);
      toast.success("Mesh relay paired.");
    } catch (pairError) {
      setError(pairError instanceof Error ? pairError.message : String(pairError));
    } finally {
      setSaving(false);
    }
  }

  async function unpair(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const next = await apiRequest<ControllerRelayPairingStatus>(
        "/api/mesh/relay",
        {
          method: "DELETE",
          action: "Unpair Mesh relay",
          fallbackMessage: "Failed to unpair Mesh relay",
        },
      );
      setStatus(next);
      setConfirmUnpair(false);
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
      {status?.runtimeError ? (
        <SettingsError>{status.runtimeError.message}</SettingsError>
      ) : null}
      {status ? (
        <div className="space-y-1 text-sm">
          <p>
            Status:{" "}
            <span className="font-medium">
              {status.connected ? "Connected" : status.paired ? "Disconnected" : "Not paired"}
            </span>
          </p>
          <p>
            Binary: {status.relayBinaryVersion ?? "unknown"} · Protocol: v{
              status.relayNegotiatedProtocolVersion
                ?? status.relayPreferredProtocolVersion
            }
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Supported: {status.relaySupportedProtocolVersions
              .map((version) => `v${String(version)}`)
              .join(", ")}
          </p>
          <CodeValue value={status.bootstrapEnvironment} />
        </div>
      ) : null}
      <form className="space-y-2" onSubmit={(event) => void pair(event)}>
        <SettingsInput
          id="mesh-relay-url"
          type="url"
          required
          placeholder="https://relay.example.com"
          value={relayUrl}
          onChange={(event) => setRelayUrl(event.currentTarget.value)}
          disabled={loading || saving}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" loading={saving} disabled={loading}>
            {status?.paired ? "Re-pair" : "Pair"}
          </Button>
          {status?.paired ? (
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={saving}
              onClick={() => setConfirmUnpair(true)}
            >
              Unpair
            </Button>
          ) : null}
        </div>
      </form>
      <ConfirmModal
        isOpen={confirmUnpair}
        onClose={() => setConfirmUnpair(false)}
        onConfirm={unpair}
        title="Unpair Mesh relay"
        message="This controller will stop using the relay. Relay-side trust remains until it is reset on the relay host."
        confirmLabel="Unpair"
        loading={saving}
        variant="danger"
      />
    </div>
  );
}
