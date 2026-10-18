import { useEffect, useRef, useState } from "react";
import { Button, ConfirmModal, DataList, DataListRow, ErrorState, FormGroup, SettingsFieldRow, useToast } from "@pablozaiden/webapp/web";
import type {
  WorkspaceIconCandidatesResponse,
  WorkspaceIconMetadataResponse,
  WorkspaceIconResponse,
} from "@/contracts/schemas";
import type { Workspace } from "@/shared/workspace";
import { appPath } from "../../lib/public-path";
import { apiRequest } from "../../lib/api-client";

interface WorkspaceIconSectionProps {
  workspace: Workspace;
  onChanged: () => Promise<void>;
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

export function WorkspaceIconSection({ workspace, onChanged }: WorkspaceIconSectionProps) {
  const toast = useToast();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const discoveryControllerRef = useRef<AbortController | null>(null);
  const [icon, setIcon] = useState<WorkspaceIconMetadataResponse | undefined>(workspace.workspaceIcon);
  const [showRemoveConfirmation, setShowRemoveConfirmation] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [candidates, setCandidates] = useState<WorkspaceIconCandidatesResponse>({
    candidates: [],
    truncated: false,
  });
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setIcon(workspace.workspaceIcon);
    setShowRemoveConfirmation(false);
    setSelectedFile(null);
    setOperationError(null);
    setRefreshError(null);
  }, [workspace.id, workspace.workspaceIcon]);

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

  async function refreshWorkspaceViews(): Promise<void> {
    setRefreshError(null);
    try {
      await onChanged();
    } catch (error) {
      setRefreshError(`The icon changed, but workspace views could not refresh: ${String(error)}`);
    }
  }

  async function uploadSelectedFile(): Promise<void> {
    if (!selectedFile) {
      setOperationError("Choose an SVG or ICO file first.");
      return;
    }
    setSaving(true);
    setOperationError(null);
    setRefreshError(null);
    try {
      const body = new FormData();
      body.append("icon", selectedFile);
      const result = await apiRequest<WorkspaceIconResponse>(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/icon-upload`,
        {
          method: "POST",
          body,
          action: "Upload workspace icon",
          fallbackMessage: "Unable to upload workspace icon.",
        },
      );
      setIcon(result.workspaceIcon);
      setSelectedFile(null);
      if (uploadInputRef.current) {
        uploadInputRef.current.value = "";
      }
      toast.success("Workspace icon updated.");
      await refreshWorkspaceViews();
    } catch (error) {
      setOperationError(String(error));
    } finally {
      setSaving(false);
    }
  }

  async function selectCandidate(path: string): Promise<void> {
    setSaving(true);
    setOperationError(null);
    setRefreshError(null);
    try {
      const result = await apiRequest<WorkspaceIconResponse>(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/icon`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
          action: "Select workspace icon",
          fallbackMessage: "Unable to select workspace icon.",
        },
      );
      setIcon(result.workspaceIcon);
      toast.success("Workspace icon updated.");
      await refreshWorkspaceViews();
    } catch (error) {
      setOperationError(String(error));
    } finally {
      setSaving(false);
    }
  }

  async function removeIcon(): Promise<void> {
    setSaving(true);
    setOperationError(null);
    setRefreshError(null);
    try {
      await apiRequest(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/icon`,
        {
          method: "DELETE",
          action: "Remove workspace icon",
          fallbackMessage: "Unable to remove workspace icon.",
        },
      );
      setIcon(undefined);
      toast.success("Workspace icon removed.");
      await refreshWorkspaceViews();
    } catch (error) {
      setOperationError(String(error));
    } finally {
      setShowRemoveConfirmation(false);
      setSaving(false);
    }
  }

  return (
    <>
      <SettingsFieldRow title="Icon" description="SVG or ICO, up to 1 MB."
        content={<>
          {icon ? <img className="h-8 w-8 shrink-0 rounded object-contain"
            src={savedIconUrl(workspace, icon)} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : "Default"}
          <input ref={uploadInputRef} type="file" className="hidden" aria-label="Workspace icon file"
            accept=".svg,.ico,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
            onChange={(event) => { setSelectedFile(event.currentTarget.files?.[0] ?? null); setOperationError(null); }} />
        </>}
        feedback={selectedFile ? <span className="max-w-48 truncate" title={selectedFile.name}>{selectedFile.name}</span> : null}
        actions={<>
          <Button disabled={saving} onClick={() => uploadInputRef.current?.click()}>Choose file</Button>
          {selectedFile ? <Button loading={saving} onClick={() => void uploadSelectedFile()}>Upload</Button> : null}
          {workspace.workspaceType === "git" ? <Button aria-label="Search repository icons" loading={candidatesLoading}
            disabled={saving} onClick={() => void discoverCandidates()}>{hasSearched ? "Search again" : "Search"}</Button> : null}
          {icon ? <Button tone="danger" disabled={saving} onClick={() => setShowRemoveConfirmation(true)}>Remove</Button> : null}
        </>} />
      {operationError ? (
        <ErrorState title="Workspace icon update failed" description={operationError} />
      ) : null}
      {refreshError ? (
        <ErrorState title="Workspace icon saved" description={refreshError} />
      ) : null}

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
              </span>} actions={<Button disabled={saving} onClick={() => void selectCandidate(candidate.path)}>Use icon</Button>} />
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
        onConfirm={removeIcon}
        title="Remove workspace icon"
        message={`Remove the saved icon for "${workspace.name}"? The workspace will use its default mark.`}
        confirmLabel="Remove icon"
        loading={saving}
        variant="danger"
      />
    </>
  );
}
