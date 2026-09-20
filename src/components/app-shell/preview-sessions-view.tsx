import { useMemo, useState } from "react";
import { Button, StatusBadge } from "../common";
import {
  ActionMenu,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  TextField,
  useToast,
  type ActionMenuItem,
} from "@pablozaiden/webapp/web";
import {
  usePreviewSessions,
  type PreviewSessionScope,
} from "../../hooks";
import { writeTextToClipboard } from "../../utils";

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
  const [pendingClosePreviewId, setPendingClosePreviewId] = useState<string | null>(null);
  const toast = useToast();
  const { previews, loading, error, closePreview } = usePreviewSessions(scope);
  const command = useMemo(() => buildCommand(port), [buildCommand, port]);

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
    const previewId = pendingClosePreviewId;
    setPendingClosePreviewId(null);
    if (previewId) {
      await closePreview(previewId);
    }
  }

  return (
    <div className="min-w-0 space-y-6">
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
        {loading && previews.length === 0 ? (
          <LoadingState title="Refreshing previews" />
        ) : error ? (
          <ErrorState title="Unable to load previews" description={error} />
        ) : previews.length === 0 ? (
          <EmptyState
            title="No active previews"
            description="Previews only exist while the CLI command is connected."
          />
        ) : (
          <div className="space-y-3">
            {previews.map((preview) => (
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
                    <Button size="sm" onClick={() => window.open(preview.config.localUrl, "_blank", "noopener,noreferrer")}>
                      Open
                    </Button>
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
                          onAction: () => setPendingClosePreviewId(preview.config.id),
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
        open={pendingClosePreviewId !== null}
        title="Close preview?"
        message="This disconnects the active preview session."
        confirmLabel="Close preview"
        danger
        onCancel={() => setPendingClosePreviewId(null)}
        onConfirm={() => void confirmClosePreview()}
      />
    </div>
  );
}
