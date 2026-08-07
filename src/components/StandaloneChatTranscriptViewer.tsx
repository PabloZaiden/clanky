import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../lib/api-client";

interface StandaloneChatTranscriptViewerProps {
  chatId: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; markdown: string }
  | { status: "error"; message: string };

function getTitleFromMarkdown(markdown: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || "Chat transcript";
}

export function StandaloneChatTranscriptViewer({ chatId }: StandaloneChatTranscriptViewerProps) {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const transcriptUrl = useMemo(() => `/api/chats/${encodeURIComponent(chatId)}/transcript.md`, [chatId]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadTranscript(): Promise<void> {
      setLoadState({ status: "loading" });
      try {
        const markdown = await apiRequest(transcriptUrl, {
          signal: controller.signal,
          responseType: "text",
          action: "Load chat transcript",
          fallbackMessage: "Failed to load transcript",
        });
        setLoadState({ status: "loaded", markdown });
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

  useEffect(() => {
    if (loadState.status === "loaded") {
      document.title = getTitleFromMarkdown(loadState.markdown);
      return;
    }

    document.title = "Chat transcript";
  }, [loadState]);

  return (
    <main
      className="standalone-transcript-viewer flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden bg-white px-4 py-6 font-sans text-gray-900 dark:bg-neutral-950 dark:text-gray-100 sm:px-8 sm:py-8"
    >
      <style>
        {`
          .standalone-transcript-page,
          .standalone-transcript-viewer {
            min-width: 0;
          }

          .standalone-transcript-viewer .transcript-content {
            width: 100%;
            max-width: 64rem;
            margin: 0 auto;
            overflow-wrap: anywhere;
          }

          .standalone-transcript-viewer .transcript-content pre {
            margin: 0;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
          }

          @media print {
            .standalone-transcript-page,
            .standalone-transcript-viewer {
              min-height: auto !important;
              overflow: visible !important;
            }

            .standalone-transcript-viewer {
              padding: 0 !important;
              background: #fff !important;
              color: #111 !important;
            }

            .standalone-transcript-viewer .transcript-content {
              max-width: none;
            }
          }
        `}
      </style>
      <article className="transcript-content">
        {loadState.status === "loading" && (
          <p>Loading transcript...</p>
        )}
        {loadState.status === "error" && (
          <p>
            {loadState.message}
          </p>
        )}
        {loadState.status === "loaded" && (
          <pre className="font-mono text-sm leading-6 text-inherit">{loadState.markdown}</pre>
        )}
      </article>
    </main>
  );
}
