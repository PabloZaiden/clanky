import { useEffect, useMemo, useRef, useState } from "react";
import {
  ConfirmModal,
  ErrorState,
  LoadingState,
  useToast,
} from "@pablozaiden/webapp/web";
import {
  WORKSPACE_SCRATCHPAD_MAX_LENGTH,
  WORKSPACE_SCRATCHPAD_TOO_LONG_MESSAGE,
  type PublicWorkspace,
} from "@/shared";
import { apiRequest } from "../../lib/api-client";
import {
  createWorkspaceScratchpadDraftPersistence,
  getStoredWorkspaceScratchpadDraft,
} from "../../lib/workspace-scratchpad-drafts";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { Button, PreviewIcon, RefreshIcon, SaveIcon } from "../common";
import { MonacoCodeEditor } from "../MonacoCodeEditor";
import { useWorkspaceReadOnly } from "../../context/workspace-access-context";

interface WorkspaceScratchpadViewProps {
  workspaceId: string;
}

function getWorkspaceApiPath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}`;
}

const scratchpadActionButtonClassName =
  "w-9 px-0 !border-0 aria-pressed:!text-blue-600 dark:aria-pressed:!text-blue-400";

export function WorkspaceScratchpadView({
  workspaceId,
}: WorkspaceScratchpadViewProps) {
  const readOnly = useWorkspaceReadOnly();
  const toast = useToast();
  const [content, setContent] = useState("");
  const [serverContent, setServerContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [confirmReloadOpen, setConfirmReloadOpen] = useState(false);
  const draftPersistence = useMemo(
    () => createWorkspaceScratchpadDraftPersistence(workspaceId),
    [workspaceId],
  );
  const contentRef = useRef("");
  const serverContentRef = useRef<string | null>(null);
  const dirty = serverContent !== null && content !== serverContent;
  const busy = loading || saving;
  const contentTooLong = content.length > WORKSPACE_SCRATCHPAD_MAX_LENGTH;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const flushDraft = () => draftPersistence.flush();
    window.addEventListener("pagehide", flushDraft);
    return () => {
      window.removeEventListener("pagehide", flushDraft);
      draftPersistence.flush();
    };
  }, [draftPersistence]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadWorkspace(): Promise<void> {
      setLoading(true);
      setLoadError(null);
      try {
        const workspace = await apiRequest<PublicWorkspace>(
          getWorkspaceApiPath(workspaceId),
          {
            signal: controller.signal,
            action: "Load workspace Scratchpad",
            fallbackMessage: "Failed to load workspace Scratchpad",
          },
        );
        if (controller.signal.aborted) {
          return;
        }

        const savedContent = workspace.scratchpad;
        const localDraft = getStoredWorkspaceScratchpadDraft(workspaceId);
        const restoredContent = localDraft ?? savedContent;
        serverContentRef.current = savedContent;
        contentRef.current = restoredContent;
        setServerContent(savedContent);
        setContent(restoredContent);
        if (restoredContent === savedContent) {
          draftPersistence.clear();
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setLoadError(String(error));
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void loadWorkspace();
    return () => controller.abort();
  }, [draftPersistence, workspaceId]);

  function handleContentChange(nextContent: string): void {
    contentRef.current = nextContent;
    setContent(nextContent);
    if (nextContent === serverContentRef.current) {
      draftPersistence.clear();
    } else {
      draftPersistence.schedule(nextContent);
    }
  }

  async function reloadFromServer(): Promise<void> {
    setConfirmReloadOpen(false);
    setLoading(true);
    try {
      const workspace = await apiRequest<PublicWorkspace>(
        getWorkspaceApiPath(workspaceId),
        {
          action: "Reload workspace Scratchpad",
          fallbackMessage: "Failed to reload workspace Scratchpad",
        },
      );
      const savedContent = workspace.scratchpad;
      serverContentRef.current = savedContent;
      contentRef.current = savedContent;
      setServerContent(savedContent);
      setContent(savedContent);
      draftPersistence.clear();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
  }

  async function saveToServer(): Promise<void> {
    if (
      readOnly || serverContentRef.current === null
      || contentRef.current === serverContentRef.current
      || busy
      || contentTooLong
    ) {
      return;
    }

    const contentToSave = contentRef.current;
    setSaving(true);
    try {
      const workspace = await apiRequest<PublicWorkspace>(
        getWorkspaceApiPath(workspaceId),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scratchpad: contentToSave }),
          action: "Save workspace Scratchpad",
          fallbackMessage: "Failed to save workspace Scratchpad",
        },
      );
      const savedContent = workspace.scratchpad;
      serverContentRef.current = savedContent;
      contentRef.current = savedContent;
      setServerContent(savedContent);
      setContent(savedContent);
      draftPersistence.clear();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  }

  function requestReload(): void {
    if (dirty) {
      setConfirmReloadOpen(true);
      return;
    }
    void reloadFromServer();
  }

  if (loading && serverContent === null) {
    return <LoadingState title="Loading Scratchpad" />;
  }

  if (loadError) {
    return (
      <ErrorState
        title="Unable to load Scratchpad"
        description={loadError}
      />
    );
  }

  const statusText = loading
    ? "Reloading..."
    : saving
      ? "Saving..."
      : dirty
        ? "Unsaved changes"
        : "Saved";

  return (
    <>
      <section
        aria-label="Workspace Scratchpad"
        className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-900"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
          {contentTooLong ? (
            <p role="alert" className="min-w-0 basis-full text-xs text-red-600 dark:text-red-400">
              {WORKSPACE_SCRATCHPAD_TOO_LONG_MESSAGE}
            </p>
          ) : (
            <p className="min-w-0 flex-1 text-xs text-gray-500 dark:text-gray-400">
              {statusText}
            </p>
          )}
          <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPreview((currentValue) => !currentValue)}
              disabled={busy}
              icon={<PreviewIcon size="h-4 w-4" />}
              aria-label="Markdown preview"
              aria-pressed={preview}
              title={preview ? "Show Markdown code" : "Show Markdown preview"}
              className={scratchpadActionButtonClassName}
            >
              <span className="sr-only">Markdown preview</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={requestReload}
              disabled={busy}
              icon={<RefreshIcon size="h-4 w-4" />}
              aria-label="Reload Scratchpad"
              title="Reload Scratchpad"
              className={scratchpadActionButtonClassName}
            >
              <span className="sr-only">Reload Scratchpad</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void saveToServer()}
              disabled={readOnly || !dirty || busy || contentTooLong}
              loading={saving}
              icon={<SaveIcon size="h-4 w-4" />}
              aria-label="Save Scratchpad"
              title="Save Scratchpad"
              className={scratchpadActionButtonClassName}
            >
              <span className="sr-only">Save Scratchpad</span>
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className={preview ? "hidden" : "h-full"}>
            <MonacoCodeEditor
              height="100%"
              language="markdown"
              value={content}
              onChange={handleContentChange}
              readOnly={readOnly || busy}
              ariaLabel="Workspace Scratchpad Markdown editor"
              onSaveShortcut={() => {
                void saveToServer();
              }}
            />
          </div>
          {preview ? (
            <div
              aria-label="Markdown preview"
              className="h-full min-w-0 overflow-auto px-4 py-3 sm:px-6"
            >
              <MarkdownRenderer content={content} />
            </div>
          ) : null}
        </div>
      </section>
      <ConfirmModal
        isOpen={confirmReloadOpen}
        onClose={() => setConfirmReloadOpen(false)}
        onConfirm={() => void reloadFromServer()}
        title="Discard unsaved changes?"
        message="Reloading replaces the local Scratchpad draft with the content saved on the server."
        confirmLabel="Reload"
        variant="danger"
        loading={loading}
      />
    </>
  );
}
