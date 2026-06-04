import { useEffect, useMemo, useState } from "react";
import { appFetch } from "../lib/public-path";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface StandaloneChatTranscriptViewerProps {
  chatId: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; markdown: string }
  | { status: "error"; message: string };

export function StandaloneChatTranscriptViewer({ chatId }: StandaloneChatTranscriptViewerProps) {
  const [rawMode, setRawMode] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const transcriptUrl = useMemo(() => `/api/chats/${encodeURIComponent(chatId)}/transcript.md`, [chatId]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadTranscript(): Promise<void> {
      setLoadState({ status: "loading" });
      try {
        const response = await appFetch(transcriptUrl, { signal: controller.signal });
        if (!response.ok) {
          const contentType = response.headers.get("Content-Type") ?? "";
          if (contentType.includes("application/json")) {
            const data = await response.json() as { message?: string; error?: string };
            throw new Error(data.message ?? data.error ?? "Failed to load transcript");
          }
          throw new Error(await response.text() || "Failed to load transcript");
        }
        setLoadState({ status: "loaded", markdown: await response.text() });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setLoadState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }

    void loadTranscript();
    return () => controller.abort();
  }, [transcriptUrl]);

  return (
    <main className="min-h-screen bg-white text-gray-950 dark:bg-neutral-950 dark:text-gray-50 print:bg-white print:text-black">
      <div className="sticky top-0 z-10 border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95 print:hidden">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
          <h1 className="text-sm font-semibold">Markdown transcript</h1>
          <label className="inline-flex items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-300">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-500 dark:border-neutral-700"
              checked={rawMode}
              onChange={(event) => setRawMode(event.target.checked)}
            />
            Raw
          </label>
        </div>
      </div>

      <div className="mx-auto max-w-4xl px-4 py-8 print:max-w-none print:px-0 print:py-0">
        {loadState.status === "loading" && (
          <div className="text-sm text-gray-500 dark:text-gray-400">Loading transcript...</div>
        )}
        {loadState.status === "error" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
            {loadState.message}
          </div>
        )}
        {loadState.status === "loaded" && (
          <MarkdownRenderer
            content={loadState.markdown}
            rawMode={rawMode}
            className="print:prose-base print:max-w-none"
          />
        )}
      </div>
    </main>
  );
}
