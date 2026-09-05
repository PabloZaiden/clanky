/**
 * Hook for managing log-tab display preferences in TaskDetails.
 * Returns values with the `onChange` naming convention expected by LogTab.
 */

import { useState } from "react";

export interface LogDisplayState {
  showSystemInfo: boolean;
  onShowSystemInfoChange: (v: boolean) => void;
  showTools: boolean;
  onShowToolsChange: (v: boolean) => void;
}

export function useLogDisplayState(): LogDisplayState {
  const [showSystemInfo, setShowSystemInfo] = useState(false);
  const [showTools, setShowTools] = useState(true);

  return {
    showSystemInfo,
    onShowSystemInfoChange: setShowSystemInfo,
    showTools,
    onShowToolsChange: setShowTools,
  };
}
