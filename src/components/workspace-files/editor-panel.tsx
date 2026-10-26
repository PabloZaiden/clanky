import { useEffect, useMemo, useState } from "react";
import { MonacoCodeEditor } from "../MonacoCodeEditor";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { detectEditorLanguage, type EditorLanguageSelection } from "./editor-language";
import { WorkspaceEditorToolbar } from "./editor-toolbar";
import { useWorkspaceReadOnly } from "../../context/workspace-access-context";

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
  const readOnly = useWorkspaceReadOnly();
  const [wordWrapEnabled, setWordWrapEnabled] = useState(true);
  const [selectedLanguage, setSelectedLanguage] = useState<EditorLanguageSelection>("auto");
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
  const displayPath = pendingFilePath ?? filePath;
  const detectedLanguage = useMemo(() => detectEditorLanguage(displayPath), [displayPath]);
  const editorLanguage = selectedLanguage === "auto" ? detectedLanguage : selectedLanguage;
  const canPreview = Boolean(filePath) && editorLanguage === "markdown";
  const showPreview = canPreview && previewFilePath === filePath && !loading;
  const statusText = loading
    ? `Loading ${pendingFilePath ?? filePath ?? "file"}...`
    : dirty
      ? "Unsaved changes"
      : autoReloadedAt
        ? `Auto-reloaded at ${new Date(autoReloadedAt).toLocaleTimeString()}`
        : null;

  useEffect(() => {
    setSelectedLanguage("auto");
    setPreviewFilePath(null);
  }, [displayPath]);

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-900">
      <WorkspaceEditorToolbar
        displayPath={displayPath}
        statusText={statusText}
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        tools={{
          filePath, loading, canPreview, showPreview, wordWrapEnabled, detectedLanguage, selectedLanguage,
          onLanguageChange: (language) => {
            setSelectedLanguage(language);
            setPreviewFilePath(null);
          },
          onTogglePreview: () => setPreviewFilePath(showPreview ? null : filePath ?? null),
          onToggleWordWrap: () => setWordWrapEnabled((currentValue) => !currentValue),
          onRefresh,
        }}
      />
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
          <>
            {/* Keep Monaco's model, undo history and view state while previewing. */}
            <div className={showPreview ? "hidden" : "h-full"}>
              <MonacoCodeEditor
                height="100%"
                language={editorLanguage}
                value={value}
                readOnly={readOnly}
                onChange={onChange}
                wordWrap={wordWrapEnabled ? "on" : "off"}
                ariaLabel={`Code editor: ${displayPath ?? "file"}`}
              />
            </div>
            {showPreview ? (
              <div aria-label="Markdown preview" className="h-full min-w-0 overflow-auto px-4 py-3 sm:px-6">
                <MarkdownRenderer content={value} />
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            Select a file from the explorer to start editing.
          </div>
        )}
      </div>
    </section>
  );
}
