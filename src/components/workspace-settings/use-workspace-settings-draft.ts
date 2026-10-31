import { useEffect, useState } from "react";
import { useUnsavedChanges } from "@pablozaiden/webapp/web";
import type { Workspace, ServerSettings, ExecutionHostRef } from "@/shared";
import type { WorkspaceIconChange } from "./workspace-icon-actions";

export interface WorkspaceSettingsDraft {
  name: string;
  archived: boolean;
  allowClankyContext: boolean;
  allowWorktrees: boolean;
  settings: ServerSettings;
  executionHost: ExecutionHostRef | null;
}

function readDraft(workspace: Workspace): WorkspaceSettingsDraft {
  return {
    name: workspace.name,
    archived: workspace.archived === true,
    allowClankyContext: workspace.allowClankyContext === true,
    allowWorktrees: workspace.allowWorktrees !== false,
    settings: workspace.serverSettings,
    executionHost: workspace.executionHostBinding.host,
  };
}

function runtimeSeed(draft: WorkspaceSettingsDraft) {
  return {
    settings: draft.settings,
    executionHost: draft.executionHost,
  };
}

export function useWorkspaceSettingsDraft(workspace: Workspace) {
  const [baseline, setBaseline] = useState(() => readDraft(workspace));
  const [draft, setDraft] = useState(baseline);
  const [seed, setSeed] = useState(() => runtimeSeed(baseline));
  const [revision, setRevision] = useState(0);
  const [runtimeValid, setRuntimeValid] = useState(false);
  const [icon, setIcon] = useState(workspace.workspaceIcon);
  const [iconChange, setIconChange] = useState<WorkspaceIconChange | null>(null);
  const incoming = readDraft(workspace);
  const incomingKey = JSON.stringify(incoming);
  const settingsDirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const dirty = settingsDirty || iconChange !== null;

  function replace(next: WorkspaceSettingsDraft): void {
    setBaseline(next);
    setDraft(next);
    setSeed(runtimeSeed(next));
    setRevision((current) => current + 1);
    setRuntimeValid(false);
  }

  function reset(): void {
    replace(incoming);
    setIconChange(null);
    releaseGuard();
  }

  const releaseGuard = useUnsavedChanges(dirty, reset);
  useEffect(() => {
    // Rebase only clean settings without discarding a pending icon change.
    if (!settingsDirty && incomingKey !== JSON.stringify(baseline)) {
      replace(incoming);
    }
  }, [incomingKey]);

  useEffect(() => {
    setIcon(workspace.workspaceIcon);
  }, [workspace.workspaceIcon]);

  function markIconSaved(savedIcon: Workspace["workspaceIcon"]): void {
    setIcon(savedIcon);
    setIconChange(null);
  }

  function markSaved(submitted: WorkspaceSettingsDraft): void {
    const clean = {
      ...submitted,
      name: submitted.name.trim(),
    };
    replace(clean);
    if (!iconChange) releaseGuard();
  }

  function patch(change: Partial<WorkspaceSettingsDraft>): void {
    setDraft((current) => ({ ...current, ...change }));
  }

  function updateRuntime(
    settings: ServerSettings,
    valid: boolean,
    executionHost: ExecutionHostRef | null,
  ): void {
    patch({ settings, executionHost });
    setRuntimeValid(valid);
  }

  return {
    draft, dirty, settingsDirty, seed, revision, runtimeValid, patch, updateRuntime, reset, markSaved,
    icon, iconChange, setIconChange, markIconSaved,
  };
}
