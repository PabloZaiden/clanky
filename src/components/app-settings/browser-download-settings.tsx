/**
 * Device-local transfers presented through framework settings rows and actions.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createLogger, type SettingsSection, type SettingsRow } from "@pablozaiden/webapp/web";
import { getBrowserCollaborationClient } from "../../client-sdk/browser-runtime";
import type { BrowserDownload, BrowserDownloadsSnapshot } from "../../client-sdk/collaboration/browser-downloads";
import { formatFileSize } from "../../utils";
import { SettingsError } from "./settings-row-controls";

const log = createLogger("browser-downloads");
const EMPTY: BrowserDownloadsSnapshot = { downloads: [], loading: false, error: null };
const emptySnapshot = () => EMPTY;
const noSubscription = () => () => {};

function status(download: BrowserDownload): string {
  switch (download.status) {
    case "transferring": return "Transferring to browser storage";
    case "ready": return "Ready to export from browser storage";
    case "export-started": return "Export opened. Verify the saved file before removing the browser copy.";
    case "cancelled": return "Cancelled";
    case "failed": return "Failed";
  }
}

export function useBrowserDownloadSettings(): SettingsSection | null {
  const manager = getBrowserCollaborationClient()?.downloads;
  const snapshot = useSyncExternalStore(manager?.subscribe ?? noSubscription, manager?.getSnapshot ?? emptySnapshot);
  useEffect(() => {
    if (manager) void manager.refresh().catch((error: unknown) => {
      log.warn("Browser download storage could not be loaded", { error: String(error) });
    });
  }, [manager]);
  return useMemo(() => {
    if (!manager) return null;
    const rows: SettingsRow[] = [{
      id: "download-storage",
      title: snapshot.loading ? "Loading browser downloads" : "Browser storage",
      feedback: snapshot.error ? <SettingsError>{String(snapshot.error)}</SettingsError> : undefined,
      actions: [{ id: "refresh-downloads", label: "Refresh", onAction: async () => await manager.refresh() }],
    }, ...snapshot.downloads.map((download): SettingsRow => ({
      id: download.id,
      title: download.name,
      description: status(download),
      content: <span>
        {formatFileSize(download.receivedBytes)}
        {download.totalBytes === undefined ? "" : ` / ${formatFileSize(download.totalBytes)}`}
      </span>,
      feedback: download.error ? <SettingsError>{download.error}</SettingsError> : undefined,
      actions: download.status === "transferring"
        ? [{ id: "cancel", label: "Cancel", onAction: () => manager.cancel(download.id) }]
        : [
          ...(download.status === "ready" || download.status === "export-started" ? [{
            id: "export", label: "Export", onAction: async () => await manager.export(download.id),
          }] : []),
          {
            id: "discard", label: "Remove browser copy", tone: "danger",
            confirmation: {
              title: "Remove browser copy",
              message: "This removes the copy stored by this browser. Verify any exported file first.",
              danger: true,
            },
            onAction: async () => await manager.discard(download.id),
          },
        ],
    }))];
    if (!snapshot.loading && !snapshot.error && !snapshot.downloads.length) {
      rows.push({ id: "empty-downloads", title: "No browser downloads" });
    }
    return {
      id: "browser-downloads", title: "Downloads", scope: "user",
      category: { id: "downloads", title: "Downloads" }, rows,
    };
  }, [manager, snapshot]);
}
