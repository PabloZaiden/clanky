import { useEffect, useRef, useState } from "react";
import { ConfirmModal, ErrorState, useToast } from "@pablozaiden/webapp/web";
import type {
  WorkspaceIconCandidatesResponse,
  WorkspaceIconMetadataResponse,
  WorkspaceIconResponse,
} from "@/contracts/schemas";
import type { Workspace } from "@/shared/workspace";
import { appPath } from "../../lib/public-path";
import { apiRequest } from "../../lib/api-client";
import { Button } from "../common";

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
    <section className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          {icon ? (
            <img
              className="h-10 w-10 shrink-0 rounded-md border border-gray-200 bg-white object-contain p-1 dark:border-gray-700 dark:bg-neutral-900"
              src={savedIconUrl(workspace, icon)}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
            />
          ) : null}
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Workspace icon</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Optional SVG or ICO image, up to 1 MB.
            </p>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="danger"
          disabled={!icon || saving}
          onClick={() => setShowRemoveConfirmation(true)}
        >
          Remove
        </Button>
      </div>

      {operationError ? (
        <ErrorState title="Workspace icon update failed" description={operationError} />
      ) : null}
      {refreshError ? (
        <ErrorState title="Workspace icon saved" description={refreshError} />
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          ref={uploadInputRef}
          type="file"
          accept=".svg,.ico,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
          onChange={(event) => {
            setSelectedFile(event.currentTarget.files?.[0] ?? null);
            setOperationError(null);
          }}
          className="min-w-0 flex-1 text-sm text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-sm file:font-medium dark:text-gray-300 dark:file:bg-neutral-800"
        />
        <Button
          type="button"
          size="sm"
          loading={saving}
          disabled={!selectedFile}
          onClick={() => void uploadSelectedFile()}
        >
          Upload
        </Button>
      </div>

      <div className="space-y-2 border-t border-gray-200 pt-4 dark:border-gray-700">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">Repository candidates</h4>
          {workspace.workspaceType === "git" ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              aria-label="Search repository icons"
              loading={candidatesLoading}
              disabled={candidatesLoading || saving}
              onClick={() => void discoverCandidates()}
            >
              {hasSearched ? "Search again" : "Search"}
            </Button>
          ) : null}
        </div>
        {workspace.workspaceType !== "git" ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Repository icon search is available for Git workspaces.
          </p>
        ) : candidatesLoading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Searching the repository…</p>
        ) : discoveryError ? (
          <ErrorState title="Unable to discover icons" description={discoveryError} />
        ) : !hasSearched ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Search the repository to find matching SVG and ICO icons.
          </p>
        ) : candidates.candidates.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No SVG or ICO candidates found.</p>
        ) : (
          <div className="space-y-2">
            {candidates.candidates.map((candidate) => (
              <div
                key={candidate.path}
                className="flex min-w-0 flex-col gap-3 rounded-md bg-gray-50 p-2 dark:bg-neutral-900 sm:flex-row sm:items-center"
              >
                <img
                  className="h-10 w-10 shrink-0 rounded border border-gray-200 bg-white object-contain p-1 dark:border-gray-700 dark:bg-neutral-800"
                  src={candidatePreviewUrl(workspace.id, candidate.path)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                />
                <code className="min-w-0 flex-1 break-all text-xs text-gray-700 dark:text-gray-300">
                  {candidate.path}
                </code>
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  disabled={saving}
                  onClick={() => void selectCandidate(candidate.path)}
                >
                  Use icon
                </Button>
              </div>
            ))}
          </div>
        )}
        {candidates.truncated ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Showing the first {candidates.candidates.length} matching files.
          </p>
        ) : null}
      </div>
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
    </section>
  );
}
