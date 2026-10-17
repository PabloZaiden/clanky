import { useEffect, useState } from "react";
import { ActionMenu, Modal, Select, SelectField, type ActionMenuItem } from "@pablozaiden/webapp/web";
import { Button, PreviewIcon, RefreshIcon, SaveIcon, WrapTextIcon } from "../common";
import {
  EditorLanguageOptions,
  getEditorLanguageLabel,
  type EditorLanguageId,
  type EditorLanguageSelection,
} from "./editor-language";

interface EditorTools {
  filePath?: string;
  loading: boolean;
  canPreview: boolean;
  showPreview: boolean;
  wordWrapEnabled: boolean;
  detectedLanguage: EditorLanguageId;
  selectedLanguage: EditorLanguageSelection;
  onLanguageChange: (language: EditorLanguageSelection) => void;
  onTogglePreview: () => void;
  onToggleWordWrap: () => void;
  onRefresh: () => Promise<boolean>;
}

function EditorDesktopTools({ tools, languageLabel, wordWrapLabel }: {
  tools: EditorTools;
  languageLabel: string;
  wordWrapLabel: string;
}) {
  return (
    <div className="hidden items-center gap-2 sm:flex">
      {tools.canPreview ? (
        <Button
          variant={tools.showPreview ? "secondary" : "ghost"}
          size="sm"
          onClick={tools.onTogglePreview}
          disabled={tools.loading}
          icon={<PreviewIcon size="h-4 w-4" />}
          aria-label="Markdown preview"
          aria-pressed={tools.showPreview}
          title={tools.showPreview ? "Show Markdown code" : "Show Markdown preview"}
          className="w-9 px-0"
        >
          <span className="sr-only">Markdown preview</span>
        </Button>
      ) : null}
      {tools.filePath ? (
        <Select
          value={tools.selectedLanguage}
          onChange={(event) => tools.onLanguageChange(event.target.value as EditorLanguageSelection)}
          disabled={tools.loading}
          aria-label="Code explorer language"
          title={`Code explorer language: ${languageLabel}`}
          className="min-w-0 max-w-full"
        >
          <EditorLanguageOptions detectedLanguage={tools.detectedLanguage} />
        </Select>
      ) : null}
      <Button
        variant={tools.wordWrapEnabled ? "secondary" : "ghost"}
        size="sm"
        onClick={tools.onToggleWordWrap}
        disabled={!tools.filePath || tools.loading || tools.showPreview}
        icon={<WrapTextIcon size="h-4 w-4" />}
        aria-label={wordWrapLabel}
        aria-pressed={tools.wordWrapEnabled}
        title={wordWrapLabel}
        className="w-9 px-0"
      >
        <span className="sr-only">{wordWrapLabel}</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void tools.onRefresh()}
        disabled={!tools.filePath || tools.loading}
        icon={<RefreshIcon size="h-4 w-4" />}
        aria-label="Refresh file"
        title="Refresh file"
        className="w-9 px-0"
      >
        <span className="sr-only">Refresh file</span>
      </Button>
    </div>
  );
}

export function WorkspaceEditorToolbar({ displayPath, statusText, dirty, saving, onSave, tools }: {
  displayPath?: string;
  statusText: string | null;
  dirty: boolean;
  saving: boolean;
  onSave: () => Promise<boolean>;
  tools: EditorTools;
}) {
  const [languageDialogOpen, setLanguageDialogOpen] = useState(false);
  const displayName = displayPath?.split(/[\\/]/).pop() || "No file selected";
  const wordWrapLabel = tools.wordWrapEnabled ? "Disable word wrap" : "Enable word wrap";
  const languageLabel = tools.selectedLanguage === "auto"
    ? `Auto (${getEditorLanguageLabel(tools.detectedLanguage)})`
    : getEditorLanguageLabel(tools.selectedLanguage);
  const mobileActions: ActionMenuItem[] = [
    ...(tools.canPreview ? [{
      id: "preview", label: tools.showPreview ? "Show code" : "Preview Markdown",
      disabled: tools.loading, onAction: tools.onTogglePreview,
    }] : []),
    { id: "language", label: `Language: ${languageLabel}`, onAction: () => setLanguageDialogOpen(true) },
    { id: "word-wrap", label: wordWrapLabel, disabled: tools.showPreview, onAction: tools.onToggleWordWrap },
    { id: "refresh", label: "Refresh file", onAction: () => void tools.onRefresh() },
  ];
  useEffect(() => setLanguageDialogOpen(false), [displayPath]);
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 sm:flex-wrap dark:border-gray-800">
        <div className="min-w-0 flex-1">
          <h2 className={`truncate text-sm font-semibold ${dirty && !tools.loading ? "text-amber-700 dark:text-amber-300" : "text-gray-900 dark:text-gray-100"}`} title={displayPath}>
            <span className="sm:hidden">{displayName}</span>
            <span className="hidden sm:inline">{displayPath ?? "No file selected"}</span>
          </h2>
          {statusText ? (
            <p
              className="sr-only"
              role="status"
              title={statusText}
            >
              {statusText}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          <EditorDesktopTools tools={tools} languageLabel={languageLabel} wordWrapLabel={wordWrapLabel} />
          <Button
            variant="primary"
            size="sm"
            onClick={() => void onSave()}
            disabled={!tools.filePath || !dirty || tools.loading}
            loading={saving}
            icon={<SaveIcon size="h-4 w-4" />}
            aria-label="Save file"
            title="Save file"
            className="w-9 px-0"
          >
            <span className="sr-only">Save</span>
          </Button>
          <div className="sm:hidden">
            <ActionMenu ariaLabel="Editor options" triggerVariant="ghost" triggerSize="compact" disabled={!tools.filePath || tools.loading} items={mobileActions} />
          </div>
        </div>
      </div>
      <Modal
        isOpen={languageDialogOpen}
        onClose={() => setLanguageDialogOpen(false)}
        title="Editor language"
        size="sm"
        footer={<Button variant="secondary" onClick={() => setLanguageDialogOpen(false)}>Done</Button>}
      >
        <SelectField
          label="Language"
          value={tools.selectedLanguage}
          disabled={tools.loading}
          onChange={(event) => tools.onLanguageChange(event.target.value as EditorLanguageSelection)}
        >
          <EditorLanguageOptions detectedLanguage={tools.detectedLanguage} />
        </SelectField>
      </Modal>
    </>
  );
}
