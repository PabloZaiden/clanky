import { useEffect, useMemo, useState } from "react";
import { MonacoCodeEditor } from "../MonacoCodeEditor";
import { Button, RefreshIcon, WrapTextIcon } from "../common";

const EDITOR_LANGUAGE_OPTIONS = [
  { id: "plaintext", label: "Plain Text" },
  { id: "typescript", label: "TypeScript" },
  { id: "javascript", label: "JavaScript" },
  { id: "python", label: "Python" },
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
  const normalizedPath = path.toLowerCase();
  if (normalizedPath.endsWith(".ts") || normalizedPath.endsWith(".tsx")) return "typescript";
  if (normalizedPath.endsWith(".js") || normalizedPath.endsWith(".jsx")) return "javascript";
  if (
    normalizedPath.endsWith(".py")
    || normalizedPath.endsWith(".py2")
    || normalizedPath.endsWith(".py3")
    || normalizedPath.endsWith(".pyw")
    || normalizedPath.endsWith(".pyi")
    || normalizedPath.endsWith(".pyx")
    || normalizedPath.endsWith(".pxd")
    || normalizedPath.endsWith(".pxi")
  ) return "python";
  if (normalizedPath.endsWith(".json")) return "json";
  if (normalizedPath.endsWith(".md")) return "markdown";
  if (normalizedPath.endsWith(".css")) return "css";
  if (normalizedPath.endsWith(".html")) return "html";
  if (normalizedPath.endsWith(".sh")) return "shell";
  if (normalizedPath.endsWith(".yml") || normalizedPath.endsWith(".yaml")) return "yaml";
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
          <MonacoCodeEditor
            height="100%"
            language={editorLanguage}
            value={value}
            onChange={onChange}
            wordWrap={wordWrapEnabled ? "on" : "off"}
            ariaLabel={`Code editor: ${displayPath ?? "file"}`}
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
