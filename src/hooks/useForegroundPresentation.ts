/**
 * Retains one displayed snapshot while live data continues updating elsewhere.
 */

import { useState } from "react";
import { useDocumentVisibility } from "./useDocumentVisibility";

export function useForegroundPresentation<T>(value: T): T {
  const visible = useDocumentVisibility();
  const [presentation, setPresentation] = useState(() => ({ value }));

  // Synchronize this component's snapshot before committing a foreground render.
  if (visible && !Object.is(presentation.value, value)) {
    setPresentation({ value });
  }

  return visible ? value : presentation.value;
}
