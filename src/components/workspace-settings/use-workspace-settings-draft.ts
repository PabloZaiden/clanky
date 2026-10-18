import { useEffect, useState } from "react";
import { useUnsavedChanges } from "@pablozaiden/webapp/web";
import type { Workspace, ServerSettings, ExecutionHostRef } from "@/shared";
import type { WorkspaceSshTargetRequest } from "@/contracts/schemas";

export interface WorkspaceSettingsDraft {
  name: string;
  archived: boolean;
  allowClankyContext: boolean;
  allowWorktrees: boolean;
  settings: ServerSettings;
  executionHost: ExecutionHostRef | null;
  sshTarget: WorkspaceSshTargetRequest | null;
}

function readDraft(workspace: Workspace): WorkspaceSettingsDraft {
  return {
    name: workspace.name,
    archived: workspace.archived === true,
    allowClankyContext: workspace.allowClankyContext === true,
    allowWorktrees: workspace.allowWorktrees !== false,
    settings: workspace.serverSettings,
    executionHost: workspace.sshTarget ? null : workspace.executionHostBinding.host,
    sshTarget: workspace.sshTarget ? {
      host: workspace.sshTarget.host,
      port: workspace.sshTarget.port,
      username: workspace.sshTarget.username,
    } : null,
  };
}

function runtimeSeed(draft: WorkspaceSettingsDraft, credentialConfigured: boolean) {
  return {
    settings: draft.settings,
    executionHost: draft.executionHost,
    sshTarget: draft.sshTarget ? { ...draft.sshTarget, credentialConfigured } : null,
  };
}

export function useWorkspaceSettingsDraft(workspace: Workspace) {
  const [baseline, setBaseline] = useState(() => readDraft(workspace));
  const [draft, setDraft] = useState(baseline);
  const [seed, setSeed] = useState(() => runtimeSeed(baseline, workspace.sshTarget?.credentialConfigured === true));
  const [revision, setRevision] = useState(0);
  const [runtimeValid, setRuntimeValid] = useState(false);
  const incoming = readDraft(workspace);
  const incomingKey = JSON.stringify([incoming, workspace.sshTarget?.credentialConfigured === true]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  function replace(next: WorkspaceSettingsDraft, credentialConfigured: boolean): void {
    setBaseline(next);
    setDraft(next);
    setSeed(runtimeSeed(next, credentialConfigured));
    setRevision((current) => current + 1);
    setRuntimeValid(false);
  }

  function reset(): void {
    replace(incoming, workspace.sshTarget?.credentialConfigured === true);
    releaseGuard();
  }

  const releaseGuard = useUnsavedChanges(dirty, reset);
  useEffect(() => {
    // Rebase only a clean draft when editable server data changes, not on icon refreshes.
    if (!dirty && incomingKey !== JSON.stringify([baseline, seed.sshTarget?.credentialConfigured === true])) {
      replace(incoming, workspace.sshTarget?.credentialConfigured === true);
    }
  }, [incomingKey]);

  function markSaved(submitted: WorkspaceSettingsDraft): void {
    const password = submitted.sshTarget?.password;
    const credentialConfigured = password === null ? false
      : typeof password === "string" && password.length > 0 ? true
        : seed.sshTarget?.credentialConfigured === true;
    const clean = {
      ...submitted,
      name: submitted.name.trim(),
      sshTarget: submitted.sshTarget ? {
        host: submitted.sshTarget.host,
        port: submitted.sshTarget.port,
        username: submitted.sshTarget.username,
      } : null,
    };
    replace(clean, credentialConfigured);
    releaseGuard();
  }

  function patch(change: Partial<WorkspaceSettingsDraft>): void {
    setDraft((current) => ({ ...current, ...change }));
  }

  function updateRuntime(
    settings: ServerSettings,
    valid: boolean,
    executionHost: ExecutionHostRef | null,
    sshTarget?: WorkspaceSshTargetRequest | null,
  ): void {
    patch({ settings, executionHost, sshTarget: sshTarget ?? null });
    setRuntimeValid(valid);
  }

  return { draft, dirty, seed, revision, runtimeValid, patch, updateRuntime, reset, markSaved };
}
