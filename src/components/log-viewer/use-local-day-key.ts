import { useEffect, useState } from "react";
import { useDocumentVisibility } from "../../hooks/useDocumentVisibility";
import { getLocalDateKey } from "./utils";

export function useLocalDayKey(): number {
  const visible = useDocumentVisibility();
  const [localDayKey, setLocalDayKey] = useState(() => getLocalDateKey(new Date()));

  useEffect(() => {
    if (!visible) {
      return;
    }

    const refreshLocalDay = () => setLocalDayKey(getLocalDateKey(new Date()));
    refreshLocalDay();

    const now = new Date();
    const nextLocalMidnight = new Date(now);
    nextLocalMidnight.setHours(24, 0, 0, 0);
    const timeout = window.setTimeout(
      refreshLocalDay,
      Math.max(1, nextLocalMidnight.getTime() - Date.now()),
    );

    return () => window.clearTimeout(timeout);
  }, [localDayKey, visible]);

  return localDayKey;
}
