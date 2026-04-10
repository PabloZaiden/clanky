import { useEffect, useMemo, useState } from "react";
import MonacoEditor from "@monaco-editor/react";
import { Button, RefreshIcon, WrapTextIcon } from "../common";

const EDITOR_LANGUAGE_OPTIONS = [
  { id: "plaintext", label: "Plain Text" },
  { id: "typescript", label: "TypeScript" },
  { id: "javascript", label: "JavaScript" },
  { id: "json", label: "JSON" },
  { id: "markdown", label: "Markdown" },
  { id: "css", label: "CSS" },
  { id: "html", label: "HTML" },
  { id: "shell", label: "Shell" },
  { id: "yaml", label: "YAML" },
] as const;

type EditorLanguageId = (typeof EDITOR_LANGUAGE_OPTIONS)[number]["id"];
type EditorLanguageSelection = "auto" | EditorLanguageId;

function detectLanguage(path: string | undefined): EditorLanguageId {
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

function getLanguageLabel(languageId: EditorLanguageId): string {
  return EDITOR_LANGUAGE_OPTIONS.find((language) => language.id === languageId)?.label ?? "Plain Text";
}

interface WorkspaceEditorPanelProps {
  filePath?: string;
  pendingFilePath?: string | null;
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
  pendingFilePath,
  value,
  loading,
  saving,
  dirty,
  autoReloadedAt,
  onChange,
  onRefresh,
  onSave,
}: WorkspaceEditorPanelProps) {
  const [wordWrapEnabled, setWordWrapEnabled] = useState(true);
  const [selectedLanguage, setSelectedLanguage] = useState<EditorLanguageSelection>("auto");
  const displayPath = pendingFilePath ?? filePath;
  const detectedLanguage = useMemo(() => detectLanguage(displayPath), [displayPath]);
  const editorLanguage = selectedLanguage === "auto" ? detectedLanguage : selectedLanguage;
  const statusText = loading
    ? `Loading ${pendingFilePath ?? filePath ?? "file"}...`
    : dirty
      ? "Unsaved changes"
      : autoReloadedAt
        ? `Auto-reloaded at ${new Date(autoReloadedAt).toLocaleTimeString()}`
        : null;
  const wordWrapLabel = wordWrapEnabled ? "Disable word wrap" : "Enable word wrap";

  useEffect(() => {
    setSelectedLanguage("auto");
  }, [displayPath]);

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
            {displayPath ?? "No file selected"}
          </h2>
          {statusText && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {statusText}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {filePath ? (
            <select
              value={selectedLanguage}
              onChange={(event) => setSelectedLanguage(event.target.value as EditorLanguageSelection)}
              disabled={loading}
              aria-label="Code explorer language"
              title={`Code explorer language: ${selectedLanguage === "auto" ? `Auto (${getLanguageLabel(detectedLanguage)})` : getLanguageLabel(editorLanguage)}`}
              className="min-w-0 max-w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100"
            >
              <option value="auto">Auto ({getLanguageLabel(detectedLanguage)})</option>
              {EDITOR_LANGUAGE_OPTIONS.map((language) => (
                <option key={language.id} value={language.id}>
                  {language.label}
                </option>
              ))}
            </select>
          ) : null}
          <Button
            variant={wordWrapEnabled ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setWordWrapEnabled((currentValue) => !currentValue)}
            disabled={!filePath || loading}
            icon={<WrapTextIcon size="h-4 w-4" />}
            aria-label={wordWrapLabel}
            aria-pressed={wordWrapEnabled}
            title={wordWrapLabel}
            className="w-9 px-0"
          >
            <span className="sr-only">{wordWrapLabel}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onRefresh()}
            disabled={!filePath || loading}
            icon={<RefreshIcon size="h-4 w-4" />}
            aria-label="Refresh file"
            title="Refresh file"
            className="w-9 px-0"
          >
            <span className="sr-only">Refresh file</span>
          </Button>
          <Button variant="primary" size="sm" onClick={() => void onSave()} disabled={!filePath || !dirty || loading} loading={saving}>
            Save
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {loading && pendingFilePath ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-gray-500 dark:text-gray-400">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent dark:border-gray-500" />
            <div>
              <p className="font-medium text-gray-700 dark:text-gray-200">Loading selected file</p>
              <p className="mt-1 break-all">{pendingFilePath}</p>
            </div>
          </div>
        ) : filePath ? (
          <MonacoEditor
            height="100%"
            theme="vs-dark"
            language={editorLanguage}
            value={value}
            onChange={(nextValue: string | undefined) => onChange(nextValue ?? "")}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              automaticLayout: true,
              wordWrap: wordWrapEnabled ? "on" : "off",
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
