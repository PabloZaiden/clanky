/** Import/Export Workspaces section. */

import { useRef, useState } from "react";
import { Button } from "../common";
import type { WorkspaceExportData, WorkspaceImportResult } from "../../types/workspace";

export interface ImportExportSectionProps {
  onExportConfig?: () => Promise<WorkspaceExportData | null>;
  onImportConfig?: (data: WorkspaceExportData) => Promise<WorkspaceImportResult | null>;
  configSaving?: boolean;
}

export function ImportExportSection({ onExportConfig, onImportConfig, configSaving = false }: ImportExportSectionProps) {
  const [importResult, setImportResult] = useState<WorkspaceImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleExport() {
    if (!onExportConfig) return;
    setExportError(null);
    const data = await onExportConfig();
    if (!data) {
      setExportError("Failed to export workspace configs.");
      return;
    }
    const json = JSON.stringify(data, null, 2);
    const date = new Date().toISOString().split("T")[0];
    const filename = `clanky-workspaces-${date}.json`;
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handleImportFile(file: File) {
    if (!onImportConfig) return;
    setImportResult(null);
    setImportError(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text) as WorkspaceExportData;
      const result = await onImportConfig(data);
      if (result) {
        setImportResult(result);
      } else {
        setImportError("Failed to import workspace configs.");
      }
    } catch (err) {
      setImportError(`Import failed: ${String(err)}`);
    }
    // Reset file input so the same file can be re-selected
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  if (!onExportConfig && !onImportConfig) return null;

  return (
    <div>
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-4">
        Import / Export Workspaces
      </h3>
      <div className="space-y-3 p-4 rounded-lg bg-gray-50 dark:bg-neutral-900">
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Warning: exported files contain server settings in plain text, including
          passwords. Store exported files securely.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {onExportConfig && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleExport}
              disabled={configSaving}
              loading={configSaving}
            >
              Export
            </Button>
          )}
          {onImportConfig && (
            <>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={configSaving}
                loading={configSaving}
              >
                Import
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImportFile(file);
                }}
              />
            </>
          )}
        </div>
        {exportError && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded px-3 py-2">
            {exportError}
          </div>
        )}
        {importError && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded px-3 py-2">
            {importError}
          </div>
        )}
        {importResult && (
          <div className={`text-sm rounded px-3 py-2 ${importResult.failed > 0 ? "bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300" : "bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300"}`}>
            <p className="font-medium mb-1">
              Import complete: {importResult.created} created{importResult.failed > 0 ? `, ${importResult.failed} failed` : ""}.
            </p>
            {importResult.details.length > 0 && (
              <ul className="text-xs space-y-0.5">
                {importResult.details.map((d, i) => (
                  <li key={i}>
                    <span className={`break-all ${d.status === "created" ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                      {d.status === "created" ? "+" : "✕"} {d.name} ({d.directory})
                      {d.reason ? ` — ${d.reason}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
