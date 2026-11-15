import { useLiveQuery } from "@pablozaiden/webapp/web";
import type { SshKeySource, SshPublicKey } from "@/shared/ssh-key-access";
import { apiRequest } from "../lib/api-client";

export function useSshKeyInventory() {
  return useLiveQuery<{ sources: SshKeySource[]; keys: SshPublicKey[] }>({
    load: (signal) => apiRequest("/api/ssh-key-access", {
      signal, action: "Load SSH-key sources", fallbackMessage: "Failed to load SSH-key sources",
    }),
    realtime: { resources: ["ssh-key-access"] },
  });
}
