import { useState } from "react";
import { useLiveQuery } from "@pablozaiden/webapp/web";
import type { WorkspaceSshKeyAccess } from "@/shared/ssh-key-access";
import { apiRequest } from "../lib/api-client";

export function useWorkspaceSshKeyAccess(workspaceId: string, enabled = true) {
  const [saving, setSaving] = useState(false);
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/ssh-key-access`;
  const query = useLiveQuery<WorkspaceSshKeyAccess>({
    enabled,
    deps: [workspaceId],
    load: (signal) => apiRequest(path, { signal, action: "Load workspace SSH keys", fallbackMessage: "Failed to load workspace SSH keys" }),
    realtime: { resources: ["ssh-key-access"], enabled },
  });
  return {
    ...query,
    saving,
    async setGrant(keyId: string, granted: boolean) {
      setSaving(true);
      try {
        await query.mutate((signal) => apiRequest<WorkspaceSshKeyAccess>(`${path}/${encodeURIComponent(keyId)}`, {
          signal, method: "PUT", body: JSON.stringify({ enabled: granted }), headers: { "Content-Type": "application/json" },
          action: "Update workspace SSH-key access", fallbackMessage: "Failed to update workspace SSH-key access",
        }), (_previous, result) => result);
      } finally { setSaving(false); }
    },
  };
}
