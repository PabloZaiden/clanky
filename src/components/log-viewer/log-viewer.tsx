/**
 * Loop-focused wrapper around the shared conversation viewer.
 *
 * Loops continue to hide assistant messages because their content is surfaced
 * through streaming response log entries.
 */

import { memo } from "react";
import type { LogViewerProps } from "./types";
import { ConversationViewer } from "./conversation-viewer";

export const LogViewer = memo(function LogViewer(props: LogViewerProps) {
  return (
    <ConversationViewer
      {...props}
      showAssistantMessages={false}
      showResponseLogs={true}
      showMessageRoles={false}
      emptyStateMessage="No logs yet. Waiting for activity."
      activeStateMessage="Working..."
    />
  );
});
