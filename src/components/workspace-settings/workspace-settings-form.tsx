/**
 * Categorized workspace settings with one guarded, explicitly saved draft.
 */

import { useEffect, useRef, useState, type FormEvent, type InvalidEvent } from "react";
import {
  CodeValue, ErrorState, FormSection, SettingsFieldRow, SettingsLayout,
  useHeaderActions, useToast, type SettingsCategory,
} from "@pablozaiden/webapp/web";
import { ServerSettingsForm } from "../server-settings-form";
import { PurgeTasksSection } from "./purge-tasks-section";
import { DeleteWorkspaceSection } from "./delete-workspace-section";
import { GeneralSettingsSection } from "./general-settings-section";
import { useWorkspaceSettingsDraft } from "./use-workspace-settings-draft";
import { saveWorkspaceIcon } from "./workspace-icon-actions";
import type { WorkspaceSettingsFormProps } from "./types";

const CATEGORIES: SettingsCategory[] = [
  { id: "general", title: "General" },
  { id: "execution", title: "Execution" },
  { id: "maintenance", title: "Maintenance" },
];

export function WorkspaceSettingsForm({
  workspace, status, onSave, onWorkspaceIconChanged, onTest, onPurgeArchivedTasks,
  onDeleteWorkspace, purgeableTaskCount = 0, workspaceTaskCount = 0,
  saving = false, testing = false, purgingPurgeableTasks = false, remoteOnly = false,
  formId = "workspace-settings-form", onDeleted,
}: WorkspaceSettingsFormProps) {
  const toast = useToast();
  const model = useWorkspaceSettingsDraft(workspace);
  const [category, setCategory] = useState("general");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [iconError, setIconError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selectingIcon, setSelectingIcon] = useState(false);
  const busy = saving || submitting || selectingIcon;
  const invalidField = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>(null);
  const validationFrame = useRef<number | null>(null);
  const reportingValidity = useRef(false);

  useHeaderActions({
    primary: [
      { id: "save-workspace", label: "Save", form: formId, loading: busy, disabled: !model.dirty || busy },
    ],
  });

  useEffect(() => () => {
    if (validationFrame.current !== null) cancelAnimationFrame(validationFrame.current);
  }, []);

  function showInvalidField(event: InvalidEvent<HTMLFormElement>): void {
    const field = event.target;
    if (reportingValidity.current) return;
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) return;
    event.preventDefault();
    if (invalidField.current) return;
    invalidField.current = field;
    const section = field.closest<HTMLElement>("[data-workspace-settings-category]");
    if (section?.hidden) setCategory(section.dataset["workspaceSettingsCategory"]!);
    // Finish the native validation sweep before focusing its first invalid field.
    validationFrame.current = requestAnimationFrame(() => {
      validationFrame.current = null;
      invalidField.current = null;
      if (field.isConnected) {
        reportingValidity.current = true;
        try {
          field.focus();
          field.reportValidity();
        } finally {
          reportingValidity.current = false;
        }
      }
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (!model.draft.name.trim()) {
      setCategory("general");
      setValidationError("Enter a workspace name.");
      return;
    }
    if (model.settingsDirty && !model.runtimeValid) {
      setCategory("execution");
      setValidationError("Select an available execution host and supported runtime.");
      return;
    }
    setValidationError(null);
    setIconError(null);
    setRefreshError(null);
    const submitted = model.draft;
    const submittedIcon = model.iconChange;
    setSubmitting(true);
    try {
      if (model.settingsDirty) {
        const success = await onSave(
          submitted.name.trim(), submitted.settings, submitted.executionHost,
          submitted.archived, submitted.allowClankyContext, submitted.allowWorktrees,
        );
        if (!success) return;
        model.markSaved(submitted);
      }
      if (submittedIcon) {
        try {
          model.markIconSaved(await saveWorkspaceIcon(workspace.id, submittedIcon));
        } catch (error) {
          setCategory("general");
          setIconError(String(error));
          return;
        }
        try {
          await onWorkspaceIconChanged?.();
        } catch (error) {
          setRefreshError(`The icon was saved, but workspace views could not refresh: ${String(error)}`);
          return;
        }
      }
      toast.success("Workspace saved.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SettingsLayout categories={CATEGORIES} category={category} onCategoryChange={setCategory}>
      {validationError ? <ErrorState title="Check workspace settings" description={validationError} /> : null}
      {iconError ? <ErrorState title="Workspace icon update failed" description={iconError} /> : null}
      {refreshError ? <ErrorState title="Workspace icon saved" description={refreshError} /> : null}
      <form id={formId} noValidate={!model.settingsDirty}
        onSubmit={(event) => void handleSubmit(event)} onInvalidCapture={showInvalidField}>
        <fieldset disabled={busy} className="min-w-0">
          <div hidden={category !== "general"} data-workspace-settings-category="general">
            <GeneralSettingsSection workspace={workspace} draft={model.draft} onChange={model.patch}
              icon={model.icon} iconChange={model.iconChange}
              onIconLoadingChange={setSelectingIcon}
              onIconChange={onWorkspaceIconChanged ? (change) => {
                model.setIconChange(change);
                setIconError(null);
              } : undefined} formId={formId} />
          </div>
          <div hidden={category !== "execution"} data-workspace-settings-category="execution">
            <FormSection title="Execution">
              <ServerSettingsForm key={model.revision}
                workspaceId={workspace.id}
                initialSettings={model.seed.settings} initialExecutionHost={model.seed.executionHost}
                onChange={model.updateRuntime} onTest={onTest} testing={testing} remoteOnly={workspace.access === "admin" ? false : remoteOnly} />
              <SettingsFieldRow title="Initial directory" content={<CodeValue value={workspace.directory} />} />
              {status?.error ? <ErrorState title="Connection unavailable" description={status.error} /> : null}
            </FormSection>
          </div>
        </fieldset>
      </form>
      <div hidden={category !== "maintenance"}>
        <FormSection title="Maintenance">
          {onPurgeArchivedTasks ? <PurgeTasksSection workspace={workspace}
            onPurgeArchivedTasks={onPurgeArchivedTasks} purgeableTaskCount={purgeableTaskCount}
            purgingPurgeableTasks={purgingPurgeableTasks} /> : null}
          {onDeleteWorkspace ? <DeleteWorkspaceSection workspace={workspace} onDeleteWorkspace={onDeleteWorkspace}
            workspaceTaskCount={workspaceTaskCount} saving={busy} onDeleted={() => {
              model.reset();
              onDeleted?.();
            }} /> : null}
        </FormSection>
      </div>
    </SettingsLayout>
  );
}
