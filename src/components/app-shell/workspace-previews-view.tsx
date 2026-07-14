import { useMemo, useState } from "react";
import type { Workspace } from "@/shared";
import { useToast, useWorkspacePreviews } from "../../hooks";
import { buildPreviewCliCommand, writeTextToClipboard } from "../../utils";
import { Button, StatusBadge } from "../common";
import { ShellPanel } from "./shell-panel";

function formatDateTime(value?: string): string {
  if (!value) {
    return "Not connected";
  }
  return new Date(value).toLocaleString();
}

export function WorkspacePreviewsView({
  workspace,
  workspaces,
  headerOffsetClassName,
}: {
  workspace: Workspace;
  workspaces: Workspace[];
  headerOffsetClassName?: string;
}) {
  const [port, setPort] = useState("3000");
  const toast = useToast();
  const { previews, loading, error, closePreview } = useWorkspacePreviews(workspace.id);
  const command = useMemo(
    () => buildPreviewCliCommand({ workspace, workspaces, port }),
    [port, workspace, workspaces],
  );

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

  return (
    <ShellPanel
      eyebrow="Workspace"
      title="Live previews"
      description={`${workspace.name} · ${workspace.directory}`}
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
    >
      <div className="min-w-0 space-y-6">
        <div className="rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Start from the CLI</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Run this command locally. The port must match your app&apos;s dev server inside the workspace.
            </p>
          </div>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-gray-500 dark:text-gray-400">Remote port</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(event) => setPort(event.target.value)}
                className="w-28 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100"
              />
            </label>
            <code className="min-w-0 basis-full flex-1 overflow-x-auto rounded-md bg-white px-3 py-2 font-mono text-sm text-gray-900 sm:basis-0 dark:bg-neutral-900 dark:text-gray-100">
              {command}
            </code>
            <Button size="sm" onClick={copyCommand}>Copy</Button>
          </div>
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            Add <code>--host 0.0.0.0</code> for LAN/mobile testing. The CLI will print a network exposure warning.
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Active previews</h2>
            {loading ? <span className="text-xs text-gray-500 dark:text-gray-400">Refreshing...</span> : null}
          </div>
          {error ? <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          {previews.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              No previews are active. Previews only exist while the CLI command is connected.
            </p>
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
                      <Button size="sm" variant="secondary" onClick={() => void copyUrl(preview.config.localUrl)}>
                        Copy URL
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => void closePreview(preview.config.id)}>
                        Close
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </ShellPanel>
  );
}
