import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { appFetch } from "../lib/public-path";

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
  const [rawMode, setRawMode] = useState(false);
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
            .transcript-mode-toggle {
              display: none;
            }
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
      <label
        className="transcript-mode-toggle"
        style={{
          position: "fixed",
          top: "1rem",
          right: "1rem",
          display: "flex",
          gap: "0.5rem",
          alignItems: "center",
          padding: "0.35rem 0.5rem",
          background: "#fff",
          border: "1px solid #ccc",
          borderRadius: "0.375rem",
          fontSize: "0.875rem",
        }}
      >
        <input
          type="checkbox"
          checked={rawMode}
          onChange={(event) => setRawMode(event.target.checked)}
        />
        Raw
      </label>

      <article className="transcript-content">
        {loadState.status === "loading" && (
          <p>Loading transcript...</p>
        )}
        {loadState.status === "error" && (
          <p>
            {loadState.message}
          </p>
        )}
        {loadState.status === "loaded" && rawMode && (
          <pre>{loadState.markdown}</pre>
        )}
        {loadState.status === "loaded" && !rawMode && (
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {loadState.markdown}
          </Markdown>
        )}
      </article>
    </main>
  );
}
