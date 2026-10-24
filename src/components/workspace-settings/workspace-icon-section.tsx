import { useEffect, useRef, useState } from "react";
import { Button, ConfirmModal, DataList, DataListRow, ErrorState, FormGroup, ResourceImage, SettingsFieldRow } from "@pablozaiden/webapp/web";
import type { WorkspaceIconCandidate, WorkspaceIconCandidatesResponse, WorkspaceIconMetadataResponse } from "@/contracts/schemas";
import type { Workspace } from "@/shared/workspace";
import { apiRequest } from "../../lib/api-client";
import { loadWorkspaceIconCandidate, workspaceIconCandidatePath, type WorkspaceIconChange } from "./workspace-icon-actions";

interface WorkspaceIconSectionProps {
  workspace: Workspace;
  icon: Workspace["workspaceIcon"];
  change: WorkspaceIconChange | null;
  onChange: (change: WorkspaceIconChange | null) => void;
  onLoadingChange: (loading: boolean) => void;
}

function savedIconUrl(workspace: Workspace, icon: WorkspaceIconMetadataResponse): string {
  return `/api/workspaces/${encodeURIComponent(workspace.id)}/icon?updatedAt=${
    encodeURIComponent(icon.updatedAt)
  }`;
}

function candidatePreviewUrl(workspaceId: string, path: string): string {
  return workspaceIconCandidatePath(workspaceId, path);
}

export function WorkspaceIconSection({ workspace, icon, change, onChange, onLoadingChange }: WorkspaceIconSectionProps) {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const discoveryControllerRef = useRef<AbortController | null>(null);
  const selectionControllerRef = useRef<AbortController | null>(null);
  const [showRemoveConfirmation, setShowRemoveConfirmation] = useState(false);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [selectingPath, setSelectingPath] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<WorkspaceIconCandidatesResponse>({
    candidates: [],
    truncated: false,
  });
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const selectedFile = change && change.kind !== "remove" ? change.file : null;

  useEffect(() => {
    if (!selectedFile) {
      setFilePreview(null);
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);

  useEffect(() => {
    setCandidates({ candidates: [], truncated: false });
    setCandidatesLoading(false);
    setHasSearched(false);
    setDiscoveryError(null);
    setSelectionError(null);
    setSelectingPath(null);
    return () => {
      discoveryControllerRef.current?.abort();
      discoveryControllerRef.current = null;
      selectionControllerRef.current?.abort();
      selectionControllerRef.current = null;
      onLoadingChange(false);
    };
  }, [workspace.id, workspace.directory, workspace.executionTargetRevision, onLoadingChange]);

  function stageChange(next: WorkspaceIconChange | null): void {
    setSelectionError(null);
    onChange(next);
  }

  async function selectCandidate(candidate: WorkspaceIconCandidate): Promise<void> {
    selectionControllerRef.current?.abort();
    const controller = new AbortController();
    selectionControllerRef.current = controller;
    setSelectingPath(candidate.path);
    setSelectionError(null);
    onLoadingChange(true);
    try {
      const selected = await loadWorkspaceIconCandidate(workspace.id, candidate, controller.signal);
      if (!controller.signal.aborted && selectionControllerRef.current === controller) {
        onChange(selected);
      }
    } catch (error) {
      if (!controller.signal.aborted && selectionControllerRef.current === controller) {
        setSelectionError(String(error));
      }
    } finally {
      if (selectionControllerRef.current === controller) {
        selectionControllerRef.current = null;
        setSelectingPath(null);
        onLoadingChange(false);
      }
    }
  }

  async function discoverCandidates(): Promise<void> {
    discoveryControllerRef.current?.abort();
    const controller = new AbortController();
    discoveryControllerRef.current = controller;
    setCandidates({ candidates: [], truncated: false });
    setCandidatesLoading(true);
    setHasSearched(true);
    setDiscoveryError(null);
    try {
      const result = await apiRequest<WorkspaceIconCandidatesResponse>(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/icon-candidates`,
        {
          signal: controller.signal,
          action: "Discover workspace icons",
          fallbackMessage: "Unable to discover workspace icons.",
        },
      );
      if (!controller.signal.aborted && discoveryControllerRef.current === controller) {
        setCandidates(result);
      }
    } catch (error) {
      if (!controller.signal.aborted && discoveryControllerRef.current === controller) {
        setDiscoveryError(String(error));
      }
    } finally {
      if (discoveryControllerRef.current === controller) {
        discoveryControllerRef.current = null;
        setCandidatesLoading(false);
      }
    }
  }

  const preview = change?.kind === "remove" ? null
    : selectedFile ? filePreview : icon ? savedIconUrl(workspace, icon) : null;
  const selectedName = change?.kind === "repository" ? change.path : selectedFile?.name;

  return (
    <>
      <SettingsFieldRow title="Icon" description="SVG or ICO, up to 1 MB."
        content={<>
          {preview ? <ResourceImage className="h-8 w-8 shrink-0 rounded object-contain"
            src={preview} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : "Default"}
          <input ref={uploadInputRef} type="file" className="hidden" aria-label="Workspace icon file"
            accept=".svg,.ico,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) stageChange({ kind: "upload", file });
              event.currentTarget.value = "";
            }} />
        </>}
        feedback={selectedName ? <span className="max-w-48 truncate" title={selectedName}>{selectedName}</span> : null}
        actions={<>
          <Button onClick={() => uploadInputRef.current?.click()}>Choose file</Button>
          {workspace.workspaceType === "git" ? <Button aria-label="Search repository icons" loading={candidatesLoading}
            onClick={() => void discoverCandidates()}>{hasSearched ? "Search again" : "Search"}</Button> : null}
          {change ? <Button onClick={() => stageChange(null)}>Undo</Button>
            : icon ? <Button tone="danger" onClick={() => setShowRemoveConfirmation(true)}>Remove</Button> : null}
        </>} />
      {selectionError ? <ErrorState title="Unable to select workspace icon" description={selectionError} /> : null}
      {hasSearched ? <FormGroup title="Repository icons">
        {discoveryError ? (
          <ErrorState title="Unable to discover icons" description={discoveryError} />
        ) : candidatesLoading ? <span role="status">Searching...</span>
        : candidates.candidates.length === 0 ? (
          <span>No SVG or ICO files found.</span>
        ) : (
          <DataList>
            {candidates.candidates.map((candidate) => (
              <DataListRow key={candidate.path} title={<span className="flex min-w-0 items-center gap-3">
                <ResourceImage className="h-8 w-8 shrink-0 rounded object-contain"
                  src={candidatePreviewUrl(workspace.id, candidate.path)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                />
                <span className="break-all">{candidate.path}</span>
              </span>} actions={<Button
                disabled={change?.kind === "repository" && change.path === candidate.path}
                loading={selectingPath === candidate.path}
                onClick={() => void selectCandidate(candidate)}
              >{change?.kind === "repository" && change.path === candidate.path ? "Selected" : "Use icon"}</Button>} />
            ))}
          </DataList>
        )}
        {candidates.truncated ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Showing the first {candidates.candidates.length} matching files.
          </p>
        ) : null}
      </FormGroup> : null}
      <ConfirmModal
        isOpen={showRemoveConfirmation}
        onClose={() => setShowRemoveConfirmation(false)}
        onConfirm={() => {
          stageChange(icon ? { kind: "remove" } : null);
          setShowRemoveConfirmation(false);
        }}
        title="Remove workspace icon"
        message={`Remove the icon for "${workspace.name}" when you save? The workspace will use its default mark.`}
        confirmLabel="Remove icon"
        variant="danger"
      />
    </>
  );
}
