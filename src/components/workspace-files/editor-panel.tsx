import MonacoEditor from "@monaco-editor/react";
import { Button, RefreshIcon } from "../common";

function detectLanguage(path: string | undefined): string {
  if (!path) {
    return "plaintext";
  }
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".sh")) return "shell";
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "yaml";
  return "plaintext";
}

interface WorkspaceEditorPanelProps {
  filePath?: string;
  value: string;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  autoReloadedAt: string | null;
  onChange: (value: string) => void;
  onRefresh: () => Promise<boolean>;
  onSave: () => Promise<boolean>;
}

export function WorkspaceEditorPanel({
  filePath,
  value,
  loading,
  saving,
  dirty,
  autoReloadedAt,
  onChange,
  onRefresh,
  onSave,
}: WorkspaceEditorPanelProps) {
  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
            {filePath ?? "No file selected"}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {dirty ? "Unsaved changes" : autoReloadedAt ? `Auto-reloaded at ${new Date(autoReloadedAt).toLocaleTimeString()}` : "Editor ready"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void onRefresh()} disabled={!filePath || loading} icon={<RefreshIcon size="h-4 w-4" />}>
            Refresh
          </Button>
          <Button variant="primary" size="sm" onClick={() => void onSave()} disabled={!filePath || !dirty || loading} loading={saving}>
            Save
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {filePath ? (
          <MonacoEditor
            height="100%"
            theme="vs-dark"
            language={detectLanguage(filePath)}
            value={value}
            onChange={(nextValue) => onChange(nextValue ?? "")}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              automaticLayout: true,
              wordWrap: "on",
              scrollBeyondLastLine: false,
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            Select a file from the explorer to start editing.
          </div>
        )}
      </div>
    </section>
  );
}
