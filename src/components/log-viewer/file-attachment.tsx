import { useEffect, useRef, useState } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import { getMessageAttachmentExtension, type TranscriptAttachment } from "@/shared";
import { appSaveResource } from "../../lib/public-path";

export function FileAttachment({ attachment }: { attachment: TranscriptAttachment }) {
  const urlRef = useRef<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const [downloading, setDownloading] = useState(false);
  const { error: notifyError } = useToast();
  const data = "data" in attachment ? attachment.data : undefined;
  const resourceUrl = "resourceUrl" in attachment ? attachment.resourceUrl : undefined;

  useEffect(() => {
    setDownloading(false);
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [attachment.id, data, resourceUrl]);

  async function download(): Promise<void> {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setDownloading(true);
    try {
      if ("resourceUrl" in attachment) {
        await appSaveResource(attachment.resourceUrl, {
          suggestedName: attachment.filename,
          signal: controller.signal,
        });
        return;
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const bytes = Uint8Array.from(atob(attachment.data), (character) => character.charCodeAt(0));
      if (bytes.byteLength !== attachment.size) throw new Error("The saved attachment is incomplete.");
      urlRef.current = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const anchor = document.createElement("a");
      anchor.href = urlRef.current;
      anchor.download = attachment.filename;
      anchor.click();
    } catch (error) {
      if (!controller.signal.aborted) notifyError(`Could not download attachment: ${String(error)}`);
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setDownloading(false);
      }
    }
  }

  return (
    <button
      type="button"
      onClick={() => void download()}
      disabled={downloading}
      aria-busy={downloading}
      className="flex max-w-56 min-w-0 items-center gap-2 rounded-xl border border-gray-200 bg-white/80 px-3 py-2 text-left hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:border-white/10 dark:bg-black/20 dark:hover:border-white/20"
      title={`Download ${attachment.filename}`}
      aria-label={`Download ${attachment.filename}`}
    >
      <span
        aria-hidden="true"
        className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-gray-200 text-[10px] font-semibold text-gray-600 dark:bg-neutral-700 dark:text-gray-300"
      >
        {getMessageAttachmentExtension(attachment.filename).replace(".", "").toUpperCase().slice(0, 8) || "FILE"}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs text-gray-700 dark:text-gray-200">{attachment.filename}</span>
        <span className="block text-[11px] text-gray-500 dark:text-gray-400">
          {attachment.size === 0 ? "0 bytes" : `${Math.max(1, Math.round(attachment.size / 1024))} KB`}
        </span>
      </span>
    </button>
  );
}
