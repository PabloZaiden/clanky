import { memo, useEffect, useState } from "react";
import { Button, ErrorState } from "@pablozaiden/webapp/web";
import type { MessageAttachment, ToolCallData, ToolCallDisplayData } from "@/shared";
import { hasToolCallImagePreview, isToolCallDetailsStale, isToolCallSummary } from "@/shared/tool-call";
import { ImageViewerModal } from "../ImageViewerModal";
import { ToolEntry } from "./tool-entry";
import type { ConversationViewerProps } from "./types";
import { formatTime } from "./utils";

interface ToolImageEntryProps {
  data: ToolCallDisplayData;
  timestamp: string;
  showTimestamp: boolean;
  spacingClass: string;
  toolPathDisplayRoot?: string;
  onLoadToolDetails: ConversationViewerProps["onLoadToolDetails"];
}

export const ToolImageEntry = memo(function ToolImageEntry({
  data: tool,
  timestamp,
  showTimestamp,
  spacingClass,
  toolPathDisplayRoot,
  onLoadToolDetails,
}: ToolImageEntryProps) {
  const [details, setDetails] = useState<ToolCallData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [selectedImage, setSelectedImage] = useState<MessageAttachment | null>(null);
  const isSummary = isToolCallSummary(tool);
  const activeTool = !isSummary ? tool
    : details?.id === tool.id && !isToolCallDetailsStale(tool, details) ? details : null;

  useEffect(() => {
    if (!isToolCallSummary(tool)) {
      return;
    }
    const controller = new AbortController();
    setError(null);
    void (async () => {
      try {
        if (!onLoadToolDetails) {
          throw new Error("Tool image details are unavailable.");
        }
        const loaded = await onLoadToolDetails(tool.id, controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        if (!loaded) {
          throw new Error("The image tool call was not found.");
        }
        setDetails(loaded);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(String(loadError));
        }
      }
    })();
    return () => controller.abort();
  }, [onLoadToolDetails, retry, tool]);

  if (activeTool && !hasToolCallImagePreview(activeTool)) {
    return (
      <ToolEntry
        data={activeTool}
        timestamp={timestamp}
        showTimestamp={showTimestamp}
        spacingClass={spacingClass}
        toolPathDisplayRoot={toolPathDisplayRoot}
        onLoadToolDetails={onLoadToolDetails}
      />
    );
  }

  return (
    <div className={`group ${spacingClass}`.trim()} data-entry-type="tool-image" data-message-role="assistant">
      {showTimestamp && (
        <time className="mb-1 block text-[11px] text-gray-500" dateTime={timestamp}>
          {formatTime(timestamp)}
        </time>
      )}
      <div className="min-w-0 w-full space-y-3">
        {activeTool?.extras?.filter((extra) => extra.type === "image_preview" && extra.image.data.length > 0).map((extra) => (
          <figure key={`${extra.id}-${retry}`} className="w-fit max-w-full space-y-2">
            <button
              type="button"
              onClick={() => setSelectedImage(extra.image)}
              className="block max-w-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:focus-visible:ring-gray-500"
              aria-label={`View ${extra.image.filename}`}
            >
              <img
                src={`data:${extra.image.mimeType};base64,${extra.image.data}`}
                alt={extra.image.filename}
                className="max-h-80 w-auto max-w-full rounded-lg object-contain"
                onError={() => setError(`Could not display ${extra.image.filename}.`)}
              />
            </button>
            <figcaption className="break-words text-lg leading-7 text-gray-600 dark:text-gray-300">
              {extra.image.filename}
            </figcaption>
          </figure>
        ))}
        {error ? (
          <div className="space-y-2">
            <ErrorState title="Could not load image preview" description={error} />
            <Button type="button" onClick={() => {
              setError(null);
              setRetry((current) => current + 1);
            }}>Retry</Button>
          </div>
        ) : !activeTool && (
          <div className="text-base text-gray-500 dark:text-gray-400" role="status">Loading image preview...</div>
        )}
      </div>
      <ImageViewerModal
        image={selectedImage ? {
          src: `data:${selectedImage.mimeType};base64,${selectedImage.data}`,
          alt: selectedImage.filename,
          title: selectedImage.filename,
          mimeType: selectedImage.mimeType,
          description: `${Math.max(1, Math.round(selectedImage.size / 1024))} KB`,
        } : null}
        onClose={() => setSelectedImage(null)}
      />
    </div>
  );
});
