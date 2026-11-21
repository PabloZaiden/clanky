import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import {
  Button, ConfirmDialog, ErrorState, FormSection, Modal, Select, SettingsFieldRow, TextAreaField, TextField,
  isThemePreference, useAsyncOperation, useTheme,
} from "@pablozaiden/webapp/web";
import { AppearancePreferenceSchema, CUSTOM_THEME_ID, SAFE_THEME_PARAMETER, type AppearancePreference } from "@/contracts/schemas/appearance";
import { CodeIcon } from "@/components/common/Icons";
import { useAppearance } from "../appearance-context";
import { appearanceThemes, selectedAppearanceTheme, type AppearanceTheme } from "../appearance-themes";
import { editableThemeCss, readThemeCss, themeFileContents } from "../theme-file";
import { downloadGeneratedFile } from "../download-generated-file";

function ThemePreview({ theme, dark }: { theme: AppearanceTheme; dark: boolean }) {
  if (theme.css !== undefined) {
    return <span className="clanky-theme-preview items-center justify-center bg-[var(--wapp-surface-muted)]" aria-hidden="true">
      <CodeIcon size="h-6 w-6" />
    </span>;
  }
  const colors = dark ? theme.style?.dark : theme.style?.light;
  const surface = colors?.["--wapp-surface"] ?? (dark ? "#171717" : "#ffffff");
  const muted = colors?.["--wapp-muted"] ?? (dark ? "#a3a3a3" : "#4b5563");
  return <span className="clanky-theme-preview" aria-hidden="true" style={{
    background: colors?.["--wapp-content-bg"] ?? (dark ? "#0d0d0d" : "#f9fafb"),
    borderRadius: colors?.["--wapp-panel-radius"] ?? "12px",
    color: colors?.["--wapp-text"] ?? (dark ? "#f5f5f5" : "#111827"),
  }}>
    <span className="clanky-theme-preview-sidebar" style={{ background: colors?.["--wapp-sidebar-bg"] ?? surface }}>
      <i style={{ background: colors?.["--wapp-primary"] ?? muted }} />
      <i style={{ background: colors?.["--wapp-sidebar-active-bg"] ?? muted }} />
      <i style={{ background: muted }} /><i style={{ background: muted }} />
    </span>
    <span className="clanky-theme-preview-content">
      <i style={{ background: muted }} />
      <span style={{
        background: surface,
        border: `${colors?.["--wapp-panel-border-width"] ?? "1px"} solid ${colors?.["--wapp-border"] ?? muted}`,
        borderRadius: colors?.["--wapp-control-radius"] ?? "4px",
      }}>
        <i style={{ background: muted }} /><i style={{ background: muted }} />
      </span>
      <i style={{ background: colors?.["--wapp-primary"] ?? muted }} />
    </span>
  </span>;
}

export function AppearanceSection({ setError }: { setError: (error: string | undefined) => void }) {
  const themeId = useId();
  const { preference, resolvedTheme, savePreference, loading, error, retry } = useTheme();
  const { pending: saving, start, finish, isCurrent } = useAsyncOperation({ abortOnUnmount: false });
  const importing = useAsyncOperation();
  const appearance = useAppearance();
  const { saved: savedAppearance, draft, safeTheme, preview, save: saveAppearance, pending } = appearance;
  const [editor, setEditor] = useState<string>();
  const [themeName, setThemeName] = useState<string>();
  const [nameError, setNameError] = useState<string>();
  const [removeOpen, setRemoveOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const themeGroupId = useId();
  const nameFormId = useId();
  const selected = selectedAppearanceTheme(draft);
  const isCustom = selected.id === CUSTOM_THEME_ID;
  const isNamed = draft.customThemes.some(({ id }) => id === selected.id);
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedAppearance);
  const disabled = pending || saving || importing.pending || Boolean(appearance.error);

  useEffect(() => () => preview(undefined), [preview]);

  function previewAppearance(value: AppearancePreference) {
    setError(undefined);
    preview(value);
  }

  function previewCustom(css: string) {
    previewAppearance({ ...draft, selected: CUSTOM_THEME_ID, customCss: css });
  }

  async function applyAppearance() {
    setError(undefined);
    try {
      await saveAppearance(draft);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveNamedTheme(name: string) {
    if (disabled || dirty || savedAppearance.selected !== CUSTOM_THEME_ID) return;
    setNameError(undefined);
    const result = AppearancePreferenceSchema.safeParse({
      ...savedAppearance,
      customThemes: [...savedAppearance.customThemes, {
        id: crypto.randomUUID(),
        name,
        css: savedAppearance.customCss ?? "",
      }],
    });
    if (!result.success) {
      setNameError(result.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    try {
      await saveAppearance(result.data);
      setThemeName(undefined);
    } catch (error) {
      setNameError(error instanceof Error ? error.message : String(error));
    }
  }

  async function importTheme(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const token = importing.start();
    if (!token) return;
    setError(undefined);
    try {
      const css = await readThemeCss(file);
      if (importing.isCurrent(token)) previewCustom(css);
    } catch (error) {
      if (importing.isCurrent(token)) setError(error instanceof Error ? error.message : String(error));
    } finally {
      importing.finish(token);
    }
  }

  function exportTheme() {
    setError(undefined);
    try {
      const filename = selected.name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "theme";
      downloadGeneratedFile(new Blob([themeFileContents(selected)], { type: "text/css" }), `${filename}.clanky-theme.css`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  async function updateTheme(value: string) {
    if (!isThemePreference(value)) {
      setError("Invalid theme");
      return;
    }
    const token = start();
    if (!token) return;
    setError(undefined);
    try {
      await savePreference(value);
    } catch (error) {
      if (isCurrent(token)) setError(error instanceof Error ? error.message : String(error));
    } finally {
      finish(token);
    }
  }

  return <FormSection title="Appearance">
    {safeTheme ? <SettingsFieldRow title="Theme safe mode" actions={
      <Button type="button" disabled={dirty || disabled} onClick={() => {
        const url = new URL(location.href);
        url.searchParams.delete(SAFE_THEME_PARAMETER);
        location.replace(url.href);
      }}>Resume themes</Button>
    } /> : null}
    <SettingsFieldRow
      title="Color mode"
      labelFor={themeId}
      content={<Select id={themeId} value={preference} disabled={loading || disabled} onChange={(event) => void updateTheme(event.currentTarget.value)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </Select>}
    />
    {error ? <ErrorState description={error.message} action={<Button type="button" disabled={loading} onClick={() => void retry()}>Retry</Button>} /> : null}
    {appearance.error ? <ErrorState description={appearance.error.message} action={<Button type="button" disabled={pending} onClick={() => void appearance.retry()}>Retry</Button>} /> : null}
    <fieldset className="clanky-theme-picker" disabled={disabled}>
      <legend>Theme</legend>
      <div className="clanky-theme-gallery">
        {appearanceThemes(draft).map((theme) => <label key={theme.id} className="clanky-theme-choice">
          <input type="radio" name={themeGroupId} value={theme.id} checked={draft.selected === theme.id}
            onChange={() => previewAppearance({ ...draft, selected: theme.id })} />
          <ThemePreview theme={theme} dark={resolvedTheme === "dark"} />
          <span>{theme.name}</span>
        </label>)}
      </div>
    </fieldset>
    {dirty ? <SettingsFieldRow
      title={safeTheme ? `Unapplied theme: ${selected.name}` : `Previewing ${selected.name}`}
      actions={<>
        <Button type="button" disabled={disabled} onClick={() => void applyAppearance()}>Apply theme</Button>
        <Button type="button" disabled={disabled} onClick={() => { preview(undefined); setError(undefined); }}>Cancel preview</Button>
      </>}
    /> : null}
    <SettingsFieldRow
      title="Custom theme"
      actions={<>
        <Button type="button" disabled={disabled} onClick={() => setEditor(editableThemeCss(selected))}>
          {isCustom ? "Edit CSS" : "Edit as Custom"}
        </Button>
        <Button type="button" disabled={disabled} onClick={() => fileInput.current?.click()}>Import CSS</Button>
        {isCustom ? <Button type="button" disabled={disabled || dirty} onClick={() => {
          setNameError(undefined);
          setThemeName("");
        }}>Save as…</Button> : null}
      </>}
    />
    <SettingsFieldRow
      title="Theme library"
      actions={<>
        <Button type="button" disabled={disabled} onClick={exportTheme}>Export theme</Button>
        {draft.selected !== "clanky" ? <Button type="button" disabled={disabled} onClick={() => previewAppearance({ ...draft, selected: "clanky" })}>Reset to Clanky</Button> : null}
        {isNamed ? <Button type="button" disabled={disabled} tone="danger" onClick={() => setRemoveOpen(true)}>Remove theme</Button> : null}
      </>}
    />
    <input ref={fileInput} className="sr-only" type="file" accept=".css,text/css" tabIndex={-1}
      aria-label="Import theme stylesheet" onChange={(event) => void importTheme(event)} />
    <Modal isOpen={editor !== undefined} onClose={() => setEditor(undefined)} title="Edit Custom theme" size="lg" footer={<>
      <Button type="button" onClick={() => setEditor(undefined)}>Cancel</Button>
      <Button type="button" variant="primary" disabled={disabled} onClick={() => {
        if (editor === undefined) return;
        previewCustom(editor);
        setEditor(undefined);
      }}>{safeTheme ? "Use CSS" : "Preview CSS"}</Button>
    </>}>
      <TextAreaField label="CSS" className="font-mono" rows={12} wrap="off" spellCheck={false}
        value={editor ?? ""} onChange={(event) => setEditor(event.currentTarget.value)} />
    </Modal>
    <Modal isOpen={themeName !== undefined} onClose={() => { if (!pending) setThemeName(undefined); }}
      title="Save theme as" size="sm" closeOnOverlayClick={!pending} footer={<>
        <Button type="button" disabled={pending} onClick={() => setThemeName(undefined)}>Cancel</Button>
        <Button type="submit" form={nameFormId} variant="primary" disabled={disabled || dirty || !themeName?.trim()}>Save theme</Button>
      </>}>
      <form id={nameFormId} onSubmit={(event) => {
        event.preventDefault();
        if (themeName?.trim()) void saveNamedTheme(themeName);
      }}>
        <TextField label="Theme name" required maxLength={60} disabled={pending}
          value={themeName ?? ""} onChange={(event) => { setThemeName(event.currentTarget.value); setNameError(undefined); }} />
        {nameError ? <p className="wapp-error" role="alert">{nameError}</p> : null}
      </form>
    </Modal>
    <ConfirmDialog open={removeOpen} title={`Remove "${selected.name}"?`}
      message="This removes the imported theme from your library."
      confirmLabel="Remove theme" danger onCancel={() => setRemoveOpen(false)}
      onConfirm={() => {
        previewAppearance({
          ...draft,
          selected: "clanky",
          customThemes: draft.customThemes.filter(({ id }) => id !== selected.id),
        });
        setRemoveOpen(false);
      }} />
  </FormSection>;
}
