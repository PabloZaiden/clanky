import { useEffect, useState } from "react";
import {
  nativePreviewListSchema,
  type NativePreview,
} from "../platform/web/native-previews";

export function useNativePreviews() {
  const [previews, setPreviews] = useState<NativePreview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bridge = window.clankyPreviews;

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const accept = (value: unknown) => {
      if (!active) return;
      try {
        setPreviews(nativePreviewListSchema.parse(value));
        setError(null);
      } catch (error) {
        setError(`Unable to read local preview state: ${String(error)}`);
      }
    };
    const refresh = () => {
      void bridge.postMessage({ type: "list" }).then(accept, error => {
        if (active) setError(`Unable to read local previews: ${String(error)}`);
      });
    };
    const changed = (event: Event) => {
      if (event instanceof CustomEvent) accept(event.detail);
    };
    const foreground = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("clanky-previews-changed", changed);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", foreground);
    refresh();
    return () => {
      active = false;
      window.removeEventListener("clanky-previews-changed", changed);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [bridge]);

  return { previews, error, platform: bridge?.platform };
}
