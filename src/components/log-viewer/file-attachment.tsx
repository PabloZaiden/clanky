import { useEffect, useRef } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import { getMessageAttachmentExtension, type MessageAttachment } from "@/shared/message-attachments";

export function FileAttachment({ attachment }: { attachment: MessageAttachment }) {
  const urlRef = useRef<string | null>(null);
  const toast = useToast();

  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, [attachment.data]);

  function download(): void {
    try {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const bytes = Uint8Array.from(atob(attachment.data), (character) => character.charCodeAt(0));
      if (bytes.byteLength !== attachment.size) throw new Error("The saved attachment is incomplete.");
      urlRef.current = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const anchor = document.createElement("a");
      anchor.href = urlRef.current;
      anchor.download = attachment.filename;
      anchor.click();
    } catch (error) {
      toast.error(`Could not download attachment: ${String(error)}`);
    }
  }

  return (
    <button
      type="button"
      onClick={download}
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
