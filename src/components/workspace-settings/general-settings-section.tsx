import { CheckboxField, FormSection, Input, SettingsFieldRow } from "@pablozaiden/webapp/web";
import type { Workspace } from "@/shared";
import { WorkspaceIconSection } from "./workspace-icon-section";
import type { WorkspaceSettingsDraft } from "./use-workspace-settings-draft";

export function GeneralSettingsSection({ workspace, draft, onChange, onIconChanged, formId }: {
  workspace: Workspace;
  draft: WorkspaceSettingsDraft;
  onChange: (change: Partial<WorkspaceSettingsDraft>) => void;
  onIconChanged?: () => Promise<void>;
  formId: string;
}) {
  return (
    <FormSection title="General">
      <SettingsFieldRow title="Name" labelFor={`${formId}-workspace-name`} content={
        <Input id={`${formId}-workspace-name`} fieldWidth="normal" required value={draft.name}
          onChange={(event) => onChange({ name: event.currentTarget.value })} />
      } />
      {onIconChanged ? <WorkspaceIconSection workspace={workspace} onChanged={onIconChanged} /> : null}
      <SettingsFieldRow title="Archived" labelFor={`${formId}-archived`}
        content={<CheckboxField id={`${formId}-archived`} label="" aria-label="Archived workspace"
          checked={draft.archived} onChange={(event) => onChange({ archived: event.currentTarget.checked })} />} />
      <SettingsFieldRow title="Clanky CLI access" labelFor={`${formId}-cli-access`}
        content={<CheckboxField id={`${formId}-cli-access`} label="" aria-label="Allow Clanky CLI access"
          checked={draft.allowClankyContext} onChange={(event) => onChange({ allowClankyContext: event.currentTarget.checked })} />} />
      {workspace.workspaceType === "git" ? (
        <SettingsFieldRow title="Worktrees" labelFor={`${formId}-worktrees`}
          content={<CheckboxField id={`${formId}-worktrees`} label="" aria-label="Allow worktrees"
            checked={draft.allowWorktrees} onChange={(event) => onChange({ allowWorktrees: event.currentTarget.checked })} />} />
      ) : null}
    </FormSection>
  );
}
