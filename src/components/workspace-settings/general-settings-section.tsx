import { CheckboxField, FormSection, Input, SettingsFieldRow } from "@pablozaiden/webapp/web";
import type { Workspace } from "@/shared";
import { WorkspaceIconSection } from "./workspace-icon-section";
import type { WorkspaceSettingsDraft } from "./use-workspace-settings-draft";
import type { WorkspaceIconChange } from "./workspace-icon-actions";

export function GeneralSettingsSection({ workspace, draft, onChange, icon, iconChange, onIconChange, onIconLoadingChange, formId }: {
  workspace: Workspace;
  draft: WorkspaceSettingsDraft;
  onChange: (change: Partial<WorkspaceSettingsDraft>) => void;
  icon: Workspace["workspaceIcon"];
  iconChange: WorkspaceIconChange | null;
  onIconChange?: (change: WorkspaceIconChange | null) => void;
  onIconLoadingChange: (loading: boolean) => void;
  formId: string;
}) {
  return (
    <FormSection title="General">
      <SettingsFieldRow title="Name" labelFor={`${formId}-workspace-name`} content={
        <Input id={`${formId}-workspace-name`} fieldWidth="normal" required value={draft.name}
          onChange={(event) => onChange({ name: event.currentTarget.value })} />
      } />
      {onIconChange ? <WorkspaceIconSection workspace={workspace} icon={icon}
        change={iconChange} onChange={onIconChange} onLoadingChange={onIconLoadingChange} /> : null}
      <SettingsFieldRow title="Archived" labelFor={`${formId}-archived`}
        content={<CheckboxField id={`${formId}-archived`} label="" aria-label="Archived workspace"
          checked={draft.archived} onChange={(event) => onChange({ archived: event.currentTarget.checked })} />} />
      <SettingsFieldRow title="General Clanky access" labelFor={`${formId}-cli-access`}
        description="Supported native agents and deterministic programs control their own project automatically. Enable general access for cross-project control and administration within your permissions; destructive actions still require human approval. ACP model processes receive no automatic Clanky credentials, even when general access is enabled."
        content={<CheckboxField id={`${formId}-cli-access`} label="" aria-label="Allow general Clanky access"
          checked={draft.allowClankyContext} onChange={(event) => onChange({ allowClankyContext: event.currentTarget.checked })} />} />
      {workspace.workspaceType === "git" ? (
        <SettingsFieldRow title="Worktrees" labelFor={`${formId}-worktrees`}
          content={<CheckboxField id={`${formId}-worktrees`} label="" aria-label="Allow worktrees"
            checked={draft.allowWorktrees} onChange={(event) => onChange({ allowWorktrees: event.currentTarget.checked })} />} />
      ) : null}
    </FormSection>
  );
}
