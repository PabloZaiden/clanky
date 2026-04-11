import { useState } from "react";
import type { Loop, Workspace } from "../../types";
import { appFetch } from "../../lib/public-path";
import { useDashboardData, useToast } from "../../hooks";
import { createLogger } from "../../lib/logger";
import {
  CreateLoopForm,
  getComposeDraftActionLabel,
  getComposeSubmitActionLabel,
  type CreateLoopFormActionState,
  type CreateLoopFormSubmitRequest,
} from "../CreateLoopForm";
import { Button, ConfirmModal } from "../common";
import type { ShellRoute } from "./shell-types";
import { ShellPanel } from "./shell-panel";
import type { CreateLoopRequest } from "../../types";
import { stripTransientAttachments } from "../../lib/image-attachments";

const log = createLogger("DraftLoopComposer");

export function DraftLoopComposer({
  loop,
  workspaces,
  models,
  modelsLoading,
  lastModel,
  lastCheapModel,
  setLastModel,
  setLastCheapModel,
  onWorkspaceChange,
  planningWarning,
  branches,
  branchesLoading,
  currentBranch,
  defaultBranch,
  workspaceError,
  workspacesLoading,
  headerOffsetClassName,
  onRefresh,
  onDeleteDraft,
  onNavigate,
}: {
  loop: Loop;
  workspaces: Workspace[];
  models: ReturnType<typeof useDashboardData>["models"];
  modelsLoading: boolean;
  lastModel: ReturnType<typeof useDashboardData>["lastModel"];
  lastCheapModel: ReturnType<typeof useDashboardData>["lastCheapModel"];
  setLastModel: ReturnType<typeof useDashboardData>["setLastModel"];
  setLastCheapModel: ReturnType<typeof useDashboardData>["setLastCheapModel"];
  onWorkspaceChange: ReturnType<typeof useDashboardData>["handleWorkspaceChange"];
  planningWarning: string | null;
  branches: ReturnType<typeof useDashboardData>["branches"];
  branchesLoading: boolean;
  currentBranch: string;
  defaultBranch: string;
  workspaceError: string | null;
  workspacesLoading: boolean;
  headerOffsetClassName?: string;
  onRefresh: () => Promise<void>;
  onDeleteDraft: (id: string) => Promise<boolean>;
  onNavigate: (route: ShellRoute) => void;
}) {
  const toast = useToast();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [startConflict, setStartConflict] = useState<{ message: string; changedFiles: string[] } | null>(null);
  const [actionState, setActionState] = useState<CreateLoopFormActionState | null>(null);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === loop.config.workspaceId) ?? null;
  const exitRoute = selectedWorkspace
    ? { view: "workspace", workspaceId: selectedWorkspace.id } satisfies ShellRoute
    : { view: "home" } satisfies ShellRoute;

  function handleCancel() {
    setStartConflict(null);
    setDeleteConfirmOpen(false);
    onNavigate(exitRoute);
  }

  async function persistLoopPreferences(request: CreateLoopRequest): Promise<void> {
    const operations: Promise<Response>[] = [
      appFetch("/api/preferences/last-model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.model),
      }),
    ];

    if (request.cheapModel) {
      operations.push(
        appFetch("/api/preferences/last-cheap-model", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request.cheapModel),
        }),
      );
    }

    const workspace = workspaces.find((item) => item.id === request.workspaceId);
    if (workspace) {
      operations.push(
        appFetch("/api/preferences/last-directory", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ directory: workspace.directory }),
        }),
      );
    }

    await Promise.all(operations);
  }

  async function persistDraftChanges(request: CreateLoopRequest): Promise<boolean> {
    try {
      const response = await appFetch(`/api/loops/${loop.config.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stripTransientAttachments(request)),
      });

      if (!response.ok) {
        const error = await response.json() as { message?: string };
        toast.error(error.message || "Failed to update draft");
        return false;
      }

      setLastModel(request.model);
      setLastCheapModel(request.cheapModel ?? null);
      try {
        await persistLoopPreferences(request);
      } catch (error) {
        log.error("Failed to persist loop preferences after draft update:", error);
      }
      await onRefresh();
      return true;
    } catch (error) {
      toast.error(String(error));
      return false;
    }
  }

  async function handleDraftSubmit(request: CreateLoopFormSubmitRequest): Promise<boolean> {
    if (!("name" in request)) {
      toast.error("Draft loops currently support loop mode only.");
      return false;
    }

    setStartConflict(null);
    const persisted = await persistDraftChanges(request);
    if (!persisted) {
      return false;
    }

    if (request.draft) {
      return true;
    }

    try {
      const response = await appFetch(`/api/loops/${loop.config.id}/draft/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planMode: request.planMode ?? false,
          attachments: request.attachments,
        }),
      });

      if (response.status === 409) {
        const error = await response.json() as { error?: string; message?: string; changedFiles?: string[] };
        if (error.error === "uncommitted_changes") {
          setStartConflict({
            message: error.message || "Directory has uncommitted changes.",
            changedFiles: error.changedFiles ?? [],
          });
          return false;
        }
      }

      if (!response.ok) {
        const error = await response.json() as { message?: string };
        toast.error(error.message || "Failed to start loop");
        return false;
      }

      await onRefresh();
      return true;
    } catch (error) {
      toast.error(String(error));
      return false;
    }
  }

  async function handleDeleteDraft() {
    setDeleteSubmitting(true);
    try {
      const deleted = await onDeleteDraft(loop.config.id);
      if (!deleted) {
        toast.error("Failed to delete draft");
        return;
      }
      onNavigate(exitRoute);
    } finally {
      setDeleteSubmitting(false);
    }
  }

  return (
    <ShellPanel
      eyebrow="Draft loop"
      title={`Edit ${loop.config.name}`}
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
      actions={(
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={actionState?.onCancel ?? handleCancel}
            disabled={deleteSubmitting || actionState?.isSubmitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={() => setDeleteConfirmOpen(true)}
            disabled={deleteSubmitting || actionState?.isSubmitting}
          >
            Delete
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={actionState?.onSaveAsDraft}
            disabled={deleteSubmitting || !actionState?.canSaveDraft}
            loading={actionState?.isSubmitting ?? false}
          >
            {getComposeDraftActionLabel(true)}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={actionState?.onSubmit}
            disabled={deleteSubmitting || !actionState?.canSubmit}
            loading={actionState?.isSubmitting ?? false}
          >
            {getComposeSubmitActionLabel({
              isEditing: true,
            })}
          </Button>
        </>
      )}
    >
      {startConflict && (
        <div className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-4 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="font-semibold">Cannot Start Loop</p>
          <p className="mt-1">{startConflict.message}</p>
          {startConflict.changedFiles.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-800 dark:text-amber-200">
              {startConflict.changedFiles.map((filePath) => (
                <li key={filePath}>{filePath}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <CreateLoopForm
        onSubmit={handleDraftSubmit}
        onCancel={handleCancel}
        closeOnSuccess={false}
        models={models}
        modelsLoading={modelsLoading}
        lastModel={lastModel}
        lastCheapModel={lastCheapModel}
        onWorkspaceChange={onWorkspaceChange}
        planningWarning={planningWarning}
        branches={branches}
        branchesLoading={branchesLoading}
        currentBranch={currentBranch}
        defaultBranch={defaultBranch}
        editLoopId={loop.config.id}
        initialLoopData={{
           name: loop.config.name,
           directory: loop.config.directory,
           prompt: loop.config.prompt,
           model: loop.config.model,
           cheapModel: loop.config.cheapModel,
           maxIterations: Number.isFinite(loop.config.maxIterations) ? loop.config.maxIterations : undefined,
          maxConsecutiveErrors: loop.config.maxConsecutiveErrors,
          activityTimeoutSeconds: loop.config.activityTimeoutSeconds,
          baseBranch: loop.config.baseBranch,
          useWorktree: loop.config.useWorktree,
           clearPlanningFolder: loop.config.clearPlanningFolder,
           planMode: loop.config.planMode,
           autoAcceptPlan: loop.config.autoAcceptPlan,
            workspaceId: loop.config.workspaceId,
          }}
        isEditingDraft
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        workspaceError={workspaceError}
        renderActions={setActionState}
      />

      <ConfirmModal
        isOpen={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={() => void handleDeleteDraft()}
        title="Delete Draft"
        message={`Are you sure you want to delete "${loop.config.name}"?`}
        confirmLabel="Delete Draft"
        loading={deleteSubmitting}
        variant="danger"
      />
    </ShellPanel>
  );
}
