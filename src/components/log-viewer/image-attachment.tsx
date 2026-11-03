import { useEffect, useMemo, useState } from "react";
import { Button, ErrorState, useWebAppRuntime, type WebAppResourceUrl } from "@pablozaiden/webapp/web";
import type { TranscriptAttachment } from "@/shared";
import { appResourceUrl } from "../../lib/public-path";
import { ImageViewerModal } from "../ImageViewerModal";
import { useViewportVisibility } from "./use-viewport-visibility";

export function ImageAttachment({ attachment }: { attachment: TranscriptAttachment }) {
  const { ref, visible } = useViewportVisibility<HTMLDivElement>();
  const runtime = useWebAppRuntime();
  const isReference = "resourceUrl" in attachment;
  const src = isReference
    ? attachment.resourceUrl : `data:${attachment.mimeType};base64,${attachment.data}`;
  const identity = useMemo(() => ({
    src, isReference, scope: runtime.scope, generation: runtime.generation,
    ready: runtime.ready, error: runtime.error,
  }), [src, isReference, runtime.scope, runtime.generation, runtime.ready, runtime.error]);
  const [requested, setRequested] = useState<typeof identity | null>(null);
  const [resource, setResource] = useState<{ identity: typeof identity; retry: number; url: string } | null>(null);
  const [error, setError] = useState<{ identity: typeof identity; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState(false);
  const current = resource?.identity === identity && resource.retry === retry ? resource : null;
  const currentError = error?.identity === identity ? error.message : null;

  useEffect(() => {
    if (visible) setRequested(identity);
  }, [identity, visible]);

  useEffect(() => {
    if (requested !== identity || !identity.ready || identity.error) return;
    const controller = new AbortController();
    let loaded: Pick<WebAppResourceUrl, "url" | "dispose"> | undefined;
    setError(null);
    void (async () => {
      try {
        loaded = identity.isReference
          ? await appResourceUrl(identity.src, "resource", { signal: controller.signal })
          : { url: identity.src };
        if (controller.signal.aborted) {
          loaded.dispose?.();
          return;
        }
        setResource({ identity, retry, url: loaded.url });
      } catch (loadError) {
        if (!controller.signal.aborted) setError({ identity, message: String(loadError) });
      }
    })();
    return () => {
      controller.abort();
      loaded?.dispose?.();
    };
  }, [identity, requested, retry]);

  return (
    <div ref={ref} className="max-w-full" data-image-attachment={attachment.id}>
      {currentError ? (
        <div className="space-y-2">
          <ErrorState title="Could not load image" description={currentError} />
          <Button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</Button>
        </div>
      ) : (
        <button
          type="button"
          disabled={!current}
          onClick={() => setSelected(true)}
          className="rounded-xl border border-gray-200 bg-white/80 p-1 text-left hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:border-white/10 dark:bg-black/20 dark:hover:border-white/20"
          aria-label={`View ${attachment.filename}`}
        >
          {current ? (
            <img
              src={current.url}
              alt={attachment.filename}
              className="h-20 w-20 rounded-lg object-cover"
              onError={() => setError({ identity, message: `Could not display ${attachment.filename}.` })}
            />
          ) : (
            <span className="flex h-20 w-20 items-center justify-center rounded-lg bg-gray-100 text-xs text-gray-500 dark:bg-neutral-800 dark:text-gray-400">
              Image
            </span>
          )}
        </button>
      )}
      <ImageViewerModal
        image={selected && current ? {
          src: current.url,
          alt: attachment.filename,
          title: attachment.filename,
          mimeType: attachment.mimeType,
          description: `${Math.max(1, Math.round(attachment.size / 1024))} KB`,
        } : null}
        onClose={() => setSelected(false)}
      />
    </div>
  );
}
