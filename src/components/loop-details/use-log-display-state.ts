/**
 * Hook for managing log-tab display preferences in LoopDetails.
 * Returns values with the `onChange` naming convention expected by LogTab.
 */

import { useState } from "react";

export interface LogDisplayState {
  showSystemInfo: boolean;
  onShowSystemInfoChange: (v: boolean) => void;
  showReasoning: boolean;
  onShowReasoningChange: (v: boolean) => void;
  showTools: boolean;
  onShowToolsChange: (v: boolean) => void;
  autoScroll: boolean;
  onAutoScrollChange: (v: boolean) => void;
}

export function useLogDisplayState(): LogDisplayState {
  const [showSystemInfo, setShowSystemInfo] = useState(false);
  const [showReasoning, setShowReasoning] = useState(true);
  const [showTools, setShowTools] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);

  return {
    showSystemInfo,
    onShowSystemInfoChange: setShowSystemInfo,
    showReasoning,
    onShowReasoningChange: setShowReasoning,
    showTools,
    onShowToolsChange: setShowTools,
    autoScroll,
    onAutoScrollChange: setAutoScroll,
  };
}
