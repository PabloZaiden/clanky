/**
 * Structured realtime reference dimensions, without resource ownership lookups.
 */

import type { RealtimeTarget } from "@pablozaiden/webapp/contracts";
import { WORKSPACE_REALTIME_RESOURCE_KINDS } from "./realtime";

export function workspaceEventReferenceFields(target: Readonly<RealtimeTarget>): Record<string, string> {
  const fields: Record<string, string> = {
    workspaceId: "workspace", taskId: "task", chatId: "chat", subagentId: "subagent",
    automationId: "automation", automationRunId: "automation-run", terminalSessionId: "terminal", previewId: "preview",
  };
  if (target.resource && WORKSPACE_REALTIME_RESOURCE_KINDS[target.resource]) {
    fields["id"] = WORKSPACE_REALTIME_RESOURCE_KINDS[target.resource]!;
    if (target.resource === "automation-runs") fields["scope"] = "automation";
    else if (target.resource === "previews") fields["scope"] = "workspace";
  }
  return fields;
}
