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
    const root = document.getElementById("root");
    const targets = [
      document.documentElement,
      document.body,
      root,
    ].filter((target): target is HTMLElement => target !== null);
    const previousStyles = targets.map((target) => ({
      target,
      height: target.style.height,
      overflow: target.style.overflow,
      overscrollBehavior: target.style.overscrollBehavior,
      background: target.style.background,
    }));

    for (const target of targets) {
      target.style.height = "auto";
      target.style.overflow = "visible";
      target.style.overscrollBehavior = "auto";
      target.style.background = "#fff";
    }

    return () => {
      for (const previous of previousStyles) {
        previous.target.style.height = previous.height;
        previous.target.style.overflow = previous.overflow;
        previous.target.style.overscrollBehavior = previous.overscrollBehavior;
        previous.target.style.background = previous.background;
      }
    };
  }, []);

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
      className="standalone-transcript-viewer"
      style={{ padding: "2rem", color: "#111", background: "#fff", fontFamily: "system-ui, sans-serif" }}
    >
      <style>
        {`
          @media print {
            .standalone-transcript-viewer {
              padding: 0 !important;
            }
          }
          .transcript-content {
            overflow-wrap: anywhere;
          }
          .transcript-content pre {
            white-space: pre-wrap;
            overflow-wrap: anywhere;
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
          <pre>{loadState.markdown}</pre>
        )}
      </article>
    </main>
  );
}
