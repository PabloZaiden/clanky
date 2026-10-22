import { useEffect, useRef, useState } from "react";
import { Button, ConfirmModal, DataList, DataListRow, ErrorState, FormGroup, SettingsFieldRow } from "@pablozaiden/webapp/web";
import type { WorkspaceIconCandidatesResponse, WorkspaceIconMetadataResponse } from "@/contracts/schemas";
import type { Workspace } from "@/shared/workspace";
import { appPath } from "../../lib/public-path";
import { apiRequest } from "../../lib/api-client";
import type { WorkspaceIconChange } from "./workspace-icon-actions";

interface WorkspaceIconSectionProps {
  workspace: Workspace;
  icon: Workspace["workspaceIcon"];
  change: WorkspaceIconChange | null;
  onChange: (change: WorkspaceIconChange | null) => void;
}

function savedIconUrl(workspace: Workspace, icon: WorkspaceIconMetadataResponse): string {
  return appPath(
    `/api/workspaces/${encodeURIComponent(workspace.id)}/icon?updatedAt=${
      encodeURIComponent(icon.updatedAt)
    }`,
  );
}

function candidatePreviewUrl(workspaceId: string, path: string): string {
  return appPath(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/icon-candidate-preview?path=${
      encodeURIComponent(path)
    }`,
  );
}

export function WorkspaceIconSection({ workspace, icon, change, onChange }: WorkspaceIconSectionProps) {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const discoveryControllerRef = useRef<AbortController | null>(null);
  const [showRemoveConfirmation, setShowRemoveConfirmation] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<WorkspaceIconCandidatesResponse>({
    candidates: [],
    truncated: false,
  });
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const selectedFile = change?.kind === "upload" ? change.file : null;

  useEffect(() => {
    if (!selectedFile) {
      setUploadPreview(null);
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    setUploadPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);

  useEffect(() => {
    setCandidates({ candidates: [], truncated: false });
    setCandidatesLoading(false);
    setHasSearched(false);
    setDiscoveryError(null);
    return () => {
      discoveryControllerRef.current?.abort();
      discoveryControllerRef.current = null;
    };
  }, [workspace.id]);

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
    : change?.kind === "repository" ? candidatePreviewUrl(workspace.id, change.path)
      : selectedFile ? uploadPreview : icon ? savedIconUrl(workspace, icon) : null;
  const selectedName = selectedFile?.name ?? (change?.kind === "repository" ? change.path : null);

  return (
    <>
      <SettingsFieldRow title="Icon" description="SVG or ICO, up to 1 MB."
        content={<>
          {preview ? <img className="h-8 w-8 shrink-0 rounded object-contain"
            src={preview} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : "Default"}
          <input ref={uploadInputRef} type="file" className="hidden" aria-label="Workspace icon file"
            accept=".svg,.ico,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) onChange({ kind: "upload", file });
              event.currentTarget.value = "";
            }} />
        </>}
        feedback={selectedName ? <span className="max-w-48 truncate" title={selectedName}>{selectedName}</span> : null}
        actions={<>
          <Button onClick={() => uploadInputRef.current?.click()}>Choose file</Button>
          {workspace.workspaceType === "git" ? <Button aria-label="Search repository icons" loading={candidatesLoading}
            onClick={() => void discoverCandidates()}>{hasSearched ? "Search again" : "Search"}</Button> : null}
          {change ? <Button onClick={() => onChange(null)}>Undo</Button>
            : icon ? <Button tone="danger" onClick={() => setShowRemoveConfirmation(true)}>Remove</Button> : null}
        </>} />
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
                <img className="h-8 w-8 shrink-0 rounded object-contain"
                  src={candidatePreviewUrl(workspace.id, candidate.path)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                />
                <span className="break-all">{candidate.path}</span>
              </span>} actions={<Button
                disabled={change?.kind === "repository" && change.path === candidate.path}
                onClick={() => onChange({ kind: "repository", path: candidate.path })}
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
          onChange(icon ? { kind: "remove" } : null);
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
