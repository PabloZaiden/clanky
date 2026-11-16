import { useState } from "react";
import { useLiveQuery } from "@pablozaiden/webapp/web";
import type { WorkspaceSshKeyAccess } from "@/shared/ssh-key-access";
import { apiRequest } from "../lib/api-client";

export function useSshKeyAccess(path: string, enabled = true) {
  const [saving, setSaving] = useState(false);
  const query = useLiveQuery<WorkspaceSshKeyAccess>({
    enabled,
    deps: [path],
    load: (signal) => apiRequest(path, { signal, action: "Load shared SSH keys", fallbackMessage: "Failed to load shared SSH keys" }),
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
          action: "Update shared SSH-key access", fallbackMessage: "Failed to update shared SSH-key access",
        }), (_previous, result) => result);
      } finally { setSaving(false); }
    },
  };
}
