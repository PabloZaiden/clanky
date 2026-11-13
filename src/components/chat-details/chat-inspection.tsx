import { useCallback, useEffect, useState } from "react";
import { ErrorState, LoadingState, Page, useLiveQuery } from "@pablozaiden/webapp/web";
import type { FileContentResponse, FileDiff, FileDiffContent } from "@/contracts";
import { readApiResponse, requestApiResponse } from "../../lib/api-client";
import { SNAPSHOT_REQUEST_TIMEOUT_MS } from "../../lib/request-lifecycle";
import { useDocumentVisibility, useRefreshOnForeground } from "../../hooks/useDocumentVisibility";
import { useMarkdownPreference } from "../../hooks/useMarkdownPreference";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { DiffView } from "../common/diff-view";
import { DiffPatchViewer } from "../common/diff-patch-viewer";

function useChatInspection<T>(
  chatId: string,
  file: string,
  visible: boolean,
  active: boolean,
  options: { read?: (response: Response) => Promise<T>; enabled?: boolean } = {},
) {
  const foreground = useDocumentVisibility();
  const query = useLiveQuery<T>({
    load: async (signal) => {
      const response = await requestApiResponse(`/api/chats/${encodeURIComponent(chatId)}/${file}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(SNAPSHOT_REQUEST_TIMEOUT_MS)]),
        action: `Read chat ${file}`,
      });
      return options.read ? options.read(response) : readApiResponse<T>(response);
    },
    enabled: options.enabled,
    deps: [chatId, file],
    realtime: { resources: ["chats"], targets: { chatId } },
  });
  const refresh = query.refresh;
  useRefreshOnForeground(refresh);
  useEffect(() => {
    if (!visible || !foreground) return;
    void refresh();
    if (!active) return;
    const timer = setInterval(() => { void refresh(); }, 4_000);
    return () => clearInterval(timer);
  }, [active, foreground, refresh, visible]);
  return query;
}

function PlanningDocument({ chatId, file, visible, active }: {
  chatId: string;
  file: "plan" | "status-file";
  visible: boolean;
  active: boolean;
}) {
  const query = useChatInspection<FileContentResponse>(chatId, file, visible, active);
  const { enabled: markdownEnabled } = useMarkdownPreference();
  const filename = file === "plan" ? "plan.md" : "status.md";
  return (
    <>
      {query.error ? <ErrorState title={`Unable to read ${filename}`} description={String(query.error)} /> : null}
      {query.data ? (
        query.data.exists
          ? <MarkdownRenderer content={query.data.content} rawMode={!markdownEnabled} className="min-w-0 rounded-lg bg-gray-50 p-4 dark:bg-neutral-900" />
          : <p className="py-6 text-sm text-gray-500 dark:text-gray-400">No {filename} file found in .clanky-planning.</p>
      ) : query.loading ? <LoadingState title={`Loading ${filename}`} /> : null}
    </>
  );
}

interface ChatInspectionProps {
  chatId: string;
  visible: boolean;
  active: boolean;
}

export function ChatPlanView(props: ChatInspectionProps) {
  return (
    <Page>
      <div className="min-w-0 space-y-4">
        <section aria-label="Plan">
          <PlanningDocument {...props} file="plan" />
        </section>
        <section aria-label="Status" className="border-t border-gray-200 pt-4 dark:border-gray-700">
          <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">Status</h2>
          <PlanningDocument {...props} file="status-file" />
        </section>
      </div>
    </Page>
  );
}

function ChatDiffPatch({ chatId, base, path, visible, active, cacheKey, previous, onLoaded }: {
  chatId: string; base: string; path: string; visible: boolean; active: boolean;
  cacheKey: string; previous?: FileDiffContent;
  onLoaded: (key: string, file: FileDiffContent) => void;
}) {
  const query = useChatInspection<FileDiffContent>(chatId,
    `diff/file?${new URLSearchParams({ base, path })}`, visible, active, { enabled: visible });
  useEffect(() => {
    if (query.data) onLoaded(cacheKey, query.data);
  }, [cacheKey, onLoaded, query.data]);
  const content = query.data ?? previous;
  return (
    <>
      {query.error ? <ErrorState title="Unable to read this file's changes" description={String(query.error)} /> : null}
      {content
        ? content.patch
          ? <DiffPatchViewer patch={content.patch} />
          : <p className="p-3 text-gray-500">No textual changes.</p>
        : query.loading ? <LoadingState title="Loading file changes" /> : null}
    </>
  );
}

export function ChatDiffView(props: ChatInspectionProps) {
  const query = useChatInspection(props.chatId, "diff", props.visible, props.active, { read: async (response) => ({
    files: await readApiResponse<FileDiff[]>(response),
    baseCommit: response.headers.get("X-Clanky-Diff-Base"),
  }) });
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => new Set());
  const [contents, setContents] = useState<Record<string, FileDiffContent>>({});
  const onLoaded = useCallback((key: string, file: FileDiffContent) => {
    setContents((current) => ({ ...current, [key]: file }));
  }, []);
  const keyFor = (file: FileDiff) => JSON.stringify([props.chatId, query.data?.baseCommit, file.path]);
  return (
    <Page>
      {query.error ? <ErrorState title="Unable to read changes" description={String(query.error)} /> : null}
      {query.data || query.loading ? <DiffView
        diffContent={query.data?.files.map((file) => {
          const cached = contents[keyFor(file)];
          return cached && file.additions === null
            ? { ...file, additions: cached.additions, deletions: cached.deletions }
            : file;
        }) ?? []}
        loadingContent={query.loading}
        expandedFiles={expandedFiles}
        onExpandedFilesChange={setExpandedFiles}
        renderPatch={(file) => query.data?.baseCommit ? <ChatDiffPatch
          key={keyFor(file)} chatId={props.chatId} base={query.data.baseCommit} path={file.path}
          visible={props.visible} active={props.active} cacheKey={keyFor(file)}
          previous={contents[keyFor(file)]} onLoaded={onLoaded}
        /> : <ErrorState title="Comparison base unavailable" description="Refresh the change list before opening a file." />}
      /> : null}
    </Page>
  );
}
