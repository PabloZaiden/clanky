import { useMemo, useState } from "react";
import { Button, StatusBadge } from "../common";
import {
  ActionMenu,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
  useToast,
  type ActionMenuItem,
} from "@pablozaiden/webapp/web";
import {
  usePreviewSessions,
  type PreviewSessionScope,
} from "../../hooks";
import { writeTextToClipboard } from "../../utils";
import { getExecutionHostSourceId } from "@/shared";
import { appResourceUrl } from "../../lib/public-path";
import { getClientSession, getClientStorageScope } from "../../platform/web/client-session";
import {
  nativePreviewAction,
  nativePreviewSchema,
} from "../../platform/web/native-previews";
import { useNativePreviews } from "../../hooks/useNativePreviews";

function formatDateTime(value?: string): string {
  if (!value) {
    return "Not connected";
  }
  return new Date(value).toLocaleString();
}

export interface PreviewSessionsViewProps {
  scope: PreviewSessionScope;
  buildCommand: (port: string) => string;
}

export function PreviewSessionsView({
  scope,
  buildCommand,
}: PreviewSessionsViewProps) {
  const [port, setPort] = useState("3000");
  const [path, setPath] = useState("/");
  const [protocol, setProtocol] = useState("http");
  const [starting, setStarting] = useState(false);
  const [pendingClose, setPendingClose] = useState<{ kind: "native" | "remote"; id: string } | null>(null);
  const toast = useToast();
  const { previews, loading, error, closePreview } = usePreviewSessions(scope);
  const command = useMemo(() => buildCommand(port), [buildCommand, port]);
  const native = useNativePreviews();
  const nativeAvailable = native.platform !== undefined && !getClientSession().demo;
  const target = scope.kind === "workspace"
    ? { kind: "workspace" as const, reference: scope.workspaceId }
    : { kind: "server" as const, reference: getExecutionHostSourceId(scope.executionHost) };
  const localPreviews = native.previews.filter(
    (preview) => preview.target.kind === target.kind && preview.target.reference === target.reference,
  );
  const otherPreviews = nativeAvailable
    ? previews.filter((preview) => !native.previews.some((local) => local.previewId === preview.config.id))
    : previews;

  async function localAction(type: "open" | "close", id: string) {
    try {
      await nativePreviewAction(type, id);
    } catch (error) {
      toast.error(`Unable to ${type} preview: ${String(error)}`);
    }
  }

  async function startPreview() {
    const bridge = window.clankyPreviews;
    if (starting) return;
    if (!bridge) {
      toast.error("Update the native app to start previews on this device.");
      return;
    }
    setStarting(true);
    const owner = getClientStorageScope();
    try {
      const remotePort = Number(port);
      const initialPath = path.trim() || "/";
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
        throw new Error("Remote port must be between 1 and 65535.");
      }
      if (!initialPath.startsWith("/") || initialPath.startsWith("//")
        || /[\\\u0000-\u001f\u007f]/.test(initialPath)) {
        throw new Error("Initial path must be a local path beginning with /.");
      }
      if (protocol !== "http" && protocol !== "https") throw new Error("Choose HTTP or HTTPS.");
      const resource = await appResourceUrl("/api/previews/bridge", "websocket");
      try {
        if (getClientStorageScope() !== owner || !getClientSession().authenticated) {
          throw new Error("The server session changed before the preview could start.");
        }
        const preview = nativePreviewSchema.parse(await bridge.postMessage({
          type: "start", target, port: remotePort, path: initialPath,
          protocol, socketUrl: resource.url,
        }));
        await localAction("open", preview.id);
      } finally {
        resource.dispose?.();
      }
    } catch (error) {
      toast.error(`Unable to start preview: ${String(error)}`);
    } finally {
      setStarting(false);
    }
  }

  async function copyCommand() {
    try {
      await writeTextToClipboard(command);
      toast.success("Preview command copied");
    } catch (err) {
      toast.error(`Failed to copy command: ${String(err)}`);
    }
  }

  async function copyUrl(url: string) {
    try {
      await writeTextToClipboard(url);
      toast.success("Preview URL copied");
    } catch (err) {
      toast.error(`Failed to copy URL: ${String(err)}`);
    }
  }

  async function confirmClosePreview() {
    const preview = pendingClose;
    setPendingClose(null);
    if (preview?.kind === "native") {
      await localAction("close", preview.id);
    } else if (preview) {
      await closePreview(preview.id);
    }
  }

  return (
    <div className="min-w-0 space-y-6">
      {nativeAvailable ? (
        <section className="space-y-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-neutral-900">
          <h2 className="text-base font-semibold text-gray-950 dark:text-gray-100">Preview on this device</h2>
          <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
            event.preventDefault();
            void startPreview();
          }}>
            <TextField label="Remote port" type="number" min={1} max={65535} required
              value={port} onChange={(event) => setPort(event.target.value)} className="w-28" />
            <TextField label="Initial path" required value={path}
              onChange={(event) => setPath(event.target.value)} className="min-w-0 flex-1" />
            <SelectField label="Upstream" value={protocol}
              onChange={(event) => setProtocol(event.target.value)}>
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
            </SelectField>
            <Button type="submit" size="sm" disabled={starting}>
              {starting ? "Starting..." : "Start preview"}
            </Button>
          </form>
          {native.error ? <ErrorState title="Unable to read local previews" description={native.error} /> : null}
          {localPreviews.map((preview) => (
            <div key={preview.id} className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge variant={preview.status === "active" ? "success" : "default"}>
                      {preview.status}
                    </StatusBadge>
                    <span className="font-mono text-sm">{preview.protocol}://localhost:{preview.port}</span>
                  </div>
                  {preview.url ? <div className="break-all font-mono text-xs text-gray-500 dark:text-gray-400">{preview.url}</div> : null}
                  {preview.error ? <p className="break-words text-sm text-red-600 dark:text-red-400">{preview.error}</p> : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={preview.status !== "active"} onClick={() => void localAction("open", preview.id)}>Open</Button>
                  <ActionMenu ariaLabel="Local preview actions" triggerVariant="ghost" triggerSize="compact" items={[
                    ...(preview.status === "active" && preview.url ? [{
                      id: "copy", label: "Copy URL", onAction: () => void copyUrl(preview.url!),
                    }] : []),
                    { id: "close", label: "Close", destructive: true, onAction: () => setPendingClose({ kind: "native", id: preview.id }) },
                  ] satisfies ActionMenuItem[]} />
                </div>
              </div>
            </div>
          ))}
        </section>
      ) : null}
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-neutral-900">
        <div>
          <h2 className="text-base font-semibold text-gray-950 dark:text-gray-100">Start from the CLI</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Run this command locally. The port must match your app&apos;s dev server on the preview target.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <TextField
            label="Remote port"
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(event) => setPort(event.target.value)}
            className="w-28"
          />
          <code className="min-w-0 basis-full flex-1 overflow-x-auto rounded-md bg-white px-3 py-2 font-mono text-sm text-gray-900 sm:basis-0 dark:bg-neutral-900 dark:text-gray-100">
            {command}
          </code>
          <Button type="button" size="sm" onClick={() => void copyCommand()}>
            Copy
          </Button>
        </div>
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          Add <code>--host 0.0.0.0</code> for LAN/mobile testing. The CLI will print a network exposure warning.
        </p>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-neutral-900">
        <h2 className="text-base font-semibold text-gray-950 dark:text-gray-100">Active previews</h2>
        {loading && otherPreviews.length === 0 ? (
          <LoadingState title="Refreshing previews" />
        ) : error ? (
          <ErrorState title="Unable to load previews" description={error} />
        ) : otherPreviews.length === 0 ? (
          <EmptyState
            title={nativeAvailable ? "No other active previews" : "No active previews"}
            description="Previews only exist while their CLI or native app proxy is connected."
          />
        ) : (
          <div className="space-y-3">
            {otherPreviews.map((preview) => (
              <div
                key={preview.config.id}
                className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-neutral-900"
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge variant={preview.state.status === "active" ? "success" : "default"}>
                        {preview.state.status}
                      </StatusBadge>
                      <span className="font-mono text-sm text-gray-900 dark:text-gray-100">
                        {preview.config.remoteHost}:{preview.config.remotePort}
                      </span>
                    </div>
                    <div className="break-all font-mono text-xs text-gray-500 dark:text-gray-400">
                      {preview.config.localUrl}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      Bound to {preview.config.localHost}:{preview.config.localPort} · Path {preview.config.initialPath} · Connected {formatDateTime(preview.state.connectedAt)}
                    </div>
                    {preview.config.cliHostname ? (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        CLI host: {preview.config.cliHostname}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {nativeAvailable ? (
                      <span className="text-xs text-gray-500 dark:text-gray-400">Started in another window or device</span>
                    ) : (
                      <Button size="sm" onClick={() => window.open(preview.config.localUrl, "_blank", "noopener,noreferrer")}>
                        Open
                      </Button>
                    )}
                    <ActionMenu
                      ariaLabel="Preview actions"
                      triggerVariant="ghost"
                      triggerSize="compact"
                      items={[
                        {
                          id: "copy-url",
                          label: "Copy URL",
                          onAction: () => void copyUrl(preview.config.localUrl),
                        },
                        {
                          id: "close",
                          label: "Close",
                          destructive: true,
                          onAction: () => setPendingClose({ kind: "remote", id: preview.config.id }),
                        },
                      ] satisfies ActionMenuItem[]}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <ConfirmDialog
        open={pendingClose !== null}
        title="Close preview?"
        message="This disconnects the active preview session."
        confirmLabel="Close preview"
        danger
        onCancel={() => setPendingClose(null)}
        onConfirm={() => void confirmClosePreview()}
      />
    </div>
  );
}
